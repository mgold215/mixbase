// Cassette Studio — puts the artist's REAL cassette photo into a new scene and
// letters it in their own handwriting.
//
// The cassette is never generated. Its pixels come from the artist's photo,
// cut out once (a background-removal model), and are pasted back on top of
// every result untouched apart from a gentle exposure/white-balance match to
// the new scene. What changes per render is everything AROUND it:
//
//   scene  — an AI photograph generated *around* the cassette (FLUX Fill
//            inpainting with the cassette left in the frame and masked out),
//            so the model sees the object and builds the surface it stands
//            on, the light falling on it and its shadow to match. The real
//            cassette is then re-pasted over the model's output at full
//            resolution, so not one pixel of it is synthetic.
//   photo  — the artist's own background photo. No AI at all: the cassette
//            is composited with a contact shadow, an optional surface
//            reflection and a depth-of-field falloff so it sits IN the photo
//            rather than on top of it.
//
// Both paths finish the same way — light wrap at the edges, one film-grain
// pass over the whole frame (grain that runs continuously across cassette
// and background is what sells a composite as one photograph) — and output a
// 3000×3000 JPEG, the size the streaming services ask for.
//
// Pure image maths over raw pixels plus sharp. No server-only imports —
// scripts/cassette-studio-test.mjs drives it directly under Node.

import sharp from 'sharp'
import { applyFilmFinish } from './film-finish.ts'

/** Output edge. 3000×3000 is the DSP-recommended cover size. */
export const COVER = 3000
/** Edge the FLUX Fill request is made at (multiple of 64, ≈1.8 MP). */
export const FILL_SIZE = 1344

export type Box = { left: number; top: number; width: number; height: number }

// mulberry32 — same tiny seedable PRNG as film-finish, so a render is
// reproducible from its seed.
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── Studio keys ────────────────────────────────────────────────────────────
// Layout documented in src/lib/cassette-server.ts. Pure so the test can pin it.

export const studioPrefix = (userId: string) => `studio/${userId}/`

/**
 * Is `key` one of THIS user's studio files of the given kind, in exactly the
 * shape the routes mint? Keys arrive from the client, so this is the
 * ownership check: the prefix pins the user, the leaf regex pins the shape
 * (no '..', no nested folders, no other user's id).
 */
export function isOwnStudioKey(key: unknown, userId: string, kind: 'subject' | 'lettering'): key is string {
  if (typeof key !== 'string') return false
  const prefix = studioPrefix(userId)
  if (!key.startsWith(prefix)) return false
  const leaf = key.slice(prefix.length)
  return kind === 'subject'
    ? /^subject-\d{10,16}\.png$/.test(leaf)
    : /^lettering-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-\d{10,16}\.png$/.test(leaf)
}

// ── Subject ────────────────────────────────────────────────────────────────

/**
 * Normalise a background-removal output: bake EXIF rotation, crop to the
 * opaque object (alpha > 8) and cap the long edge. Returns a PNG.
 * Throws when there is no object in the cut-out at all.
 */
export async function trimSubject(cutout: Buffer, maxEdge = 2400): Promise<{ png: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(cutout).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width: W, height: H } = info
  let x0 = W, y0 = H, x1 = -1, y1 = -1
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  if (x1 < 0) throw new Error('Could not find the cassette in that photo.')
  const png = await sharp(data, { raw: { width: W, height: H, channels: 4 } })
    .extract({ left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 })
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer()
  const meta = await sharp(png).metadata()
  return { png, width: meta.width ?? 0, height: meta.height ?? 0 }
}

