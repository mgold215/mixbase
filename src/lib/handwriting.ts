// Handwriting lettering — lifts the artist's own handwriting off a phone photo
// so it can be laid over cover art as the title lockup.
//
// The input is whatever the artist snapped: marker on paper, pen on a napkin,
// chalk on a wall. The output is a tight-cropped PNG of the ink alone — white
// RGB with the ink strength in the alpha channel — so the compositor can tint
// it any colour (white over a dark photo, black over a light one) and the
// marker's own texture, thick/thin strokes and ragged edges survive. Nothing
// here re-draws a letter: every visible pixel is the artist's stroke, which is
// the point. The one liberty taken is REPAIR — a glare spot or a dry patch
// that punched a hole through a stroke is closed, and a stroke that thinned
// out below the threshold for a few pixels is reconnected — because a
// marker line with holes in it reads as a scan error, not as handwriting.
//
// Pure image maths over raw pixels plus sharp. No server-only imports —
// scripts/cassette-studio-test.mjs drives it directly under Node.
//
// Pipeline:
//   1. Paper estimate — the photo's lighting is never even (phone shadow,
//      window light), so a single paper colour fails. The page is cut into a
//      grid and each cell's paper colour is the mean of its brighter pixels;
//      ink is thin, so it rarely dominates a cell. When it DOES (a fat marker
//      letter filling a cell — the cause of holes in the thick parts of
//      letters) the cell's estimate comes out ink-dark; that is caught by
//      comparing it with the 3×3 cells around it and, when the cell still
//      holds bright paper pixels, re-estimating from those alone. The grid
//      is bilinearly interpolated back up into a smooth per-pixel paper map.
//   2. Ink strength — distance of each pixel from its local paper colour
//      (RGB, weighted toward darkening), so blue/black/red ink all register
//      and shading on the paper itself mostly does not.
//   3. Hysteresis threshold — Otsu on the strength histogram picks the
//      ink/paper split; everything above HALF of it that touches something
//      above it is ink too (the way a stroke's thin tail is still part of the
//      stroke), so a line never breaks where the pen pressed lightly.
//   4. Dust removal — connected components of the ink mask, judged against
//      the stroke width measured from the ink itself: the writing is the
//      blobs at least a couple of stroke-widths square; an i-dot or a full
//      stop is about one stroke-width square and sits inside the writing's
//      box; specks on the paper are far smaller or far away.
//   5. Repair — a morphological closing of a quarter stroke-width bridges
//      hairline breaks, and enclosed holes smaller than a stroke-width (glare)
//      are filled. A letter's counter (the hole in an o) is larger than that
//      and stays open.
//   6. Crop to the surviving ink + padding.

import sharp from 'sharp'

export type Lettering = {
  /** PNG: white RGB, alpha = ink strength. Tight crop around the writing. */
  png: Buffer
  width: number
  height: number
  /** Typical stroke width in output pixels — what the pen laid down. */
  strokeWidth: number
}

/** Longest edge the lettering is processed at. Plenty for a 3000px cover. */
const WORK_EDGE = 2000
const GRID = 24

