// Handwriting glyph bank — "type in your own handwriting".
//
// The artist's lettering photos are cut into single letters, each letter is
// told what it is (from the text the artist types alongside the photo), and
// the letters are kept as a bank. A title typed later is laid out from those
// letters: scaled to one common x-height, set on a baseline, spaced the way
// the pen spaced them, with a little jitter and a different sample of a
// letter each time it repeats so a word never looks stamped. No font, no AI,
// no synthesis — every stroke in a typed title is a stroke the artist drew.
//
// Pure image maths over raw pixels plus sharp. No server-only imports —
// scripts/handwriting-glyphs-test.mjs drives it directly under Node.
//
// ── Storage ─────────────────────────────────────────────────────────────────
// A sample is one PNG in the owner's studio folder (white RGB, ink alpha, the
// glyph's tight box). The bucket takes images only, so what the compositor
// must know rides in the KEY:
//
//   studio/<userId>/glyph-<cp>-<unit>-<base>-<ts>.png
//     cp    the character as a 4-digit hex code point (0021..007e)
//     unit  the x-height of the line it came from, in the PNG's own pixels —
//           what every sample is scaled by so letters from different photos
//           come out the same size
//     base  the baseline, in pixels down from the PNG's top edge (an o sits
//           on it, a g hangs below it, an apostrophe floats above it)
//     ts    when it was taught
//
// Parsed back with parseGlyphKey, which pins the shape (and the owner, via
// the prefix) before a key is ever read.

import sharp, { type OverlayOptions } from 'sharp'
import { components, cropLettering, extractHandwriting, type Lettering } from './handwriting.ts'

// ── Keys ────────────────────────────────────────────────────────────────────

export const GLYPH_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.,'!?&-:;()/+#@*"
const GLYPH_SET = new Set(GLYPH_CHARS)

/** Can this character be taught and typed? (Space is laid out, not drawn.) */
export function isGlyphChar(ch: string): boolean {
  return ch.length === 1 && GLYPH_SET.has(ch)
}

export type GlyphKey = { char: string; unit: number; base: number; ts: string }

const GLYPH_LEAF = /^glyph-([0-9a-f]{4})-([1-9]\d{0,3})-(0|[1-9]\d{0,3})-(\d{10,16})\.png$/

export function glyphKey(userId: string, char: string, unit: number, base: number, ts: string | number): string {
  if (!isGlyphChar(char)) throw new Error(`not a glyph character: ${JSON.stringify(char)}`)
  const cp = char.codePointAt(0)!.toString(16).padStart(4, '0')
  const u = Math.max(1, Math.min(9999, Math.round(unit)))
  const b = Math.max(0, Math.min(9999, Math.round(base)))
  return `studio/${userId}/glyph-${cp}-${u}-${b}-${ts}.png`
}

/** Parse one of THIS user's glyph keys, or null for any other key. */
export function parseGlyphKey(key: unknown, userId: string): GlyphKey | null {
  if (typeof key !== 'string') return null
  const prefix = `studio/${userId}/`
  if (!key.startsWith(prefix)) return null
  const m = GLYPH_LEAF.exec(key.slice(prefix.length))
  if (!m) return null
  const char = String.fromCodePoint(parseInt(m[1], 16))
  if (!isGlyphChar(char)) return null
  return { char, unit: Number(m[2]), base: Number(m[3]), ts: m[4] }
}

// ── Segmentation ────────────────────────────────────────────────────────────

export type GlyphBox = { x0: number; y0: number; x1: number; y1: number }
export type GlyphRow = { glyphs: GlyphBox[]; y0: number; y1: number }