/**
 * Make clear plastic actually clear.
 *
 * A background-removal model treats a clear cassette shell as solid, so the
 * cut-out still carries whatever was BEHIND the shell in the original photo
 * (a keyboard, a desk) — pasted into a night scene, that reads as frosted
 * white plastic, the one giveaway next to a real photo. This recovers the
 * transparency with the standard matting equation, using an estimate of the
 * original backdrop (the "clean plate"):
 *
 *   1. Clean plate — the photo's pixels OUTSIDE the cassette, smoothly
 *      interpolated in under it (push-pull pyramid fill).
 *   2. Where a cassette pixel is close to the plate, we are looking through
 *      plastic at the backdrop: opacity falls toward a floor (the plastic's
 *      own sheen). Where it differs — label, reels, tape, moulded edges — it
 *      stays opaque.
 *   3. The backdrop's contribution is removed from the colour
 *      (F = (I − (1−α)·B) / α), so the new scene shows through instead of
 *      the old one.
 *
 * Only the clear FRAME is touched. A cassette's label is often a grey not far
 * from the backdrop's (it is in the reference photo: label vs. keyboard), so
 * the label area is protected by the compact-cassette geometry itself —
 * IEC 60094: shell 100.4 × 63.8 mm, label window inset ≈6% from the sides,
 * ≈7% from the top, down to ≈75% of the height. Subjects that are not
 * cassette-shaped (aspect outside 1.35–1.8, i.e. not shot face-on) are
 * returned unchanged: no geometry, no guessing.
 *
 * Works best when the cassette was shot against a plain, smooth backdrop;
 * against a busy one the plate is a rougher guess and more of the shell
 * stays opaque (never worse than the plain cut-out). Both buffers must be
 * the same photo at the same size. Returns a PNG.
 */