export async function extractHandwriting(photo: Buffer): Promise<Lettering> {
  const { data, info } = await sharp(photo)
    .rotate()
    .resize({ width: WORK_EDGE, height: WORK_EDGE, fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const { width: W, height: H } = info
  const strength = inkStrength(data, W, H)
  const { mask, strokeWidth, tLo, tHi } = inkMask(strength, W, H)
  const alpha = softAlpha(strength, mask, W, H, tLo, tHi)
  return cropLettering(alpha, W, H, strokeWidth)
}

// ── 1 + 2. Paper map → ink strength ─────────────────────────────────────────

/** Per-pixel ink strength (0..255+) of an RGB photo: distance from the local paper colour. */
export function inkStrength(data: Buffer | Uint8Array, W: number, H: number): Float32Array {
  const N = W * H
  const gx = Math.max(2, Math.round(GRID * (W / Math.max(W, H))))
  const gy = Math.max(2, Math.round(GRID * (H / Math.max(W, H))))
  const cellR = new Float32Array(gx * gy)
  const cellG = new Float32Array(gx * gy)
  const cellB = new Float32Array(gx * gy)
  const cellLum = new Float32Array(gx * gy)
  const cellBright = new Float32Array(gx * gy)
  const bounds = (cx: number, cy: number) => ({
    x0: Math.floor((cx * W) / gx), x1: Math.floor(((cx + 1) * W) / gx),
    y0: Math.floor((cy * H) / gy), y1: Math.floor(((cy + 1) * H) / gy),
  })
  const lumAt = (i: number) => (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000

  // Paper = the mean of the pixels between the 70th and 92nd brightness
  // percentile of the cell: above any ink, below specular glare.
  const estimate = (x0: number, x1: number, y0: number, y1: number, lo: number, hi: number) => {
    let r = 0, g = 0, b = 0, n = 0
    for (let y = y0; y < y1; y += 2) {
      for (let x = x0; x < x1; x += 2) {
        const i = (y * W + x) * 3
        const l = lumAt(i)
        if (l >= lo && l <= hi) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++ }
      }
    }
    return n ? [r / n, g / n, b / n] : [255, 255, 255]
  }
  const lumsOf = (x0: number, x1: number, y0: number, y1: number) => {
    const lum: number[] = []
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) lum.push(lumAt((y * W + x) * 3))
    lum.sort((a, b) => a - b)
    return lum
  }
  for (let cy = 0; cy < gy; cy++) {
    for (let cx = 0; cx < gx; cx++) {
      const { x0, x1, y0, y1 } = bounds(cx, cy)
      const lum = lumsOf(x0, x1, y0, y1)
      const lo = lum[Math.floor(lum.length * 0.7)] ?? 0
      const hi = lum[Math.floor(lum.length * 0.92)] ?? 255
      const [r, g, b] = estimate(x0, x1, y0, y1, lo, hi)
      const k = cy * gx + cx
      cellR[k] = r; cellG[k] = g; cellB[k] = b
      cellLum[k] = (r * 299 + g * 587 + b * 114) / 1000
      cellBright[k] = lum[Math.min(lum.length - 1, Math.floor(lum.length * 0.98))] ?? 255
    }
  }

  // A cell drowned in ink: its "paper" is much darker than the paper of the
  // cells around it. If it still holds bright pixels (so it is not simply a
  // cell in shadow, whose pixels are ALL dark) it is re-estimated from its
  // own brightest pixels — the paper peeking between the strokes. A cell with
  // no bright pixel at all that is under HALF as bright as its neighbours is
  // the inside of a fat letter (a shadow that deep is not a photo of paper)
  // and takes the neighbours' paper. Two passes, so a 3×3 block of such cells
  // (a really fat marker) resolves from its rim inward.
  const fixedR = Float32Array.from(cellR), fixedG = Float32Array.from(cellG), fixedB = Float32Array.from(cellB)
  const fixedLum = Float32Array.from(cellLum)
  for (let pass = 0; pass < 2; pass++) {
    for (let cy = 0; cy < gy; cy++) {
      for (let cx = 0; cx < gx; cx++) {
        let around = 0, ar = 0, ag = 0, ab = 0, n = 0
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx, ny = cy + dy
            if (nx < 0 || ny < 0 || nx >= gx || ny >= gy || (dx === 0 && dy === 0)) continue
            const j = ny * gx + nx
            around += fixedLum[j]; ar += fixedR[j]; ag += fixedG[j]; ab += fixedB[j]; n++
          }
        }
        if (!n) continue
        around /= n
        const k = cy * gx + cx
        if (fixedLum[k] >= around * 0.82) continue
        if (cellBright[k] >= around * 0.9) {
          const { x0, x1, y0, y1 } = bounds(cx, cy)
          const [r, g, b] = estimate(x0, x1, y0, y1, cellBright[k] * 0.92, 255)
          fixedR[k] = r; fixedG[k] = g; fixedB[k] = b
        } else if (fixedLum[k] < around * 0.5) {
          fixedR[k] = ar / n; fixedG[k] = ag / n; fixedB[k] = ab / n
        } else {
          continue
        }
        fixedLum[k] = (fixedR[k] * 299 + fixedG[k] * 587 + fixedB[k] * 114) / 1000
      }
    }
  }

  const strength = new Float32Array(N)
  for (let y = 0; y < H; y++) {
    const fy = Math.min(gy - 1, Math.max(0, (y + 0.5) * gy / H - 0.5))
    const y0 = Math.floor(fy), y1 = Math.min(gy - 1, y0 + 1), ty = fy - y0
    for (let x = 0; x < W; x++) {
      const fx = Math.min(gx - 1, Math.max(0, (x + 0.5) * gx / W - 0.5))
      const x0 = Math.floor(fx), x1 = Math.min(gx - 1, x0 + 1), tx = fx - x0
      const a = y0 * gx + x0, b = y0 * gx + x1, c = y1 * gx + x0, d = y1 * gx + x1
      const pr = lerp(lerp(fixedR[a], fixedR[b], tx), lerp(fixedR[c], fixedR[d], tx), ty)
      const pg = lerp(lerp(fixedG[a], fixedG[b], tx), lerp(fixedG[c], fixedG[d], tx), ty)
      const pb = lerp(lerp(fixedB[a], fixedB[b], tx), lerp(fixedB[c], fixedB[d], tx), ty)
      const i = (y * W + x) * 3
      const dr = pr - data[i], dg = pg - data[i + 1], db = pb - data[i + 2]
      // Ink is what is DARKER than the paper around it; a colour shift at the
      // same brightness counts some (coloured ink on coloured paper), and a
      // pixel brighter than its paper (glare, white-out, a paper estimate
      // that ran a little dark next to a fat letter) counts hardly at all.
      const dLum = (dr * 299 + dg * 587 + db * 114) / 1000
      const chroma = Math.sqrt(dr * dr + dg * dg + db * db)
      strength[y * W + x] = dLum > 0 ? Math.max(dLum, chroma * 0.75) : chroma * 0.15
    }
  }
  return strength
}

