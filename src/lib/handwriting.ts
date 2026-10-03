// Handwriting lettering — lifts the artist's own handwriting off a phone photo
// so it can be laid over cover art as the title lockup.
//
// The input is whatever the artist snapped: marker on paper, pen on a napkin,
// chalk on a wall. The output is a tight-cropped PNG of the ink alone — white
// RGB with the ink strength in the alpha channel — so the compositor can tint
// it any colour (white over a dark photo, black over a light one) and the
// marker's own texture, thick/thin strokes and ragged edges survive. Nothing
// here re-draws or "cleans up" a letter: every visible pixel is the artist's
// stroke, which is the point.
//
// Pure image maths over raw pixels plus sharp. No server-only imports —
// scripts/cassette-studio-test.mjs drives it directly under Node.
//
// Pipeline:
//   1. Paper estimate — the photo's lighting is never even (phone shadow,
//      window light), so a single paper colour fails. The page is cut into a
//      grid and each cell's paper colour is the median of its brightest
//      pixels; ink is thin, so it never dominates a cell. The grid is
//      bilinearly interpolated back up into a smooth per-pixel paper map.
//   2. Ink strength — distance of each pixel from its local paper colour
//      (RGB, weighted toward darkening), so blue/black/red ink all register
//      and shading on the paper itself mostly does not.
//   3. Threshold — Otsu on the strength histogram picks the ink/paper split;
//      a soft ramp around it keeps anti-aliased marker edges.
//   4. Dust removal — connected components of the ink mask. The writing is
//      the big blobs; specks on the paper are tiny and scattered. Small
//      components survive only if they sit inside the writing's own box
//      (an i-dot, a full stop), everything else is dropped.
//   5. Crop to the surviving ink + padding.

import sharp from 'sharp'