export async function seeThrough(original: Buffer, cutout: Buffer, opts: { floor?: number; tolerance?: number } = {}): Promise<Buffer> {
  const floor = clamp(opts.floor ?? 0.22, 0, 1)
  const tol = Math.max(4, opts.tolerance ?? 42)
  const cut = await sharp(cutout).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const W = cut.info.width, H = cut.info.height

  // Object bounds → cassette geometry check + label rectangle.
  let bx0 = W, by0 = H, bx1 = -1, by1 = -1
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (cut.data[(y * W + x) * 4 + 3] > 128) {
        if (x < bx0) bx0 = x
        if (x > bx1) bx1 = x
        if (y < by0) by0 = y
        if (y > by1) by1 = y
      }
    }
  }
  const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1
  const aspect = bw / Math.max(1, bh)
  if (bx1 < 0 || aspect < 1.35 || aspect > 1.8) return sharp(cut.data, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer()
  const lx0 = bx0 + bw * 0.065, lx1 = bx1 - bw * 0.065
  const ly0 = by0 + bh * 0.075, ly1 = by0 + bh * 0.74
  // Soft edge on the protected rectangle so there is no visible seam.
  const feather = bw * 0.012
  const labelWeight = (x: number, y: number) =>
    smooth(clamp(Math.min(x - lx0, lx1 - x, y - ly0, ly1 - y) / feather + 0.5, 0, 1))

  const img = await sharp(original).rotate().removeAlpha().resize(W, H, { fit: 'fill' }).raw().toBuffer()

  // Clean plate at 1/4 resolution (it is smooth by construction).
  const pw = Math.max(1, Math.round(W / 4)), ph = Math.max(1, Math.round(H / 4))
  const smallImg = await sharp(img, { raw: { width: W, height: H, channels: 3 } }).resize(pw, ph, { fit: 'fill' }).raw().toBuffer()
  const alphaRaw = Buffer.alloc(W * H)
  for (let i = 0; i < W * H; i++) alphaRaw[i] = cut.data[i * 4 + 3]
  // Grow the "unknown" region a little so the halo right at the edge (which
  // still has some cassette in it) doesn't leak into the plate.
  const smallA = await sharp(alphaRaw, { raw: { width: W, height: H, channels: 1 } }).resize(pw, ph, { fit: 'fill' }).blur(2).raw().toBuffer()
  const known = new Float32Array(pw * ph)
  for (let i = 0; i < pw * ph; i++) known[i] = smallA[i] < 6 ? 1 : 0
  const plateSmall = pushPull(smallImg, known, pw, ph)
  const plate = await sharp(Buffer.from(plateSmall.map(v => clamp8(v))), { raw: { width: pw, height: ph, channels: 3 } })
    .resize(W, H, { fit: 'fill', kernel: 'cubic' }).raw().toBuffer()

  const out = Buffer.alloc(W * H * 4)
  for (let i = 0; i < W * H; i++) {
    const a0 = cut.data[i * 4 + 3] / 255
    const p = i * 3, o = i * 4
    if (a0 <= 0) continue
    const dr = img[p] - plate[p], dg = img[p + 1] - plate[p + 1], db = img[p + 2] - plate[p + 2]
    const diff = Math.sqrt(dr * dr + dg * dg + db * db)
    const t = clamp(diff / tol, 0, 1)
    const x = i % W, y = (i - x) / W
    const aClear = 1 - (1 - (floor + (1 - floor) * smooth(t))) * (1 - labelWeight(x, y))
    const a = a0 * aClear
    // Un-mix the backdrop: F = (I − (1−α)·B) / α. Clamped — where the plate
    // guess is off, F would overshoot.
    for (let c = 0; c < 3; c++) {
      const f = (img[p + c] - (1 - aClear) * plate[p + c]) / aClear
      out[o + c] = clamp8(f)
    }
    out[o + 3] = clamp8(a * 255)
  }
  return sharp(out, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer()
}

/** Push-pull fill: interpolate unknown pixels from known ones across scales. */
function pushPull(rgb: Buffer, known: Float32Array, W: number, H: number): Float32Array {
  const levels: { c: Float32Array; w: Float32Array; W: number; H: number }[] = []
  let c = new Float32Array(W * H * 3)
  let w = Float32Array.from(known)
  for (let i = 0; i < W * H; i++) for (let k = 0; k < 3; k++) c[i * 3 + k] = rgb[i * 3 + k] * w[i]
  let cw = W, ch = H
  levels.push({ c, w, W: cw, H: ch })
  while (cw > 1 || ch > 1) {
    const nw = Math.max(1, Math.ceil(cw / 2)), nh = Math.max(1, Math.ceil(ch / 2))
    const nc = new Float32Array(nw * nh * 3), nwt = new Float32Array(nw * nh)
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const s = y * cw + x, d = (y >> 1) * nw + (x >> 1)
        nwt[d] += w[s]
        for (let k = 0; k < 3; k++) nc[d * 3 + k] += c[s * 3 + k]
      }
    }
    c = nc; w = nwt; cw = nw; ch = nh
    levels.push({ c, w, W: cw, H: ch })
  }
  // Pull: normalise the coarsest level, then fill each finer level's gaps
  // from the (bilinear) level below it.
  let prev = levels[levels.length - 1]
  let prevRgb = new Float32Array(prev.W * prev.H * 3)
  for (let i = 0; i < prev.W * prev.H; i++) for (let k = 0; k < 3; k++) prevRgb[i * 3 + k] = prev.w[i] > 0 ? prev.c[i * 3 + k] / prev.w[i] : 128
  for (let l = levels.length - 2; l >= 0; l--) {
    const L = levels[l]
    const rgbL = new Float32Array(L.W * L.H * 3)
    for (let y = 0; y < L.H; y++) {
      for (let x = 0; x < L.W; x++) {
        const i = y * L.W + x
        const fx = Math.min(prev.W - 1, Math.max(0, (x + 0.5) / 2 - 0.5)), fy = Math.min(prev.H - 1, Math.max(0, (y + 0.5) / 2 - 0.5))
        const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(prev.W - 1, x0 + 1), y1 = Math.min(prev.H - 1, y0 + 1)
        const tx = fx - x0, ty = fy - y0
        const wt = Math.min(1, L.w[i])
        for (let k = 0; k < 3; k++) {
          const up =
            (prevRgb[(y0 * prev.W + x0) * 3 + k] * (1 - tx) + prevRgb[(y0 * prev.W + x1) * 3 + k] * tx) * (1 - ty) +
            (prevRgb[(y1 * prev.W + x0) * 3 + k] * (1 - tx) + prevRgb[(y1 * prev.W + x1) * 3 + k] * tx) * ty
          const own = L.w[i] > 0 ? L.c[i * 3 + k] / L.w[i] : up
          rgbL[i * 3 + k] = own * wt + up * (1 - wt)
        }
      }
    }
    prev = L
    prevRgb = rgbL
  }
  return prevRgb
}