// ── 3 + 4 + 5. Threshold, dust, repair ──────────────────────────────────────

/**
 * The binary ink mask of a strength field, with the stroke width it measured
 * and the soft-ramp thresholds for the alpha. Throws when there is no ink.
 */
export function inkMask(strength: Float32Array, W: number, H: number): { mask: Uint8Array; strokeWidth: number; tLo: number; tHi: number } {
  const N = W * H
  const hist = new Uint32Array(256)
  for (let i = 0; i < N; i++) hist[Math.min(255, strength[i] | 0)]++
  const t = otsu(hist, N)
  // Ink must clear a floor even on a near-blank page, or paper grain becomes
  // "writing". 18 levels ≈ the faintest pencil that reads at thumbnail size.
  const tHigh = Math.max(18, t)
  const tLow = Math.max(10, t * 0.5)

  // Hysteresis: a component of the LOW mask is ink when any pixel of it is
  // over the high threshold.
  const low = new Uint8Array(N)
  for (let i = 0; i < N; i++) low[i] = strength[i] >= tLow ? 1 : 0
  const lowC = components(low, W, H)
  const lit = new Uint8Array(lowC.areas.length)
  for (let i = 0; i < N; i++) if (lowC.labels[i] && strength[i] >= tHigh) lit[lowC.labels[i] - 1] = 1
  const ink = new Uint8Array(N)
  for (let i = 0; i < N; i++) if (lowC.labels[i] && lit[lowC.labels[i] - 1]) ink[i] = 1

  const { labels, areas, boxes } = components(ink, W, H)
  const count = areas.length
  if (count === 0) throw new Error('No writing found in that photo — try a closer, brighter shot.')

  // Stroke width from the ink itself: twice the median distance-to-edge over
  // the ink pixels is half a stroke, so four times it is the stroke.
  const sw = strokeWidthOf(ink, labels, areas, W, H)
  const sw2 = sw * sw

  // Dust: the writing is the components at least 2.5 stroke-widths square.
  // Smaller marks (an i-dot, a full stop, an apostrophe — about one
  // stroke-width square) count when they sit inside the writing's own box;
  // anything under a fifth of a stroke-width square is a speck, wherever it is.
  let maxArea = 0
  for (let k = 0; k < count; k++) maxArea = Math.max(maxArea, areas[k])
  const coreMin = Math.min(2.5 * sw2, maxArea)
  let bx0 = W, by0 = H, bx1 = -1, by1 = -1
  for (let k = 0; k < count; k++) {
    if (areas[k] < coreMin) continue
    const b = boxes[k]
    bx0 = Math.min(bx0, b[0]); by0 = Math.min(by0, b[1]); bx1 = Math.max(bx1, b[2]); by1 = Math.max(by1, b[3])
  }
  const margin = Math.round((by1 - by0) * 0.5 + 2 * sw)
  const keep = new Uint8Array(count)
  for (let k = 0; k < count; k++) {
    if (areas[k] >= coreMin) { keep[k] = 1; continue }
    if (areas[k] < 0.2 * sw2) continue
    const b = boxes[k]
    const inside = b[0] >= bx0 - margin && b[2] <= bx1 + margin && b[1] >= by0 - margin && b[3] <= by1 + margin
    if (inside) keep[k] = 1
  }
  const kept = new Uint8Array(N)
  for (let i = 0; i < N; i++) if (labels[i] > 0 && keep[labels[i] - 1]) kept[i] = 1

  // Repair: close hairline breaks (a quarter stroke-width each way), then fill
  // the holes glare punched through strokes — enclosed gaps under a
  // stroke-width across. A counter (the hole in an o, an e, an a) is wider
  // than the stroke that draws it and is left open.
  const rc = Math.max(1, Math.min(12, Math.round(sw * 0.25)))
  const closed = erode(dilate(kept, W, H, rc), W, H, rc)
  const mask = fillSmallHoles(closed, W, H, 0.7 * sw2, 1.2 * sw)
  return { mask, strokeWidth: sw, tLo: tLow, tHi: Math.max(tLow + 8, t * 1.25) }
}

