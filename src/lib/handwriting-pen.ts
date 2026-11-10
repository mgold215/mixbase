// Handwriting PEN — the same letters, drawn with a finer (or fuller) pen.
//
// A whiteboard marker lays down a stroke a fifth as wide as the letter is
// tall. Shrunk onto a cover that reads as blobs: counters close up, strokes
// run into each other, and the title looks sloppy however carefully it was
// written. A fine ballpoint has the opposite problem and vanishes. Lettering
// that sits well on a cover has a stroke around an eighth of its height.
//
// This re-weights the writing without redrawing it. Every stroke is narrowed
// (or widened) by the same amount on both sides — the outline moves inward
// along its own normal — so the letter's skeleton, its proportions, its
// wobble and the way the pen swelled where it slowed down all survive: it is
// the artist's letter traced with a different pen, not a font. Done on a
// distance field at three times the working resolution, so the new edge is
// clean at any size.
//
// Narrowing alone would make a marker's quirks louder: the bead of ink where
// the pen went down or lifted off loses the same amount as the stroke it sits
// on, so it ends up bigger against it — a drip on every stroke end. The
// narrowed shape is therefore redrawn with a ROUND nib half the new stroke
// wide: whatever that nib cannot fit into (the pointed tip of a drip, a burr
// on the edge) is gone, and every stroke end comes out round. A stroke that
// was already too thin for the nib would vanish with the burrs; its centre
// line is kept at the nib's width instead.
//
// Also here: levelling a line of writing that climbs or drops (a vertical
// shear, so upright strokes stay upright), and finding the body of a line of
// lowercase (its baseline and x-height) so a signature can be sized against a
// title.
//
// Pure maths over alpha fields, no imports — scripts/handwriting-pen-test.mjs
// drives it under Node.

export type Field = { alpha: Uint8Array; width: number; height: number }

/** Supersampling factor of the distance field. */
const SS = 3
/** Transparent margin (input px) a field is given before its distances are taken. */
const PAD = 2
const INF = 1e20

// ── Distance transform ──────────────────────────────────────────────────────

/** 1-D squared distance transform (Felzenszwalb & Huttenlocher), in place over one line. */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0
  v[0] = 0
  z[0] = -INF
  z[1] = INF
  for (let q = 1; q < n; q++) {
    let s = 0
    for (;;) {
      const p = v[k]
      s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p)
      if (s <= z[k] && k > 0) k--
      else break
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = INF
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    const p = v[k]
    d[q] = (q - p) * (q - p) + f[p]
  }
}

/**
 * Exact Euclidean distance (px) from every pixel to the nearest pixel where
 * `mask` equals `target` (0 or 1). Pixels that are themselves `target` get 0.
 * When no pixel is `target`, every distance is the image diagonal.
 */
export function distanceTo(mask: Uint8Array, W: number, H: number, target: 0 | 1): Float32Array {
  const n = Math.max(W, H)
  const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1)
  const v = new Int32Array(n)
  const g = new Float64Array(W * H)
  // Columns first.
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = mask[y * W + x] === target ? 0 : INF
    edt1d(f, H, d, v, z)
    for (let y = 0; y < H; y++) g[y * W + x] = d[y]
  }
  const out = new Float32Array(W * H)
  const cap = Math.sqrt(W * W + H * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) f[x] = g[y * W + x]
    edt1d(f, W, d, v, z)
    for (let x = 0; x < W; x++) out[y * W + x] = Math.min(cap, Math.sqrt(d[x]))
  }
  return out
}

// ── Stroke width ────────────────────────────────────────────────────────────

/**
 * On the centre line of a stroke the distance to the edge stops climbing: its
 * slope (1 everywhere else) drops to nothing — or to ½ on each of the two
 * centre rows of a stroke an even number of pixels wide. The crease that runs
 * into a square corner of the outline is a ridge too, but a steep one (0.71).
 * Squared slopes under this are centre line.
 */
const RIDGE = 0.3

/** Squared slope of a distance field at pixel i (central differences; i must not be on the border). */
function slope2(dist: Float32Array, i: number, W: number): number {
  const gx = (dist[i + 1] - dist[i - 1]) / 2, gy = (dist[i + W] - dist[i - W]) / 2
  return gx * gx + gy * gy
}

/** `field` with `n` transparent pixels added on every side — the paper a cropped letter has lost. */
function pad(field: Field, n: number): Field {
  const { alpha, width: W, height: H } = field
  const w = W + 2 * n, h = H + 2 * n
  const out = new Uint8Array(w * h)
  for (let y = 0; y < H; y++) out.set(alpha.subarray(y * W, y * W + W), (y + n) * w + n)
  return { alpha: out, width: w, height: h }
}