/**
 * Where the cassette sits in the 3000px frame: centred-ish, standing on a
 * surface about 70% of the way down — the composition of a real "object on a
 * ledge" photo, with the lower-left third free for the handwriting. A little
 * seeded jitter so a batch doesn't look stamped from one template.
 */
export function placeSubject(sw: number, sh: number, seed: number): Box {
  const r = rng(seed ^ 0x5bd1e995)
  let width = COVER * (0.40 + (r() - 0.5) * 0.06)
  let height = width * (sh / sw)
  // Portrait subjects (a cassette stood on its end, a case) cap on height.
  if (height > COVER * 0.5) { height = COVER * 0.5; width = height * (sw / sh) }
  const cx = COVER * (0.5 + (r() - 0.5) * 0.06)
  const base = COVER * (0.70 + (r() - 0.5) * 0.04)
  return {
    left: Math.round(cx - width / 2),
    top: Math.round(base - height),
    width: Math.round(width),
    height: Math.round(height),
  }
}

/**
 * The FLUX Fill request: the cassette placed on a neutral canvas, and a mask
 * that is WHITE where the model should paint (everything except the
 * cassette) and BLACK over the cassette. The mask is eroded a few pixels so
 * the model paints right up to — and a hair under — the edge; the real
 * cassette pasted back later covers that seam. Transparent holes in the
 * subject (the reel windows) stay white, so the scene shows through them.
 */
export async function buildFillRequest(subject: Buffer, box: Box, size = FILL_SIZE): Promise<{ image: Buffer; mask: Buffer }> {
  const s = size / COVER
  const w = Math.max(1, Math.round(box.width * s))
  const h = Math.max(1, Math.round(box.height * s))
  const left = Math.round(box.left * s)
  const top = Math.round(box.top * s)
  const small = await sharp(subject).resize(w, h, { fit: 'fill' }).ensureAlpha().raw().toBuffer()

  const image = await sharp({ create: { width: size, height: size, channels: 3, background: { r: 128, g: 128, b: 128 } } })
    .composite([{ input: await sharp(small, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer(), left, top }])
    .jpeg({ quality: 95 })
    .toBuffer()

  // Keep-mask = solid cassette, eroded 3px.
  const keep = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) keep[i] = small[i * 4 + 3] > 200 ? 1 : 0
  const eroded = erode(keep, w, h, 3)
  const mask = Buffer.alloc(size * size, 255)
  for (let y = 0; y < h; y++) {
    const yy = y + top
    if (yy < 0 || yy >= size) continue
    for (let x = 0; x < w; x++) {
      const xx = x + left
      if (xx < 0 || xx >= size) continue
      if (eroded[y * w + x]) mask[yy * size + xx] = 0
    }
  }
  return { image, mask: await sharp(mask, { raw: { width: size, height: size, channels: 1 } }).png().toBuffer() }
}

// ── Composite ──────────────────────────────────────────────────────────────