/** Lines of writing in an ink alpha field, each a left-to-right list of letter boxes. */
export function segmentGlyphs(alpha: Uint8Array, W: number, H: number): GlyphRow[] {
  const mask = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) mask[i] = alpha[i] > 96 ? 1 : 0
  const { areas, boxes } = components(mask, W, H)
  type Blob = GlyphBox & { area: number; alive: boolean }
  const blobs: Blob[] = []
  for (let k = 0; k < areas.length; k++) {
    if (areas[k] < 4) continue
    const b = boxes[k]
    blobs.push({ x0: b[0], y0: b[1], x1: b[2], y1: b[3], area: areas[k], alive: true })
  }
  if (blobs.length === 0) return []

  // Typical letter height: the median height of the bigger half of the blobs.
  const bigHalf = [...blobs].sort((a, b) => b.area - a.area).slice(0, Math.max(1, Math.ceil(blobs.length / 2)))
  const typical = median(bigHalf.map(b => b.y1 - b.y0 + 1))

  // Satellites: a mark much shorter than a letter (an i-dot, the dot of a j,
  // the halves of a colon, a broken stroke) joins the piece it sits over or
  // under when their columns overlap and the gap between them is small.
  let changed = true
  while (changed) {
    changed = false
    const order = blobs.map((b, i) => i).filter(i => blobs[i].alive).sort((a, b) => blobs[a].area - blobs[b].area)
    for (const i of order) {
      const s = blobs[i]
      if (!s.alive || s.y1 - s.y0 + 1 >= typical * 0.55) continue
      let best = -1, bestScore = 0
      for (let j = 0; j < blobs.length; j++) {
        const t = blobs[j]
        if (j === i || !t.alive) continue
        const overlap = Math.min(s.x1, t.x1) - Math.max(s.x0, t.x0) + 1
        if (overlap < (s.x1 - s.x0 + 1) * 0.5) continue
        const gap = s.y0 > t.y1 ? s.y0 - t.y1 : t.y0 > s.y1 ? t.y0 - s.y1 : 0
        if (gap > typical * 0.6) continue
        const score = overlap / (gap + 1)
        if (score > bestScore) { bestScore = score; best = j }
      }
      if (best < 0) continue
      const t = blobs[best]
      t.x0 = Math.min(t.x0, s.x0); t.y0 = Math.min(t.y0, s.y0)
      t.x1 = Math.max(t.x1, s.x1); t.y1 = Math.max(t.y1, s.y1)
      t.area += s.area
      s.alive = false
      changed = true
    }
  }

  // Rows: letters whose centres sit within most of a letter-height of the
  // row's running centre belong to it.
  const live = blobs.filter(b => b.alive).sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1))
  const rows: { glyphs: Blob[]; cys: number[] }[] = []
  for (const g of live) {
    const cy = (g.y0 + g.y1) / 2
    const h = g.y1 - g.y0 + 1
    let home: typeof rows[number] | null = null
    for (const row of rows) {
      const rh = median(row.glyphs.map(b => b.y1 - b.y0 + 1))
      if (Math.abs(cy - mean(row.cys)) <= 0.7 * Math.max(rh, h, typical * 0.6)) { home = row; break }
    }
    if (home) { home.glyphs.push(g); home.cys.push(cy) }
    else rows.push({ glyphs: [g], cys: [cy] })
  }
  return rows
    .map(r => {
      const glyphs = r.glyphs.sort((a, b) => a.x0 - b.x0).map(({ x0, y0, x1, y1 }) => ({ x0, y0, x1, y1 }))
      return { glyphs, y0: Math.min(...glyphs.map(g => g.y0)), y1: Math.max(...glyphs.map(g => g.y1)) }
    })
    .sort((a, b) => a.y0 - b.y0)
}

// ── Labelling ───────────────────────────────────────────────────────────────

export type LabelledGlyph = GlyphBox & { char: string; unit: number; base: number }

const X_HEIGHT_CHARS = new Set('acemnorsuvwxz')
const CAP_HEIGHT_CHARS = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789bdfhklt')
const DESCENDERS = new Set('gjpqy,;()/')
const FLOATERS = new Set("'*\"")

/** The lines of a taught text: trimmed, blank lines dropped, runs of spaces collapsed. */
export function textLines(text: string): string[] {
  return text.split(/\r?\n/).map(l => l.trim().replace(/\s+/g, ' ')).filter(l => l.length > 0)
}

export type LabelResult =
  | { ok: true; glyphs: LabelledGlyph[] }
  | { ok: false; error: string; rows: { found: number; expected: number; text: string }[] }

/**
 * Match the rows of writing to the typed text, line by line, letter by letter.
 * Every line must have exactly as many shapes as it has non-space
 * characters, or the artist is told which line disagreed and by how much —
 * guessing which shape is which letter would teach wrong letters silently.
 * Each row's x-height (unit) and baseline come from the letters that define
 * them (x-height letters, non-descending letters), with fallbacks for rows
 * that have none.
 */