/**
 * Typical stroke width (px) of an ink alpha field. Read off the centre lines
 * of the strokes (where the distance to the edge stops climbing — it is half
 * the width there), taking the 35th percentile so the blobs where a fat pen's
 * strokes ran together do not pass for the pen's width. 0 when there is no ink.
 */
export function strokeWidthOf(field: Field): number {
  const { alpha, width: W, height: H } = pad(field, 1)
  const mask = new Uint8Array(W * H)
  let n = 0
  for (let i = 0; i < W * H; i++) if (alpha[i] > 127) { mask[i] = 1; n++ }
  if (!n) return 0
  const dist = distanceTo(mask, W, H, 0)
  const centre: number[] = []
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x
      if (!mask[i] || dist[i] < 1.5) continue
      const g2 = slope2(dist, i, W)
      if (g2 >= RIDGE) continue
      // Distances are to the nearest paper pixel's CENTRE. A stroke an odd
      // number of pixels wide has one centre row (slope 0) at (w + 1) / 2; an
      // even one has two (slope ½ each) at w / 2.
      centre.push(g2 > 0.1 ? 2 * dist[i] : 2 * dist[i] - 1)
    }
  }
  if (centre.length >= 8) {
    centre.sort((a, b) => a - b)
    return Math.max(1, centre[Math.floor(centre.length * 0.35)])
  }
  // Too little ink for a centre line (a dot, a hairline): across a stroke the
  // distance runs evenly from 0 to half the width, so its median is a quarter.
  const v = new Float32Array(n)
  let k = 0
  for (let i = 0; i < W * H; i++) if (mask[i]) v[k++] = dist[i]
  v.sort()
  return Math.max(1, 4 * (v[n >> 1] - 0.5))
}

// ── Resampling ──────────────────────────────────────────────────────────────

function upscale(field: Field, s: number): Field {
  const { alpha, width: W, height: H } = field
  const w = W * s, h = H * s
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const fy = Math.min(H - 1, Math.max(0, (y + 0.5) / s - 0.5))
    const y0 = Math.floor(fy), y1 = Math.min(H - 1, y0 + 1), ty = fy - y0
    for (let x = 0; x < w; x++) {
      const fx = Math.min(W - 1, Math.max(0, (x + 0.5) / s - 0.5))
      const x0 = Math.floor(fx), x1 = Math.min(W - 1, x0 + 1), tx = fx - x0
      const a = alpha[y0 * W + x0] * (1 - tx) + alpha[y0 * W + x1] * tx
      const b = alpha[y1 * W + x0] * (1 - tx) + alpha[y1 * W + x1] * tx
      out[y * w + x] = Math.round(a * (1 - ty) + b * ty)
    }
  }
  return { alpha: out, width: w, height: h }
}

/** Box-average a float field (0..1) down by an integer factor to 8-bit alpha. */
function downscale(a: Float32Array, w: number, h: number, s: number): Field {
  const W = Math.floor(w / s), H = Math.floor(h / s)
  const out = new Uint8Array(W * H)
  const k = 255 / (s * s)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let sum = 0
      for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) sum += a[(y * s + dy) * w + x * s + dx]
      out[y * W + x] = Math.round(sum * k)
    }
  }
  return { alpha: out, width: W, height: H }
}

/** Two passes of a (2r+1) box blur over an 8-bit field: close to a Gaussian, rounds off pixel raggedness. */
function soften(field: Field, r: number): Field {
  if (r < 1) return field
  const { width: W, height: H } = field
  let src = Float32Array.from(field.alpha)
  const tmp = new Float32Array(W * H)
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < H; y++) {
      let sum = 0
      for (let x = -r; x <= r; x++) sum += src[y * W + Math.min(W - 1, Math.max(0, x))]
      for (let x = 0; x < W; x++) {
        tmp[y * W + x] = sum / (2 * r + 1)
        sum += src[y * W + Math.min(W - 1, x + r + 1)] - src[y * W + Math.max(0, x - r)]
      }
    }
    const out = new Float32Array(W * H)
    for (let x = 0; x < W; x++) {
      let sum = 0
      for (let y = -r; y <= r; y++) sum += tmp[Math.min(H - 1, Math.max(0, y)) * W + x]
      for (let y = 0; y < H; y++) {
        out[y * W + x] = sum / (2 * r + 1)
        sum += tmp[Math.min(H - 1, y + r + 1) * W + x] - tmp[Math.max(0, y - r) * W + x]
      }
    }
    src = out
  }
  const alpha = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) alpha[i] = Math.round(src[i])
  return { alpha, width: W, height: H }
}

