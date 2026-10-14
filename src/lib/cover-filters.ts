// Cover filters — the "Finish the look" step of Cassette Studio: a row of
// Instagram-style looks plus seven sliders and a Color / B&W / Sepia switch,
// applied to a finished cover and saved as the song's cover.
//
// The filter is applied to the UNFILTERED cover (the "base") every time, never
// to a previous filtered result, so looks never stack. Which file the base is
// and how a saved look is remembered is decided by the route
// (src/app/api/cassette-studio/filter/route.ts) from the cover's key; the look
// itself rides in that key as a compact code (encodeFilter) because mf-artwork
// accepts images only — no JSON sidecar.
//
// One pipeline, three callers:
//   preview — the base downsized to ≤1080px, filtered, JPEG (the route keeps the decoded base warm)
//   save    — the base at full size (≤3000px, the cover size), filtered, JPEG
//   motion  — the moving cover grades its plate, cassette layer and title ink
//             with the same per-pixel maths (gradePixels + vignettePixels), so
//             the loop matches the still. Grain is left to the motion renderer,
//             which already draws fresh grain every frame.
//
// Every operation is either per-pixel or expressed in coordinates relative to
// the frame (vignette, grain), so the ≤1080px preview is the saved cover in
// miniature — that is the promise the editor makes ("preview == saved").
//
// Pure image maths over raw pixels plus sharp. No server-only imports —
// scripts/cover-filters-test.mjs drives it directly under Node.

import sharp from 'sharp'

// ── Settings ────────────────────────────────────────────────────────────────

export const FILTER_TONES = ['color', 'bw', 'sepia'] as const
export type FilterTone = (typeof FILTER_TONES)[number]

/**
 * A look. `preset` is a label only (which chip the client shows as selected);
 * the numbers and the tone are what is applied.
 */
export type FilterSettings = {
  preset: string
  /** −100..100, 0 = unchanged. */
  brightness: number
  /** −100..100. */
  contrast: number
  /** −100..100, −100 = fully desaturated. */
  saturation: number
  /** −100..100, <0 cooler/blue, >0 warmer/amber. */
  warmth: number
  /** 0..100, lifts the blacks: a matte film look. */
  fade: number
  /** 0..100, film grain scaled to the image and seeded, so preview == saved. */
  grain: number
  /** 0..100, darkened edges. */
  vignette: number
  tone: FilterTone
}

export const ADJUSTMENT_IDS = ['brightness', 'contrast', 'saturation', 'warmth', 'fade', 'grain', 'vignette'] as const
export type AdjustmentId = (typeof ADJUSTMENT_IDS)[number]

export type FilterAdjustment = { id: AdjustmentId; label: string; min: number; max: number }

/** The sliders, in display order. Ranges are the contract's; validation uses them. */
export const FILTER_ADJUSTMENTS: readonly FilterAdjustment[] = [
  { id: 'brightness', label: 'Brightness', min: -100, max: 100 },
  { id: 'contrast', label: 'Contrast', min: -100, max: 100 },
  { id: 'saturation', label: 'Saturation', min: -100, max: 100 },
  { id: 'warmth', label: 'Warmth', min: -100, max: 100 },
  { id: 'fade', label: 'Fade', min: 0, max: 100 },
  { id: 'grain', label: 'Grain', min: 0, max: 100 },
  { id: 'vignette', label: 'Vignette', min: 0, max: 100 },
]

export const FILTER_PRESET_IDS = ['original', 'film', 'faded', 'warm', 'cool', 'noir', 'mono', 'sepia', 'punch', 'dusk'] as const
export type FilterPresetId = (typeof FILTER_PRESET_IDS)[number]

/** "Original": every number 0, colour. Saving it resets the cover to its unfiltered base. */
export const IDENTITY_FILTER: FilterSettings = Object.freeze({
  preset: 'original', brightness: 0, contrast: 0, saturation: 0, warmth: 0, fade: 0, grain: 0, vignette: 0, tone: 'color',
})

type Look = Omit<FilterSettings, 'preset'>
const look = (v: Partial<Look>): Look => ({
  brightness: 0, contrast: 0, saturation: 0, warmth: 0, fade: 0, grain: 0, vignette: 0, tone: 'color', ...v,
})