export function labelGlyphs(rows: GlyphRow[], text: string): LabelResult {
  const lines = textLines(text)
  const summary = (): { found: number; expected: number; text: string }[] =>
    Array.from({ length: Math.max(rows.length, lines.length) }, (_, i) => ({
      found: rows[i]?.glyphs.length ?? 0,
      expected: lines[i] ? lines[i].replace(/ /g, '').length : 0,
      text: lines[i] ?? '',
    }))
  if (lines.length === 0) return { ok: false, error: 'Type what the writing says.', rows: summary() }
  for (const line of lines) {
    const bad = [...line.replace(/ /g, '')].filter(c => !isGlyphChar(c))
    if (bad.length) return { ok: false, error: `Can't teach ${bad.map(c => `"${c}"`).join(', ')} — letters, digits and basic punctuation only.`, rows: summary() }
  }
  if (rows.length !== lines.length) {
    return {
      ok: false,
      error: `I see ${rows.length} line${rows.length === 1 ? '' : 's'} of writing but the text has ${lines.length}. Write each line on its own, with clear space between lines.`,
      rows: summary(),
    }
  }
  const out: LabelledGlyph[] = []
  for (let r = 0; r < rows.length; r++) {
    const chars = [...lines[r].replace(/ /g, '')]
    const row = rows[r]
    if (chars.length !== row.glyphs.length) {
      return {
        ok: false,
        error: `Line ${r + 1}: I found ${row.glyphs.length} shape${row.glyphs.length === 1 ? '' : 's'} but "${lines[r]}" has ${chars.length} letters. Leave a gap between every letter (no joined-up writing) and keep dots close to their letter.`,
        rows: summary(),
      }
    }
    const labelled = row.glyphs.map((g, i) => ({ ...g, char: chars[i] }))
    const heights = (pick: (c: string) => boolean) => labelled.filter(g => pick(g.char)).map(g => g.y1 - g.y0 + 1)
    const xh = heights(c => X_HEIGHT_CHARS.has(c))
    const ch = heights(c => CAP_HEIGHT_CHARS.has(c))
    const unit = xh.length ? median(xh) : ch.length ? median(ch) / 1.45 : median(heights(() => true)) / 1.2
    const sitters = labelled.filter(g => !DESCENDERS.has(g.char) && !FLOATERS.has(g.char)).map(g => g.y1)
    const baseline = sitters.length ? median(sitters) : median(labelled.map(g => g.y1))
    for (const g of labelled) {
      out.push({ ...g, unit: Math.max(1, Math.round(unit)), base: Math.max(0, Math.round(baseline - g.y0)) })
    }
  }
  return { ok: true, glyphs: out }
}

/** Cut one labelled glyph out of an alpha field as a white-RGB PNG. */
export async function glyphPng(alpha: Uint8Array, W: number, box: GlyphBox): Promise<Buffer> {
  const w = box.x1 - box.x0 + 1, h = box.y1 - box.y0 + 1
  const rgba = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      rgba[o] = 255; rgba[o + 1] = 255; rgba[o + 2] = 255
      rgba[o + 3] = alpha[(y + box.y0) * W + (x + box.x0)]
    }
  }
  return sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer()
}

/** The ink alpha of a lettering PNG (white RGB + alpha), as raw bytes. */
export async function letteringAlpha(png: Buffer): Promise<{ alpha: Uint8Array; width: number; height: number }> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const n = info.width * info.height
  const alpha = new Uint8Array(n)
  for (let i = 0; i < n; i++) alpha[i] = data[i * 4 + 3]
  return { alpha, width: info.width, height: info.height }
}

export type TaughtGlyph = { char: string; unit: number; base: number; width: number; height: number; png: Buffer }

/**
 * Teach from a lettering (an ink alpha PNG — a photo already lifted by
 * extractHandwriting, or one lifted here from `photo`) and the text it says.
 */
export async function teachGlyphs(source: { photo: Buffer } | { lettering: Buffer }, text: string): Promise<
  | { ok: true; glyphs: TaughtGlyph[] }
  | { ok: false; error: string; rows: { found: number; expected: number; text: string }[] }
> {
  const png = 'photo' in source ? (await extractHandwriting(source.photo)).png : source.lettering
  const { alpha, width, height } = await letteringAlpha(png)
  const rows = segmentGlyphs(alpha, width, height)
  const labelled = labelGlyphs(rows, text)
  if (!labelled.ok) return labelled
  const glyphs: TaughtGlyph[] = []
  for (const g of labelled.glyphs) {
    glyphs.push({
      char: g.char, unit: g.unit, base: g.base,
      width: g.x1 - g.x0 + 1, height: g.y1 - g.y0 + 1,
      png: await glyphPng(alpha, width, g),
    })
  }
  return { ok: true, glyphs }
}

// ── Composition ─────────────────────────────────────────────────────────────

export type GlyphSample = { char: string; unit: number; base: number; png: Buffer }
export type ComposeAlign = 'left' | 'center' | 'right'

/** Longest title that can be typed, and the most lines. */
export const MAX_TYPED_CHARS = 60
export const MAX_TYPED_LINES = 3

/** Common x-height every sample is scaled to in the composed lettering, px. */
const UNIT = 110

export type ComposeResult =
  | { ok: true; lettering: Lettering }
  | { ok: false; missing: string[] }

/**
 * Set `text` in the artist's hand from `bank`. A character with no sample of
 * its own borrows the other case (a capital written once serves as both);
 * anything still missing is reported instead of guessed. Deterministic for a
 * given seed: the same seed picks the same samples and the same jitter.
 */