export type Lettering = {
  /** PNG: white RGB, alpha = ink strength. Tight crop around the writing. */
  png: Buffer
  width: number
  height: number
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
  const N = W * H

  // ── 1. Paper map ────────────────────────────────────────────────────────
  const gx = Math.max(2, Math.round(GRID * (W / Math.max(W, H))))
  const gy = Math.max(2, Math.round(GRID * (H / Math.max(W, H))))
  const cellR = new Float32Array(gx * gy)
  const cellG = new Float32Array(gx * gy)
  const cellB = new Float32Array(gx * gy)
  for (let cy = 0; cy < gy; cy++) {
    for (let cx = 0; cx < gx; cx++) {
      const x0 = Math.floor((cx * W) / gx), x1 = Math.floor(((cx + 1) * W) / gx)
      const y0 = Math.floor((cy * H) / gy), y1 = Math.floor(((cy + 1) * H) / gy)
      const lum: number[] = []
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const i = (y * W + x) * 3
          lum.push((data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000)
        }
      }
      lum.sort((a, b) => a - b)
      // Paper = pixels between the 60th and 90th brightness percentile: above
      // any ink, below specular glare.
      const lo = lum[Math.floor(lum.length * 0.6)] ?? 0
      const hi = lum[Math.floor(lum.length * 0.9)] ?? 255
      let r = 0, g = 0, b = 0, n = 0
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const i = (y * W + x) * 3
          const l = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000
          if (l >= lo && l <= hi) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++ }
        }
      }
      const k = cy * gx + cx
      cellR[k] = n ? r / n : 255
      cellG[k] = n ? g / n : 255
      cellB[k] = n ? b / n : 255
    }
  }

  // ── 2. Ink strength (bilinear paper per pixel) ───────────────────────────
  const strength = new Float32Array(N)
  for (let y = 0; y < H; y++) {
    const fy = Math.min(gy - 1, Math.max(0, (y + 0.5) * gy / H - 0.5))
    const y0 = Math.floor(fy), y1 = Math.min(gy - 1, y0 + 1), ty = fy - y0
    for (let x = 0; x < W; x++) {
      const fx = Math.min(gx - 1, Math.max(0, (x + 0.5) * gx / W - 0.5))
      const x0 = Math.floor(fx), x1 = Math.min(gx - 1, x0 + 1), tx = fx - x0
      const a = y0 * gx + x0, b = y0 * gx + x1, c = y1 * gx + x0, d = y1 * gx + x1
      const pr = lerp(lerp(cellR[a], cellR[b], tx), lerp(cellR[c], cellR[d], tx), ty)
      const pg = lerp(lerp(cellG[a], cellG[b], tx), lerp(cellG[c], cellG[d], tx), ty)
      const pb = lerp(lerp(cellB[a], cellB[b], tx), lerp(cellB[c], cellB[d], tx), ty)
      const i = (y * W + x) * 3
      const dr = pr - data[i], dg = pg - data[i + 1], db = pb - data[i + 2]
      // Darkening counts fully; lightening (glare, white-out) counts little.
      const dark = Math.max(0, (dr * 299 + dg * 587 + db * 114) / 1000)
      const chroma = Math.sqrt(dr * dr + dg * dg + db * db)
      strength[y * W + x] = Math.max(dark, chroma * 0.75)
    }
  }

  // ── 3. Otsu threshold + soft ramp ───────────────────────────────────────
  const hist = new Uint32Array(256)
  for (let i = 0; i < N; i++) hist[Math.min(255, strength[i] | 0)]++
  const t = otsu(hist, N)
  // Ink must clear a floor even on a near-blank page, or paper grain becomes
  // "writing". 18 levels ≈ the faintest pencil that reads at thumbnail size.
  const tLo = Math.max(10, t * 0.55)
  const tHi = Math.max(tLo + 8, t * 1.25)
  const hard = new Uint8Array(N)
  for (let i = 0; i < N; i++) hard[i] = strength[i] >= Math.max(18, t) ? 1 : 0

  // ── 4. Connected components, dust removal ────────────────────────────────
  const { labels, areas, boxes } = components(hard, W, H)
  const count = areas.length
  if (count === 0) throw new Error('No writing found in that photo — try a closer, brighter shot.')
  let maxArea = 0
  for (let k = 0; k < count; k++) maxArea = Math.max(maxArea, areas[k])
  // "Core" = the writing itself: anything at least 12% the size of the
  // biggest stroke-blob.
  let bx0 = W, by0 = H, bx1 = -1, by1 = -1
  for (let k = 0; k < count; k++) {
    if (areas[k] < maxArea * 0.12) continue
    const b = boxes[k]
    bx0 = Math.min(bx0, b[0]); by0 = Math.min(by0, b[1]); bx1 = Math.max(bx1, b[2]); by1 = Math.max(by1, b[3])
  }
  const marginY = Math.round((by1 - by0) * 0.25)
  const marginX = Math.round((by1 - by0) * 0.25)
  const keep = new Uint8Array(count)
  for (let k = 0; k < count; k++) {
    if (areas[k] >= maxArea * 0.12) { keep[k] = 1; continue }
    const b = boxes[k]
    const inside = b[0] >= bx0 - marginX && b[2] <= bx1 + marginX && b[1] >= by0 - marginY && b[3] <= by1 + marginY
    // An i-dot or full stop is a few % of a letter; dust is far smaller.
    if (inside && areas[k] >= maxArea * 0.004) keep[k] = 1
  }

  // Kept mask, dilated 2px so the soft edge around each stroke survives.
  const kept = new Uint8Array(N)
  for (let i = 0; i < N; i++) if (labels[i] > 0 && keep[labels[i] - 1]) kept[i] = 1
  const near = dilate(kept, W, H, 2)

  let cx0 = W, cy0 = H, cx1 = -1, cy1 = -1
  const alpha = new Uint8Array(N)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (!near[i]) continue
      const s = strength[i]
      const a = s <= tLo ? 0 : s >= tHi ? 1 : smooth((s - tLo) / (tHi - tLo))
      if (a <= 0) continue
      alpha[i] = Math.round(a * 255)
      if (x < cx0) cx0 = x
      if (x > cx1) cx1 = x
      if (y < cy0) cy0 = y
      if (y > cy1) cy1 = y
    }
  }
  if (cx1 < 0) throw new Error('No writing found in that photo — try a closer, brighter shot.')

  // ── 5. Crop with padding ─────────────────────────────────────────────────
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
  return { png, width: cw, height: ch }
}

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

/** 4-connected component labelling (iterative flood fill). Labels are 1-based. */
function components(mask: Uint8Array, W: number, H: number) {
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
function dilate(mask: Uint8Array, W: number, H: number, r: number): Uint8Array {
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