// Tuned for what a Cassette Studio cover usually is: a night or moody scene,
// mostly shadows and mid-tones with a few practical lights. So nothing here
// crushes the shadows hard (contrast pivots at mid-grey, and most of these
// images live below it), and the colour looks lean on warmth and fade rather
// than on saturation, which turns sodium light and neon garish fast.
const PRESET_LOOKS: Record<FilterPresetId, { label: string; look: Look }> = {
  original: { label: 'Original', look: look({}) },
  film: { label: 'Film', look: look({ brightness: 4, contrast: 10, saturation: -12, warmth: 8, fade: 16, grain: 28, vignette: 22 }) },
  faded: { label: 'Faded', look: look({ brightness: 8, contrast: -20, saturation: -28, warmth: 4, fade: 40, grain: 12, vignette: 10 }) },
  warm: { label: 'Warm', look: look({ brightness: 4, contrast: 6, saturation: 6, warmth: 36, fade: 6, grain: 8, vignette: 14 }) },
  cool: { label: 'Cool', look: look({ contrast: 8, saturation: -6, warmth: -34, fade: 8, grain: 8, vignette: 16 }) },
  noir: { label: 'Noir', look: look({ brightness: -4, contrast: 46, grain: 30, vignette: 38, tone: 'bw' }) },
  mono: { label: 'Mono', look: look({ brightness: 6, contrast: -10, fade: 24, grain: 18, vignette: 12, tone: 'bw' }) },
  sepia: { label: 'Sepia', look: look({ brightness: 4, contrast: 6, fade: 18, grain: 22, vignette: 24, tone: 'sepia' }) },
  punch: { label: 'Punch', look: look({ brightness: 2, contrast: 28, saturation: 30, warmth: 4, grain: 6, vignette: 18 }) },
  dusk: { label: 'Dusk', look: look({ brightness: -6, contrast: 16, saturation: 10, warmth: -20, fade: 12, grain: 14, vignette: 34 }) },
}

export type FilterPreset = { id: FilterPresetId; label: string; settings: FilterSettings }

export const FILTER_PRESETS: readonly FilterPreset[] = FILTER_PRESET_IDS.map(id => ({
  id,
  label: PRESET_LOOKS[id].label,
  settings: { preset: id, ...PRESET_LOOKS[id].look },
}))

const isPresetId = (v: string): v is FilterPresetId => (FILTER_PRESET_IDS as readonly string[]).includes(v)
const isTone = (v: unknown): v is FilterTone => typeof v === 'string' && (FILTER_TONES as readonly string[]).includes(v)

/**
 * Validate + clamp settings that arrived from a client. Every field is
 * required; a number must be a finite JSON number (rounded, then clamped to its
 * slider's range), the tone one of the three. A preset string the server does
 * not know is kept as 'custom' — it is only a label. Anything else → null
 * (the route answers 400).
 */
export function normalizeFilter(value: unknown): FilterSettings | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (typeof v.preset !== 'string' || !isTone(v.tone)) return null
  const out: FilterSettings = { ...IDENTITY_FILTER, preset: isPresetId(v.preset) ? v.preset : 'custom', tone: v.tone }
  for (const a of FILTER_ADJUSTMENTS) {
    const n = v[a.id]
    if (typeof n !== 'number' || !Number.isFinite(n)) return null
    // `|| 0` folds −0 into 0, so the code and the JSON agree.
    out[a.id] = clamp(Math.round(n), a.min, a.max) || 0
  }
  return out
}

/** True when the look changes nothing: every number 0 and colour (the preset label is ignored). */
export function isIdentityFilter(s: FilterSettings): boolean {
  return s.tone === 'color' && ADJUSTMENT_IDS.every(id => s[id] === 0)
}

// ── The code in the key ─────────────────────────────────────────────────────
// <projectId>/finalized-<fts>-f<code>.jpg. Fixed width, lowercase base36:
//
//   '1'        format version
//   1 char     preset: index into CODE_PRESETS (0-9, a = custom)
//   1 char     tone: c | b | s
//   7 × 2      brightness, contrast, saturation, warmth, fade, grain, vignette,
//              each as (value − min) in two base36 digits
//
// 17 characters. Decoding is strict: wrong length, an unknown preset or tone
// letter or a value outside its range is malformed and refused — the server
// only ever reads codes it wrote, so there is nothing to be lenient about.