export type ComposeOptions = {
  background: Buffer
  subject: Buffer
  box: Box
  /** 'scene' = background came from FLUX Fill around this exact box; 'photo' = the artist's own photo. */
  kind: 'scene' | 'photo'
  seed: number
  /** 0..1 depth-of-field falloff away from the cassette's base line. Photo mode only. Default 0.5. */
  depth?: number
  /** 0..1 strength of a mirror reflection under the cassette (glossy surfaces). Default 0. */
  reflection?: number
  /** Skip the final film pass (tests). */
  raw?: boolean
}

export async function composeLayers(opts: ComposeOptions): Promise<CoverLayers> {
  const { box, kind } = opts
  const depth = clamp(opts.depth ?? (kind === 'photo' ? 0.5 : 0), 0, 1)
  const reflection = clamp(opts.reflection ?? 0, 0, 1)
  const W = COVER, H = COVER
  const base = box.top + box.height

  // 1. Background, square-cropped to the cover.
  const bgSharp = sharp(opts.background).rotate().removeAlpha().resize(W, H, { fit: 'cover', kernel: 'lanczos3' })
  const bgBuf = await bgSharp.raw().toBuffer()
  const bg = new Float32Array(bgBuf.length)
  for (let i = 0; i < bgBuf.length; i++) bg[i] = bgBuf[i]

  // Depth of field: blend toward a blurred copy with distance from the
  // cassette's base line. A real lens focused on the cassette holds the
  // strip of surface it stands on sharp and lets the far scene (and the
  // nearest foreground) go soft.
  if (depth > 0) {
    const blurred = await sharp(bgBuf, { raw: { width: W, height: H, channels: 3 } })
      .blur(Math.max(0.3, W * 0.0045 * depth))
      .raw()
      .toBuffer()
    for (let y = 0; y < H; y++) {
      const d = y < base ? (base - y) / (H * 0.32) : (y - base) / (H * 0.22)
      const t = smooth(clamp(d, 0, 1))
      if (t <= 0) continue
      const row = y * W * 3
      for (let i = row; i < row + W * 3; i++) bg[i] += (blurred[i] - bg[i]) * t
    }
  }

  // 2. Subject at its placed size.
  const sw = box.width, sh = box.height
  const subj = await sharp(opts.subject).resize(sw, sh, { fit: 'fill', kernel: 'mitchell' }).ensureAlpha().raw().toBuffer()
  const alpha = new Float32Array(sw * sh)
  for (let i = 0; i < sw * sh; i++) alpha[i] = subj[i * 4 + 3] / 255

  // 3. Harmonise: pull the cassette's exposure and white balance part of the
  // way toward the scene around it. Partial on purpose — a full match flattens
  // the object; none at all is the classic pasted-on look.
  const ring = ringMean(bg, W, H, box)
  let sr = 0, sg = 0, sb = 0, sn = 0
  for (let i = 0; i < sw * sh; i++) {
    if (alpha[i] < 0.8) continue
    sr += subj[i * 4]; sg += subj[i * 4 + 1]; sb += subj[i * 4 + 2]; sn++
  }
  const sMean = sn ? [sr / sn, sg / sn, sb / sn] : [128, 128, 128]
  const lumBg = Math.max(4, luma(ring[0], ring[1], ring[2]))
  const lumS = Math.max(4, luma(sMean[0], sMean[1], sMean[2]))
  const gainL = clamp(Math.pow(lumBg / lumS, 0.35), 0.6, 1.15)
  const gain = [0, 1, 2].map(c => {
    const castBg = ring[c] / lumBg, castS = sMean[c] / lumS
    return gainL * clamp(Math.pow(castBg / Math.max(0.05, castS), 0.3), 0.85, 1.15)
  })

  // 4. Contact shadow + occlusion, multiplied into the background. The
  // contact line is where the cassette actually touches down: the columns
  // whose lowest opaque pixel is in its bottom 3%.
  let c0 = sw, c1 = -1
  for (let x = 0; x < sw; x++) {
    for (let y = sh - 1; y >= Math.floor(sh * 0.97); y--) {
      if (alpha[y * sw + x] > 0.5) { if (x < c0) c0 = x; if (x > c1) c1 = x; break }
    }
  }
  if (c1 < 0) { c0 = 0; c1 = sw - 1 }
  const ccx = box.left + (c0 + c1) / 2
  const halfW = Math.max(4, (c1 - c0) / 2)
  // A scene render already has the model's own shadow; ours only anchors it.
  const softDark = kind === 'scene' ? 0.3 : 0.6
  const aoDark = kind === 'scene' ? 0.55 : 0.85
  const softRy = sw * 0.07, aoRy = sw * 0.014
  const y0 = Math.max(0, Math.floor(base - softRy * 3)), y1 = Math.min(H - 1, Math.ceil(base + softRy * 3))
  const x0 = Math.max(0, Math.floor(ccx - halfW * 1.4)), x1 = Math.min(W - 1, Math.ceil(ccx + halfW * 1.4))
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x - ccx) / (halfW * 1.08)
      const dyS = (y - base) / softRy
      const dyA = (y - (base - aoRy * 0.3)) / aoRy
      const fx = Math.pow(dx * dx, 3)
      const soft = softDark * Math.exp(-(fx + dyS * dyS) * 1.6) * (y >= base - softRy ? 1 : 0.4)
      const dxA = (x - ccx) / halfW
      const ao = aoDark * Math.exp(-(Math.pow(dxA * dxA, 4) + dyA * dyA) * 2)
      const shade = (1 - soft) * (1 - ao)
      const i = (y * W + x) * 3
      bg[i] *= shade; bg[i + 1] *= shade; bg[i + 2] *= shade
    }
  }

  // 5. Reflection on a glossy surface: the cassette mirrored about its base,
  // fading out fast.
  if (reflection > 0) {
    const depthPx = Math.round(sh * 0.3)
    for (let k = 1; k <= depthPx; k++) {
      const yy = base + k
      if (yy >= H) break
      const sy = sh - k
      if (sy < 0) break
      const fade = reflection * 0.35 * Math.pow(1 - k / depthPx, 2)
      for (let x = 0; x < sw; x++) {
        const xx = box.left + x
        if (xx < 0 || xx >= W) continue
        const si = sy * sw + x
        const a = alpha[si] * fade
        if (a <= 0) continue
        const di = (yy * W + xx) * 3
        for (let c = 0; c < 3; c++) bg[di + c] += (subj[si * 4 + c] * gain[c] - bg[di + c]) * a
      }
    }
  }

  // 6. Light wrap: the scene's light bleeds a little over the cassette's
  // silhouette, the way it does in any real photo. Needs a blurred copy of
  // the background behind the cassette and a blurred alpha to find the rim.
  const pad = Math.round(sw * 0.06)
  const rx = Math.max(0, box.left - pad), ry = Math.max(0, box.top - pad)
  const rw = Math.min(W, box.left + sw + pad) - rx, rh = Math.min(H, box.top + sh + pad) - ry
  const regionRaw = Buffer.alloc(rw * rh * 3)
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw * 3; x++) regionRaw[y * rw * 3 + x] = clamp8(bg[((y + ry) * W + rx) * 3 + x])
  }
  const bgBlur = await sharp(regionRaw, { raw: { width: rw, height: rh, channels: 3 } }).blur(Math.max(0.5, sw * 0.02)).raw().toBuffer()
  const aRaw = Buffer.alloc(sw * sh)
  for (let i = 0; i < sw * sh; i++) aRaw[i] = subj[i * 4 + 3]
  const aBlur = await sharp(aRaw, { raw: { width: sw, height: sh, channels: 1 } }).blur(Math.max(0.5, sw * 0.004)).raw().toBuffer()

  // 7. The cassette layer, finished (harmonised + light-wrapped), and the
  // plate it sits on. Kept apart so the motion renderer
  // (src/lib/cassette-motion.ts) can move them independently; the still
  // cover is just one alpha-over of the two.
  const plate = Buffer.alloc(W * H * 3)
  for (let i = 0; i < plate.length; i++) plate[i] = clamp8(bg[i])
  const layer = Buffer.alloc(sw * sh * 4)
  for (let y = 0; y < sh; y++) {
    const yy = box.top + y
    for (let x = 0; x < sw; x++) {
      const xx = box.left + x
      const si = y * sw + x
      const a = alpha[si]
      const o = si * 4
      layer[o + 3] = clamp8(a * 255)
      if (a <= 0) continue
      const inFrame = yy >= 0 && yy < H && xx >= 0 && xx < W
      const rim = inFrame ? clamp((1 - aBlur[si] / 255) * 2.2, 0, 1) * 0.4 : 0
      const bi = inFrame ? ((yy - ry) * rw + (xx - rx)) * 3 : 0
      for (let c = 0; c < 3; c++) {
        let v = subj[o + c] * gain[c]
        if (rim > 0) v += (bgBlur[bi + c] - v) * rim
        layer[o + c] = clamp8(v)
      }
    }
  }
  return { plate, layer, box, width: W, height: H }
}