/** Typical stroke width of an ink mask, in pixels (3..160). */
function strokeWidthOf(ink: Uint8Array, labels: Int32Array, areas: number[], W: number, H: number): number {
  const dist = chamfer(ink, W, H)
  // Median over the pixels of components big enough to be strokes (≥ 9 px),
  // so a dusting of specks cannot drag it toward one pixel.
  const hist = new Uint32Array(512)
  let n = 0
  for (let i = 0; i < W * H; i++) {
    if (!ink[i] || areas[labels[i] - 1] < 9) continue
    hist[Math.min(511, Math.round(dist[i] * 2))]++
    n++
  }
  if (!n) return 3
  let acc = 0, med = 0
  for (let v = 0; v < 512; v++) { acc += hist[v]; if (acc * 2 >= n) { med = v / 2; break } }
  return Math.max(3, Math.min(160, med * 4))
}

/** Distance (px) from each ink pixel to the nearest non-ink pixel. Two-pass chamfer (3,4)/3. */
function chamfer(ink: Uint8Array, W: number, H: number): Float32Array {
  const big = 1e9
  const d = new Float32Array(W * H)
  for (let i = 0; i < W * H; i++) d[i] = ink[i] ? big : 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (!ink[i]) continue
      let v = d[i]
      if (x > 0) v = Math.min(v, d[i - 1] + 1)
      if (y > 0) {
        v = Math.min(v, d[i - W] + 1)
        if (x > 0) v = Math.min(v, d[i - W - 1] + 1.3333)
        if (x < W - 1) v = Math.min(v, d[i - W + 1] + 1.3333)
      }
      // Border pixels: the outside counts as paper.
      if (x === 0 || y === 0) v = Math.min(v, 1)
      d[i] = v
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x
      if (!ink[i]) continue
      let v = d[i]
      if (x < W - 1) v = Math.min(v, d[i + 1] + 1)
      if (y < H - 1) {
        v = Math.min(v, d[i + W] + 1)
        if (x < W - 1) v = Math.min(v, d[i + W + 1] + 1.3333)
        if (x > 0) v = Math.min(v, d[i + W - 1] + 1.3333)
      }
      if (x === W - 1 || y === H - 1) v = Math.min(v, 1)
      d[i] = v
    }
  }
  return d
}