const CODE_VERSION = '1'
const CODE_PRESETS: readonly string[] = [...FILTER_PRESET_IDS, 'custom']
const TONE_CODE: Record<FilterTone, string> = { color: 'c', bw: 'b', sepia: 's' }
const CODE_TONE: Record<string, FilterTone> = { c: 'color', b: 'bw', s: 'sepia' }
export const FILTER_CODE_RE = /^1[0-9a][cbs][0-9a-z]{14}$/

/** Encode settings (normalised first) into the key code. */
export function encodeFilter(settings: FilterSettings): string {
  const s = normalizeFilter(settings) ?? IDENTITY_FILTER
  const preset = Math.max(0, CODE_PRESETS.indexOf(s.preset))
  let code = CODE_VERSION + preset.toString(36) + TONE_CODE[s.tone]
  for (const a of FILTER_ADJUSTMENTS) code += (s[a.id] - a.min).toString(36).padStart(2, '0')
  return code
}

/** Decode a key code back into settings, or null when it is not exactly a code encodeFilter writes. */
export function decodeFilter(code: unknown): FilterSettings | null {
  if (typeof code !== 'string' || !FILTER_CODE_RE.test(code)) return null
  const presetIdx = parseInt(code[1], 36)
  if (presetIdx >= CODE_PRESETS.length) return null
  const raw: Record<string, unknown> = { preset: CODE_PRESETS[presetIdx], tone: CODE_TONE[code[2]] }
  for (let i = 0; i < FILTER_ADJUSTMENTS.length; i++) {
    const a = FILTER_ADJUSTMENTS[i]
    const value = parseInt(code.slice(3 + i * 2, 5 + i * 2), 36) + a.min
    if (value > a.max) return null
    raw[a.id] = value
  }
  // Same validate + clamp as a client's settings (a no-op for a code that got
  // this far), so a decoded look can never be anything a client could not send.
  return normalizeFilter(raw)
}

// ── Pixels ──────────────────────────────────────────────────────────────────

/**
 * The per-pixel grade, in place: warmth → brightness → contrast → saturation
 * → tone → fade. RGB (3 channels) or RGBA (4 — alpha is left untouched, so a
 * cut-out cassette or the title ink keeps its edges). No vignette and no grain:
 * those depend on where the pixel is in the frame (vignettePixels, applyGrain).
 *
 *   warmth      a white-balance gain: red up and blue down (or the reverse).
 *   brightness  a gamma curve — lifts or lowers the mid-tones and leaves black
 *               and white where they are, so it never clips a highlight.
 *   contrast    an S-curve about mid-grey for positive values (steeper mids,
 *               no clipping at the ends), a straight flattening for negative.
 *   saturation  scale each channel's distance from the pixel's luma.
 *   tone        B&W sets r=g=b=luma exactly; sepia maps luma onto a warm ramp.
 *   fade        lifts black toward a matte grey and pulls white in a touch.
 */
export function gradePixels(data: Uint8Array, channels: 3 | 4, s: FilterSettings): void {
  if (isIdentityFilter(s)) return
  // Warmth, brightness and contrast act on each channel alone → one 256-entry
  // table per channel. The rest needs all three channels at once.
  const w = s.warmth / 100
  const gains = [1 + w * 0.1, 1 + w * 0.02, 1 - w * 0.12]
  const gamma = Math.pow(2, -(s.brightness / 100) * 0.85)
  const c = s.contrast / 100
  const luts = gains.map(gain => {
    const lut = new Float32Array(256)
    for (let v = 0; v < 256; v++) {
      let t = clamp((v / 255) * gain, 0, 1)
      t = Math.pow(t, gamma)
      if (c > 0) {
        const sc = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)
        t += (sc - t) * c
      } else if (c < 0) {
        t = 0.5 + (t - 0.5) * (1 + c * 0.6)
      }
      lut[v] = t * 255
    }
    return lut
  })
  const [lr, lg, lb] = luts
  const sat = s.saturation >= 0 ? 1 + (s.saturation / 100) * 0.8 : 1 + s.saturation / 100
  const f = s.fade / 100
  const lo = f * 0.24 * 255
  const span = (1 - f * 0.05) - f * 0.24
  const tone = s.tone

  for (let i = 0; i < data.length; i += channels) {
    let r = lr[data[i]], g = lg[data[i + 1]], b = lb[data[i + 2]]
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b
    if (tone === 'bw') {
      r = g = b = L
    } else if (tone === 'sepia') {
      const t = L / 255
      r = (0.03 + 0.99 * t) * 255
      g = (0.012 + 0.91 * t) * 255
      b = 0.72 * t * 255
    } else if (sat !== 1) {
      r = L + (r - L) * sat
      g = L + (g - L) * sat
      b = L + (b - L) * sat
    }
    if (f > 0) {
      r = lo + clamp(r, 0, 255) * span
      g = lo + clamp(g, 0, 255) * span
      b = lo + clamp(b, 0, 255) * span
    }
    data[i] = clamp8(r)
    data[i + 1] = clamp8(g)
    data[i + 2] = clamp8(b)
  }
}