export type CoverLayers = {
  /** Raw RGB, width×height: the scene with the cassette's shadow/reflection, no cassette. */
  plate: Buffer
  /** Raw RGBA, box.width×box.height: the finished cassette. */
  layer: Buffer
  box: Box
  width: number
  height: number
}

/** Alpha-over of the cassette layer onto the plate. Raw RGB out. */
export function flattenLayers(l: CoverLayers): Buffer {
  const out = Buffer.from(l.plate)
  const { box, width: W, height: H } = l
  for (let y = 0; y < box.height; y++) {
    const yy = box.top + y
    if (yy < 0 || yy >= H) continue
    for (let x = 0; x < box.width; x++) {
      const xx = box.left + x
      if (xx < 0 || xx >= W) continue
      const o = (y * box.width + x) * 4
      const a = l.layer[o + 3] / 255
      if (a <= 0) continue
      const d = (yy * W + xx) * 3
      for (let c = 0; c < 3; c++) out[d + c] = clamp8(out[d + c] + (l.layer[o + c] - out[d + c]) * a)
    }
  }
  return out
}

/**
 * The still cover: layers flattened, then one grain field across the whole
 * frame — the single strongest cue that cassette and scene were captured
 * together. Returns JPEG.
 */
export async function composeCover(opts: ComposeOptions): Promise<Buffer> {
  return finishCover(await composeLayers(opts), opts.seed, opts.raw)
}