/** Fill the enclosed background regions of `mask` smaller than `maxArea` and narrower than `maxEdge` on both sides. */
export function fillSmallHoles(mask: Uint8Array, W: number, H: number, maxArea: number, maxEdge: number): Uint8Array {
  const N = W * H
  const bg = new Uint8Array(N)
  for (let i = 0; i < N; i++) bg[i] = mask[i] ? 0 : 1
  const { labels, areas, boxes } = components(bg, W, H)
  const fill = new Uint8Array(areas.length)
  for (let k = 0; k < areas.length; k++) {
    const b = boxes[k]
    const touchesBorder = b[0] === 0 || b[1] === 0 || b[2] === W - 1 || b[3] === H - 1
    if (touchesBorder || areas[k] > maxArea) continue
    if (b[2] - b[0] + 1 > maxEdge || b[3] - b[1] + 1 > maxEdge) continue
    fill[k] = 1
  }
  const out = Uint8Array.from(mask)
  for (let i = 0; i < N; i++) if (labels[i] && fill[labels[i] - 1]) out[i] = 1
  return out
}

// ── Alpha + crop ────────────────────────────────────────────────────────────

/**
 * The ink alpha: the strength ramp (so the marker's own soft edge survives)
 * inside the mask and just outside it, with repaired pixels made solid and
 * their edges softened by a 3×3 average of the mask.
 */
export function softAlpha(strength: Float32Array, mask: Uint8Array, W: number, H: number, tLo: number, tHi: number): Uint8Array {
  const N = W * H
  const near = dilate(mask, W, H, 2)
  const alpha = new Uint8Array(N)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (!near[i]) continue
      const s = strength[i]
      let a = s <= tLo ? 0 : s >= tHi ? 1 : smooth((s - tLo) / (tHi - tLo))
      if (mask[i]) {
        let inside = 0
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy
          if (yy < 0 || yy >= H) continue
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx
            if (xx >= 0 && xx < W && mask[yy * W + xx]) inside++
          }
        }
        a = Math.max(a, Math.min(1, (inside / 9) * 1.15))
      }
      if (a > 0) alpha[i] = Math.round(a * 255)
    }
  }
  return alpha
}

/** Crop an alpha field to its ink (+2% padding) as a white-RGB PNG. Throws when it is empty. */
export async function cropLettering(alpha: Uint8Array, W: number, H: number, strokeWidth: number): Promise<Lettering> {
  let cx0 = W, cy0 = H, cx1 = -1, cy1 = -1
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!alpha[y * W + x]) continue
      if (x < cx0) cx0 = x
      if (x > cx1) cx1 = x
      if (y < cy0) cy0 = y
      if (y > cy1) cy1 = y
    }
  }
  if (cx1 < 0) throw new Error('No writing found in that photo — try a closer, brighter shot.')
  const pad = Math.round(Math.max(cx1 - cx0, cy1 - cy0) * 0.02) + 2
  const left = Math.max(0, cx0 - pad), top = Math.max(0, cy0 - pad)
  const right = Math.min(W - 1, cx1 + pad), bottom = Math.min(H - 1, cy1 + pad)
  const cw = right - left + 1, ch = bottom - top + 1
  const rgba = Buffer.alloc(cw * ch * 4)
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const o = (y * cw + x) * 4
      rgba[o] = 255; rgba[o + 1] = 255; rgba[o + 2] = 255
      rgba[o + 3] = alpha[(y + top) * W + (x + left)]
    }
  }
  const png = await sharp(rgba, { raw: { width: cw, height: ch, channels: 4 } }).png().toBuffer()
  return { png, width: cw, height: ch, strokeWidth }
}