// ── Re-weighting ────────────────────────────────────────────────────────────

export type RepenResult = {
  field: Field
  /** How far each edge moved inward (px, negative = outward). 0 when nothing was done. */
  inset: number
  /** Stroke width before and after (px). */
  from: number
  to: number
}

/**
 * How far to move each edge inward so that a stroke `stroke` px wide on a
 * letter `cap` px tall ends up `ratio` of the letter's NEW height (the letter
 * loses twice the inset in height as well). Negative = move outward.
 */
export function insetFor(stroke: number, cap: number, ratio: number): number {
  return (stroke - ratio * cap) / (2 * (1 - ratio))
}

/** How many times larger than its input a `hi` result is. */
export const PEN_SCALE = SS

/**
 * Redraw `field` with every stroke edge moved inward by `inset` px (outward
 * when negative). The ink keeps its place. Strokes thinner than twice the
 * inset keep their centre line at `floor` px wide (never wider than they
 * were) instead of vanishing. `stroke` is the width the writing has now
 * (strokeWidthOf), passed in so it is measured once.
 *
 * The result is the input's size unless `hi` is set: then it is PEN_SCALE
 * times larger in both directions (the distance field itself, edge one pixel
 * soft) — the clean master a caller scales to whatever size it draws at.
 * `inset`, `from` and `to` are always in INPUT pixels.
 */
export function repen(field: Field, inset: number, opts: { stroke?: number; floor?: number; hi?: boolean } = {}): RepenResult {
  const from = opts.stroke ?? strokeWidthOf(field)
  const still = !from || Math.abs(inset) < 0.35
  if (still && !opts.hi) return { field, inset: 0, from, to: from }
  // Never take more than leaves a third of the stroke, never add more than doubles it.
  const d = still ? 0 : Math.max(-from / 2, Math.min(from / 3, inset))
  const floor = Math.max(1, opts.floor ?? (from - 2 * d) * 0.7)

  // A letter cut tight to its ink has no paper left at its edges; without a
  // margin its outline there would not be seen as an outline at all.
  const up = soften(upscale(pad(field, PAD), SS), 1)
  const { width: w, height: h } = up
  const mask = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) mask[i] = up.alpha[i] > 127 ? 1 : 0
  const inside = distanceTo(mask, w, h, 0)
  const outside = d < 0 ? distanceTo(mask, w, h, 1) : null
  const D = d * SS
  const a = new Float32Array(w * h)

  if (d > 0) {
    // The round nib: half the new stroke wide (never wider than the floor).
    const nib = Math.min(floor, (from - 2 * d) * 0.5) * SS / 2
    // Where the nib's centre can go: at least inset + nib from every edge.
    const core = new Uint8Array(w * h)
    let anyCore = false
    for (let i = 0; i < w * h; i++) if (mask[i] && inside[i] - 0.5 >= D + nib) { core[i] = 1; anyCore = true }
    if (anyCore) {
      const toCore = distanceTo(core, w, h, 1)
      for (let i = 0; i < w * h; i++) {
        if (!mask[i]) continue
        const v = nib - toCore[i] + 0.5
        a[i] = v <= 0 ? 0 : v >= 1 ? 1 : v
      }
    }
    // Thin strokes the nib could not enter: their centre line, at the nib's
    // width (never wider than the stroke was).
    const ridge = new Uint8Array(w * h)
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x
        const v = inside[i]
        if (v < 1.5 || v - 0.5 >= D + nib) continue
        // Centre line only (see RIDGE): the crease running into a corner of
        // the outline — the square end of a stroke, a bump where the pen went
        // down — is steeper, and keeping those would put the drips straight back.
        if (slope2(inside, i, w) < RIDGE) ridge[i] = 1
      }
    }
    // A centre line is a line: a few stray ridge pixels are not a stroke.
    if (keepLongRuns(ridge, w, h, Math.max(8, Math.round(nib * 3)))) {
      // Where a thin stroke runs into a fat one its centre line stops short
      // (the distance field climbs steeply into the fat stroke), and what is
      // left of the fat stroke has drawn back from it: the two would come
      // apart. Carry each loose end on, uphill, until it is inside the ink
      // that was kept.
      const reach = Math.ceil((D + nib) * 2)
      const ends: number[] = []
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x
          if (ridge[i]) ends.push(i)
        }
      }
      for (const start of ends) {
        let at = start
        for (let step = 0; step < reach; step++) {
          let next = -1, top = inside[at] + 0.2
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const j = at + dy * w + dx
              if (j !== at && inside[j] > top) { top = inside[j]; next = j }
            }
          }
          if (next < 0 || ridge[next]) break
          const x = next % w, y = (next - x) / w
          if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) break
          ridge[next] = 1
          if (a[next] >= 0.99) break
          at = next
        }
      }
      const near = distanceTo(ridge, w, h, 1)
      for (let i = 0; i < w * h; i++) {
        if (!mask[i]) continue
        const v = Math.min(nib, inside[i]) - near[i] + 0.5
        if (v > a[i]) a[i] = v >= 1 ? 1 : v
      }
    }
  } else {
    for (let i = 0; i < w * h; i++) {
      const sd = mask[i] ? inside[i] - 0.5 : outside ? -(outside[i] - 0.5) : -1e6
      const v = sd - D + 0.5
      a[i] = v <= 0 ? 0 : v >= 1 ? 1 : v
    }
  }
  // Take the margin back off, so the result lines up with the input.
  if (opts.hi) {
    const m = PAD * SS
    const ow = w - 2 * m, oh = h - 2 * m
    const alpha = new Uint8Array(ow * oh)
    for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) alpha[y * ow + x] = Math.round(a[(y + m) * w + x + m] * 255)
    return { field: { alpha, width: ow, height: oh }, inset: d, from, to: from - 2 * d }
  }
  const low = downscale(a, w, h, SS)
  const alpha = new Uint8Array(field.width * field.height)
  for (let y = 0; y < field.height; y++) alpha.set(low.alpha.subarray((y + PAD) * low.width + PAD, (y + PAD) * low.width + PAD + field.width), y * field.width)
  return { field: { alpha, width: field.width, height: field.height }, inset: d, from, to: from - 2 * d }
}