export async function composeHandwriting(
  text: string, bank: GlyphSample[], opts: { align?: ComposeAlign; seed?: number } = {},
): Promise<ComposeResult> {
  const lines = textLines(text).slice(0, MAX_TYPED_LINES)
  const align = opts.align ?? 'center'
  const r = rng(opts.seed ?? 1)
  const byChar = new Map<string, GlyphSample[]>()
  for (const s of bank) {
    if (!byChar.has(s.char)) byChar.set(s.char, [])
    byChar.get(s.char)!.push(s)
  }
  const samplesFor = (c: string): GlyphSample[] | null => {
    const own = byChar.get(c)
    if (own?.length) return own
    const swapped = c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()
    const other = byChar.get(swapped)
    return other?.length ? other : null
  }
  const missing = new Set<string>()
  for (const line of lines) for (const c of line) if (c !== ' ' && !samplesFor(c)) missing.add(c)
  if (missing.size) return { ok: false, missing: [...missing] }
  if (lines.length === 0) return { ok: false, missing: [] }

  // Lay each glyph out: scale to the common x-height, sit it on the line's
  // baseline, advance by its width plus a pen-gap, tilt it a touch.
  type Placed = { png: Buffer; x: number; y: number; w: number; h: number }
  const LINE = UNIT * 2.5
  const placed: Placed[] = []
  const lineWidths: number[] = []
  const lineStarts: number[] = []
  const lastPick = new Map<string, number>()
  const cache = new Map<string, { width: number; height: number }>()
  const sizeOf = async (s: GlyphSample) => {
    const k = `${s.char}:${s.unit}:${s.base}:${s.png.length}`
    let m = cache.get(k)
    if (!m) { const meta = await sharp(s.png).metadata(); m = { width: meta.width ?? 1, height: meta.height ?? 1 }; cache.set(k, m) }
    return m
  }
  for (let li = 0; li < lines.length; li++) {
    const baseline = UNIT * 1.7 + li * LINE
    let x = 0
    lineStarts.push(placed.length)
    for (const c of lines[li]) {
      if (c === ' ') { x += UNIT * 0.7; continue }
      const samples = samplesFor(c)!
      // A repeated letter prefers a sample it did not use last time.
      let pick = Math.floor(r() * samples.length)
      if (samples.length > 1 && lastPick.get(c) === pick) pick = (pick + 1 + Math.floor(r() * (samples.length - 1))) % samples.length
      lastPick.set(c, pick)
      const s = samples[pick]
      const size = await sizeOf(s)
      const k = UNIT / s.unit
      const w = Math.max(1, Math.round(size.width * k)), h = Math.max(1, Math.round(size.height * k))
      const tilt = (r() - 0.5) * 4
      let png = await sharp(s.png).resize(w, h, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer()
      let pw = w, ph = h
      if (Math.abs(tilt) > 0.4) {
        png = await sharp(png).rotate(tilt, { background: { r: 255, g: 255, b: 255, alpha: 0 } }).png().toBuffer()
        const meta = await sharp(png).metadata()
        pw = meta.width ?? w; ph = meta.height ?? h
      }
      const baseJitter = (r() - 0.5) * UNIT * 0.08
      const y = baseline - s.base * k + baseJitter - (ph - h) / 2
      placed.push({ png, x: x - (pw - w) / 2, y, w: pw, h: ph })
      x += w + UNIT * (0.1 + r() * 0.08)
    }
    lineWidths.push(x)
  }
  lineStarts.push(placed.length)

  const maxW = Math.max(...lineWidths)
  const pad = UNIT * 0.5
  const W = Math.ceil(maxW + pad * 2)
  const H = Math.ceil(lines.length * LINE + UNIT)
  const layers: OverlayOptions[] = []
  for (let li = 0; li < lines.length; li++) {
    const shift = align === 'left' ? 0 : align === 'right' ? maxW - lineWidths[li] : (maxW - lineWidths[li]) / 2
    for (let i = lineStarts[li]; i < lineStarts[li + 1]; i++) {
      const p = placed[i]
      layers.push({ input: p.png, left: Math.round(p.x + pad + shift), top: Math.round(p.y) })
    }
  }
  const canvas = sharp({ create: { width: W, height: H, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } } })
  const { data, info } = await canvas.composite(layers).raw().toBuffer({ resolveWithObject: true })
  const n = info.width * info.height
  const alpha = new Uint8Array(n)
  for (let i = 0; i < n; i++) alpha[i] = data[i * 4 + 3]
  const lettering = await cropLettering(alpha, info.width, info.height, UNIT * 0.22)
  return { ok: true, lettering }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function median(v: number[]): number {
  if (v.length === 0) return 0
  const s = [...v].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
function mean(v: number[]): number { return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0 }

// mulberry32, the same tiny seedable PRNG as cassette-studio.ts.
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