// ── Raster helpers (shared with handwriting-glyphs.ts) ──────────────────────

function lerp(a: number, b: number, t: number) { return a + (b - a) * t }
function smooth(t: number) { return t * t * (3 - 2 * t) }

function otsu(hist: Uint32Array, total: number): number {
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]
  let sumB = 0, wB = 0, best = 0, bestT = 0
  for (let i = 0; i < 256; i++) {
    wB += hist[i]
    if (!wB) continue
    const wF = total - wB
    if (!wF) break
    sumB += i * hist[i]
    const mB = sumB / wB, mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > best) { best = between; bestT = i }
  }
  return bestT
}

export type Components = { labels: Int32Array; areas: number[]; boxes: [number, number, number, number][] }

/** 4-connected component labelling (iterative flood fill). Labels are 1-based. */
export function components(mask: Uint8Array, W: number, H: number): Components {
  const labels = new Int32Array(W * H)
  const areas: number[] = []
  const boxes: [number, number, number, number][] = []
  const stack = new Int32Array(W * H)
  let next = 0
  for (let start = 0; start < W * H; start++) {
    if (!mask[start] || labels[start]) continue
    next++
    let sp = 0, area = 0
    let x0 = W, y0 = H, x1 = -1, y1 = -1
    stack[sp++] = start
    labels[start] = next
    while (sp) {
      const i = stack[--sp]
      area++
      const x = i % W, y = (i - x) / W
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      if (x > 0 && mask[i - 1] && !labels[i - 1]) { labels[i - 1] = next; stack[sp++] = i - 1 }
      if (x < W - 1 && mask[i + 1] && !labels[i + 1]) { labels[i + 1] = next; stack[sp++] = i + 1 }
      if (y > 0 && mask[i - W] && !labels[i - W]) { labels[i - W] = next; stack[sp++] = i - W }
      if (y < H - 1 && mask[i + W] && !labels[i + W]) { labels[i + W] = next; stack[sp++] = i + W }
    }
    areas.push(area)
    boxes.push([x0, y0, x1, y1])
  }
  return { labels, areas, boxes }
}

/** Square dilation by r pixels (separable max). */
export function dilate(mask: Uint8Array, W: number, H: number, r: number): Uint8Array {
  const tmp = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 0
      for (let d = -r; d <= r && !v; d++) {
        const xx = x + d
        if (xx >= 0 && xx < W && mask[y * W + xx]) v = 1
      }
      tmp[y * W + x] = v
    }
  }
  const out = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 0
      for (let d = -r; d <= r && !v; d++) {
        const yy = y + d
        if (yy >= 0 && yy < H && tmp[yy * W + x]) v = 1
      }
      out[y * W + x] = v
    }
  }
  return out
}

/** Square erosion by r pixels (separable min); the outside counts as empty. */
export function erode(mask: Uint8Array, W: number, H: number, r: number): Uint8Array {
  const tmp = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 1
      for (let d = -r; d <= r && v; d++) {
        const xx = x + d
        if (xx < 0 || xx >= W || !mask[y * W + xx]) v = 0
      }
      tmp[y * W + x] = v
    }
  }
  const out = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 1
      for (let d = -r; d <= r && v; d++) {
        const yy = y + d
        if (yy < 0 || yy >= H || !tmp[yy * W + x]) v = 0
      }
      out[y * W + x] = v
    }
  }
  return out
}