/** Clear the 8-connected groups of `mask` smaller than `min` pixels, in place. True when anything is left. */
function keepLongRuns(mask: Uint8Array, W: number, H: number, min: number): boolean {
  const seen = new Uint8Array(W * H)
  const stack = new Int32Array(W * H)
  const group: number[] = []
  let any = false
  for (let start = 0; start < W * H; start++) {
    if (!mask[start] || seen[start]) continue
    let sp = 0
    group.length = 0
    stack[sp++] = start
    seen[start] = 1
    while (sp) {
      const i = stack[--sp]
      group.push(i)
      const x = i % W, y = (i - x) / W
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= H) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= W) continue
          const j = yy * W + xx
          if (mask[j] && !seen[j]) { seen[j] = 1; stack[sp++] = j }
        }
      }
    }
    if (group.length < min) for (const i of group) mask[i] = 0
    else any = true
  }
  return any
}

// ── Levelling a line ────────────────────────────────────────────────────────

/**
 * The slope (dy/dx) a line of writing climbs or drops at, within ±12°: the
 * one that lines the bottoms of its columns up best once taken out. Feet and
 * the undersides of bowls sit on the baseline; arches and crossbars sit on
 * other levels, parallel to it, so whichever level wins the slope is the same.
 */
export function lineSlopeOf(field: Field): number {
  const { alpha, width: W, height: H } = field
  const xs: number[] = [], ys: number[] = []
  let top = H, bottom = -1
  for (let x = 0; x < W; x++) {
    for (let y = H - 1; y >= 0; y--) {
      if (alpha[y * W + x] > 127) {
        xs.push(x - W / 2); ys.push(y)
        if (y > bottom) bottom = y
        break
      }
    }
    for (let y = 0; y < H; y++) if (alpha[y * W + x] > 127) { if (y < top) top = y; break }
  }
  if (xs.length < 12) return 0
  const band = Math.max(2, (bottom - top + 1) * 0.05)
  let best = 0, bestDeg = 0, bestScore = -1, bestLow = 0
  const r = new Float64Array(xs.length)
  for (let deg = -12; deg <= 12; deg += 0.25) {
    const s = Math.tan(deg * Math.PI / 180)
    for (let i = 0; i < xs.length; i++) r[i] = ys[i] - s * xs[i]
    r.sort()
    // The fullest window of ±band: how many column bottoms share one level.
    let score = 0, low = 0, j = 0
    for (let i = 0; i < r.length; i++) {
      while (r[i] - r[j] > 2 * band) j++
      if (i - j + 1 > score) { score = i - j + 1; low = r[j] }
    }
    if (score > bestScore || (score === bestScore && Math.abs(deg) < Math.abs(bestDeg))) { bestScore = score; best = s; bestDeg = deg; bestLow = low }
  }
  // The search only says which slopes fit within the band; the columns that
  // share that level then say exactly how it runs (least squares through them).
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0
  for (let i = 0; i < xs.length; i++) {
    const v = ys[i] - best * xs[i]
    if (v < bestLow - 0.5 || v > bestLow + 2 * band + 0.5) continue
    n++; sx += xs[i]; sy += v; sxx += xs[i] * xs[i]; sxy += xs[i] * v
  }
  const den = n * sxx - sx * sx
  const fine = n >= 12 && den > 0 ? (n * sxy - sx * sy) / den : 0
  const limit = Math.tan(12 * Math.PI / 180)
  return Math.max(-limit, Math.min(limit, best + fine))
}