export async function finishCover(layers: CoverLayers, seed: number, raw = false): Promise<Buffer> {
  const flat = flattenLayers(layers)
  const jpeg = await sharp(flat, { raw: { width: layers.width, height: layers.height, channels: 3 } }).jpeg({ quality: 97 }).toBuffer()
  if (raw) return jpeg
  return applyFilmFinish(jpeg, { seed, grain: 0.5, vignette: 0.3, saturation: 0.95, quality: 92 })
}

// ── Lettering ──────────────────────────────────────────────────────────────

export const LETTERING_POSITIONS = ['bottom-left', 'bottom-center', 'bottom-right', 'top-left', 'top-center', 'top-right'] as const
export type LetteringPosition = (typeof LETTERING_POSITIONS)[number]
export const LETTERING_SIZES = ['small', 'medium', 'large'] as const
export type LetteringSize = (typeof LETTERING_SIZES)[number]

const SIZE_FRAC: Record<LetteringSize, number> = { small: 0.32, medium: 0.42, large: 0.54 }
/** Marker white (slightly warm, never pure #FFF) and near-black ink. */
const AUTO_LIGHT = '#F4F1EA'
const AUTO_DARK = '#161616'

/**
 * Lay the extracted handwriting (white RGB + ink alpha) over the cover.
 * `color` is a hex or 'auto' — auto reads the brightness of the patch the
 * writing lands on and picks marker-white or ink-black.
 */