/**
 * Darken toward the edges, in place. `amount` 0..100; at 100 the corners lose
 * 65% of their light and the middle of each edge about a quarter. Expressed in
 * coordinates relative to the frame, so a preview and the full-size cover get
 * the same vignette. Alpha (channel 4) untouched.
 */
export function vignettePixels(data: Uint8Array, width: number, height: number, channels: 3 | 4, amount: number): void {
  const strength = clamp(amount, 0, 100) / 100 * 0.65
  if (strength <= 0) return
  const cx = (width - 1) / 2, cy = (height - 1) / 2
  const maxR2 = cx * cx + cy * cy || 1
  for (let y = 0; y < height; y++) {
    const dy2 = (y - cy) * (y - cy)
    let i = y * width * channels
    for (let x = 0; x < width; x++, i += channels) {
      const r2 = ((x - cx) * (x - cx) + dy2) / maxR2   // 0 at the centre, 1 at the corners
      const k = 1 - strength * r2 * Math.sqrt(r2)
      data[i] = clamp8(data[i] * k)
      data[i + 1] = clamp8(data[i + 1] * k)
      data[i + 2] = clamp8(data[i + 2] * k)
    }
  }
}

/**
 * Grain cells along the image's long side. The noise is drawn on this fixed
 * grid and resized to the image, so its pattern and its size RELATIVE to the
 * picture are the same at 1080px and at 3000px (≈3px soft grains on a full
 * cover) — the preview shows the grain the saved cover will have.
 */
export const GRAIN_GRID = 1000

/** The grain pattern's seed: the grain setting alone, so moving any other slider never re-rolls it. */
export function grainSeed(s: FilterSettings): number {
  return fnv1a(`cover-grain:${s.grain}`)
}

/**
 * Add monochrome film grain, in place (the same noise on r, g and b, so a B&W
 * look stays exactly grey). Stronger in shadows and mid-tones than in
 * highlights, as on film. Deterministic for a given seed and image size.
 */
export async function applyGrain(data: Uint8Array, width: number, height: number, channels: 3 | 4, amount: number, seed: number): Promise<void> {
  const sigma = clamp(amount, 0, 100) / 100 * 22
  if (sigma <= 0 || width < 1 || height < 1) return
  const long = Math.max(width, height)
  const gw = Math.max(1, Math.round(GRAIN_GRID * width / long))
  const gh = Math.max(1, Math.round(GRAIN_GRID * height / long))
  const next = rng(seed)
  const cells = Buffer.alloc(gw * gh)
  // Sum of three uniforms ≈ gaussian (sd 0.5), stored around 128.
  for (let i = 0; i < cells.length; i++) cells[i] = clamp8(128 + (next() + next() + next() - 1.5) * 80)
  const field = await sharp(cells, { raw: { width: gw, height: gh, channels: 1 } })
    .resize(width, height, { fit: 'fill', kernel: 'cubic' })
    .raw()
    .toBuffer()
  for (let p = 0, i = 0; p < width * height; p++, i += channels) {
    const r = data[i], g = data[i + 1], b = data[i + 2]
    const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
    const n = ((field[p] - 128) / 40) * sigma * (0.35 + 0.65 * (1 - luma))
    data[i] = clamp8(r + n)
    data[i + 1] = clamp8(g + n)
    data[i + 2] = clamp8(b + n)
  }
}