/**
 * Shear a field vertically so a line that climbed at `slope` runs level:
 * each column slides up or down, upright strokes stay upright. The field
 * grows by the slide so nothing is cut off.
 */
export function shearLevel(field: Field, slope: number): Field {
  const { alpha, width: W, height: H } = field
  if (Math.abs(slope) < 0.002) return field
  const pad = Math.ceil(Math.abs(slope) * W / 2) + 1
  const h = H + 2 * pad
  const out = new Uint8Array(W * h)
  for (let x = 0; x < W; x++) {
    const shift = -slope * (x - W / 2) + pad
    const whole = Math.floor(shift), t = shift - whole
    for (let y = 0; y < H; y++) {
      const v = alpha[y * W + x]
      if (!v) continue
      const y0 = y + whole
      if (y0 >= 0 && y0 < h) out[y0 * W + x] = Math.min(255, out[y0 * W + x] + Math.round(v * (1 - t)))
      if (y0 + 1 >= 0 && y0 + 1 < h) out[(y0 + 1) * W + x] = Math.min(255, out[(y0 + 1) * W + x] + Math.round(v * t))
    }
  }
  return { alpha: out, width: W, height: h }
}

// ── The body of a line ──────────────────────────────────────────────────────

export type LineBody = {
  /** Rows of the densest band: the top of the small letters and the baseline. */
  top: number
  baseline: number
  /** First and last row with any ink (ascenders, descenders). */
  inkTop: number
  inkBottom: number
}

/**
 * Where the body of a LEVEL line of writing sits: the band of rows that hold
 * at least half as much ink as the fullest row. For lowercase that is the
 * x-height band (ascenders and descenders are sparse); for capitals it is the
 * whole letter. Null when the field is empty.
 */
export function lineBody(field: Field): LineBody | null {
  const { alpha, width: W, height: H } = field
  const rows = new Float64Array(H)
  let inkTop = -1, inkBottom = -1, peak = 0
  for (let y = 0; y < H; y++) {
    let s = 0
    for (let x = 0; x < W; x++) s += alpha[y * W + x]
    rows[y] = s
    if (s > 0) { if (inkTop < 0) inkTop = y; inkBottom = y }
  }
  if (inkTop < 0) return null
  // Smooth over a few rows so one crossbar does not pass for the fullest row.
  const r = Math.max(1, Math.round((inkBottom - inkTop + 1) * 0.03))
  const smooth = new Float64Array(H)
  for (let y = 0; y < H; y++) {
    let s = 0, n = 0
    for (let d = -r; d <= r; d++) if (y + d >= 0 && y + d < H) { s += rows[y + d]; n++ }
    smooth[y] = s / n
    if (smooth[y] > peak) peak = smooth[y]
  }
  // The longest run of rows over half the peak.
  let bestA = inkTop, bestB = inkBottom, bestLen = 0, a = -1
  for (let y = inkTop; y <= inkBottom + 1; y++) {
    const on = y <= inkBottom && smooth[y] >= peak * 0.5
    if (on && a < 0) a = y
    if (!on && a >= 0) {
      if (y - a > bestLen) { bestLen = y - a; bestA = a; bestB = y - 1 }
      a = -1
    }
  }
  return { top: bestA, baseline: bestB, inkTop, inkBottom }
}

/** Crop a field to its ink (alpha > 0), or null when it has none. */
export function cropField(field: Field): (Field & { left: number; top: number }) | null {
  const { alpha, width: W, height: H } = field
  let x0 = W, y0 = H, x1 = -1, y1 = -1
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (alpha[y * W + x] < 24) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  if (x1 < 0) return null
  const w = x1 - x0 + 1, h = y1 - y0 + 1
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) out.set(alpha.subarray((y + y0) * W + x0, (y + y0) * W + x0 + w), y * w)
  return { alpha: out, width: w, height: h, left: x0, top: y0 }
}