export async function applyLettering(
  art: Buffer,
  lettering: Buffer,
  opts: { color?: string; position?: LetteringPosition; size?: LetteringSize } = {},
): Promise<{ jpeg: Buffer; color: string }> {
  const position = opts.position ?? 'bottom-left'
  const size = opts.size ?? 'medium'
  const meta = await sharp(art).metadata()
  const W = meta.width ?? COVER, H = meta.height ?? COVER

  const lm = await sharp(lettering).metadata()
  let lw = Math.round(W * SIZE_FRAC[size])
  let lh = Math.round(lw * ((lm.height ?? 1) / (lm.width ?? 1)))
  if (lh > H * 0.3) { lh = Math.round(H * 0.3); lw = Math.round(lh * ((lm.width ?? 1) / (lm.height ?? 1))) }
  const margin = Math.round(W * 0.06)
  const left = position.endsWith('left') ? margin : position.endsWith('right') ? W - margin - lw : Math.round((W - lw) / 2)
  const top = position.startsWith('top') ? margin : H - margin - lh

  let color = opts.color && /^#[0-9a-f]{6}$/i.test(opts.color) ? opts.color : 'auto'
  if (color === 'auto') {
    const { channels } = await sharp(art).extract({ left, top, width: lw, height: lh }).stats()
    const l = luma(channels[0].mean, channels[1].mean, channels[2].mean)
    color = l > 165 ? AUTO_DARK : AUTO_LIGHT
  }
  const r = parseInt(color.slice(1, 3), 16), g = parseInt(color.slice(3, 5), 16), b = parseInt(color.slice(5, 7), 16)

  const a = await sharp(lettering).ensureAlpha().resize(lw, lh, { fit: 'fill' }).extractChannel(3).raw().toBuffer()
  const rgba = Buffer.alloc(lw * lh * 4)
  for (let i = 0; i < lw * lh; i++) {
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b
    rgba[i * 4 + 3] = Math.round(a[i] * 0.96)
  }
  const overlay = await sharp(rgba, { raw: { width: lw, height: lh, channels: 4 } }).png().toBuffer()
  const jpeg = await sharp(art).composite([{ input: overlay, left, top }]).jpeg({ quality: 92, chromaSubsampling: '4:2:0' }).toBuffer()
  return { jpeg, color }
}

// ── helpers ────────────────────────────────────────────────────────────────

function ringMean(bg: Float32Array, W: number, H: number, box: Box): [number, number, number] {
  const ex = box.width * 0.5, ey = box.height * 0.5
  const x0 = Math.max(0, Math.floor(box.left - ex)), x1 = Math.min(W - 1, Math.ceil(box.left + box.width + ex))
  const y0 = Math.max(0, Math.floor(box.top - ey)), y1 = Math.min(H - 1, Math.ceil(box.top + box.height + ey))
  let r = 0, g = 0, b = 0, n = 0
  for (let y = y0; y <= y1; y += 3) {
    for (let x = x0; x <= x1; x += 3) {
      if (x >= box.left && x < box.left + box.width && y >= box.top && y < box.top + box.height) continue
      const i = (y * W + x) * 3
      r += bg[i]; g += bg[i + 1]; b += bg[i + 2]; n++
    }
  }
  return n ? [r / n, g / n, b / n] : [128, 128, 128]
}

function erode(mask: Uint8Array, W: number, H: number, r: number): Uint8Array {
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

function luma(r: number, g: number, b: number) { return 0.2126 * r + 0.7152 * g + 0.0722 * b }
function smooth(t: number) { return t * t * (3 - 2 * t) }
function clamp(v: number, lo: number, hi: number) { return v < lo ? lo : v > hi ? hi : v }
function clamp8(v: number) { return v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0 }