// ── Images ──────────────────────────────────────────────────────────────────

/** Raw sRGB pixels, 3 channels. */
export type RawImage = { data: Buffer; width: number; height: number }

/**
 * Decode an image for filtering: EXIF rotation baked in, any alpha flattened
 * onto black, always 3-channel sRGB (a greyscale JPEG comes back as RGB), and
 * optionally capped to `maxSide` on its long edge (never enlarged).
 */
export async function decodeForFilter(input: Buffer, maxSide?: number): Promise<RawImage> {
  let img = sharp(input).rotate()
  if (maxSide) img = img.resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
  const { data, info } = await img.flatten({ background: '#000000' }).toColourspace('srgb').raw().toBuffer({ resolveWithObject: true })
  if (info.channels === 3) return { data, width: info.width, height: info.height }
  // Belt and braces: expand whatever came back to RGB.
  const n = info.width * info.height
  const rgb = Buffer.alloc(n * 3)
  for (let p = 0; p < n; p++) {
    const s = p * info.channels
    rgb[p * 3] = data[s]
    rgb[p * 3 + 1] = data[info.channels >= 3 ? s + 1 : s]
    rgb[p * 3 + 2] = data[info.channels >= 3 ? s + 2 : s]
  }
  return { data: rgb, width: info.width, height: info.height }
}

/**
 * The look applied to decoded pixels → JPEG. Never mutates `img` (the preview
 * cache hands the same decoded base to every request).
 */
export async function filterRawToJpeg(img: RawImage, s: FilterSettings, opts: { quality?: number } = {}): Promise<Buffer> {
  const data = Buffer.from(img.data)
  gradePixels(data, 3, s)
  vignettePixels(data, img.width, img.height, 3, s.vignette)
  await applyGrain(data, img.width, img.height, 3, s.grain, grainSeed(s))
  return sharp(data, { raw: { width: img.width, height: img.height, channels: 3 } })
    .jpeg({ quality: clamp(Math.round(opts.quality ?? 92), 50, 100), chromaSubsampling: '4:2:0' })
    .toBuffer()
}

/**
 * Apply a look to an encoded image (jpeg/png/webp) and return JPEG bytes.
 * `maxSide` caps the long edge first (the preview passes 1080).
 */
export async function applyFilter(input: Buffer, s: FilterSettings, opts: { maxSide?: number; quality?: number } = {}): Promise<Buffer> {
  return filterRawToJpeg(await decodeForFilter(input, opts.maxSide), s, { quality: opts.quality })
}

/**
 * The moving cover's half: grade an encoded layer with the per-pixel maths
 * only (no grain — the motion renderer draws its own every frame). 'png' keeps
 * the alpha channel (cassette layer, title ink); 'jpeg' is for the plate, and
 * `vignette: true` darkens its edges as the still's are.
 */
export async function gradeEncoded(
  input: Buffer,
  s: FilterSettings,
  opts: { format: 'jpeg' | 'png'; vignette?: boolean; quality?: number },
): Promise<Buffer> {
  const channels = opts.format === 'png' ? 4 : 3
  const base = sharp(input)
  const { data, info } = await (channels === 4 ? base.ensureAlpha() : base.flatten({ background: '#000000' }))
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (info.channels !== channels) throw new Error(`cover-filters: expected ${channels} channels, got ${info.channels}`)
  gradePixels(data, channels, s)
  if (opts.vignette) vignettePixels(data, info.width, info.height, channels, s.vignette)
  const out = sharp(data, { raw: { width: info.width, height: info.height, channels } })
  return opts.format === 'png'
    ? out.png().toBuffer()
    : out.jpeg({ quality: clamp(Math.round(opts.quality ?? 90), 50, 100) }).toBuffer()
}

// ── helpers ────────────────────────────────────────────────────────────────

// mulberry32 — the same tiny seedable PRNG as film-finish / cassette-studio.
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function clamp(v: number, lo: number, hi: number) { return v < lo ? lo : v > hi ? hi : v }
function clamp8(v: number) { return v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0 }
