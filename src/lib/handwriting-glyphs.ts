// Handwriting glyph bank — "type in your own handwriting".
//
// The artist's lettering photos are cut into single letters, each letter is
// told what it is (from the text the artist types alongside the photo), and
// the letters are kept as a bank. A title typed later is set from those
// letters the way a sign-writer would set it: every capital the same height,
// all of them standing on one level line, drawn with one pen weight
// (handwriting-pen.ts — a fat marker's letters are traced finer, never
// redrawn) and spaced by the white between the shapes rather than by their
// boxes. A different sample of a letter is used each time it repeats, so a
// word never looks stamped. No font, no AI, no synthesis — every letter in a
// typed title is the shape the artist drew.
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

import sharp from 'sharp'
import { components, cropLettering, extractHandwriting, type Lettering } from './handwriting.ts'
import { cropField, insetFor, PEN_SCALE, repen, strokeWidthOf, type Field } from './handwriting-pen.ts'

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
  // row's running centre belong to it. A hand-held photo's lines slope a
  // little, and a long sloping line (a signature, a row of letters) would be
  // cut into pieces, so the slope that lines the centres up best is taken
  // out of every centre first (the boxes themselves are left as written).
  // Rules: a stroke far wider than it is tall and well under a letter's
  // height (a frame edge, an underline, a table edge) is not writing.
  const live = blobs.filter(b => b.alive && !((b.x1 - b.x0 + 1) >= 8 * (b.y1 - b.y0 + 1) && (b.y1 - b.y0 + 1) < typical * 0.6))
  if (live.length === 0) return []
  const slope = lineSlope(live, W, typical)
  const level = (b: GlyphBox): number => (b.y0 + b.y1) / 2 - slope * ((b.x0 + b.x1) / 2 - W / 2)
  live.sort((a, b) => level(a) - level(b))
  const rows: { glyphs: Blob[]; cys: number[] }[] = []
  for (const g of live) {
    const cy = level(g)
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

/**
 * The slope (dy/dx) of the lines of writing: the one, within ±12°, that puts
 * the most pairs of shape centres within a third of a letter height of each
 * other once it is taken out. Level writing gives 0; ties go to the smaller
 * tilt.
 */
function lineSlope(blobs: GlyphBox[], W: number, typical: number): number {
  if (blobs.length < 4) return 0
  const cx = blobs.map(b => (b.x0 + b.x1) / 2 - W / 2)
  const cy = blobs.map(b => (b.y0 + b.y1) / 2)
  const near = typical * 0.35
  let best = 0, bestDeg = 0, bestScore = -1
  for (let deg = -12; deg <= 12; deg += 0.25) {
    const s = Math.tan(deg * Math.PI / 180)
    const ys = cx.map((x, i) => cy[i] - s * x).sort((a, b) => a - b)
    let score = 0, j = 0
    for (let i = 0; i < ys.length; i++) {
      while (ys[i] - ys[j] > near) j++
      score += i - j
    }
    if (score > bestScore || (score === bestScore && Math.abs(deg) < Math.abs(bestDeg))) { bestScore = score; best = s; bestDeg = deg }
  }
  return best
}

// ── Labelling ───────────────────────────────────────────────────────────────

export type LabelledGlyph = GlyphBox & { char: string; unit: number; base: number }

const X_HEIGHT_CHARS = new Set('acemnorsuvwxz')
const CAP_HEIGHT_CHARS = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789bdfhklt')
/** Capitals and digits: each is its own measure of the cap height (see labelGlyphs). */
const CAPITALS = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')
const DESCENDERS = new Set('gjpqy,;()/')
const FLOATERS = new Set("'*\"")

/** Cap height over x-height, the proportion every sample's `unit` assumes. */
export const CAP_OVER_X = 1.45

/**
 * A straight line through points that a few strays cannot pull off course
 * (Theil–Sen: the median of the slopes between every pair, then the median
 * height). A row of letters has one or two that hang below the line — a J, a
 * Q's tail, the artist's looped Y — and the line must run under the others.
 */
export function robustLine(xs: number[], ys: number[]): (x: number) => number {
  const n = Math.min(xs.length, ys.length)
  if (n === 0) return () => 0
  const slopes: number[] = []
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (xs[j] !== xs[i]) slopes.push((ys[j] - ys[i]) / (xs[j] - xs[i]))
  const slope = n >= 3 && slopes.length ? median(slopes) : 0
  const level = median(Array.from({ length: n }, (_, i) => ys[i] - slope * xs[i]))
  return (x: number) => level + slope * x
}

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
 * Each row's x-height (unit) comes from the letters that define it (x-height
 * letters, else capitals), and its baseline is a LINE fitted under the
 * letters (robustLine) — handwriting climbs and drops across a page, and one
 * level baseline for a sloping row would hang every letter at a different
 * height once they are set side by side.
 *
 * Capitals and digits go further: each is its own measure. A capital that
 * sits on the line is scaled by its OWN height and stood on its OWN foot, so
 * a C written a little smaller than the D beside it comes out the same
 * height on the same line. One that hangs below the line (a J, a looped Y)
 * keeps its tail: it is measured from the line up.
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
    const unit = xh.length ? median(xh) : ch.length ? median(ch) / CAP_OVER_X : median(heights(() => true)) / 1.2
    const mid = (g: GlyphBox) => (g.x0 + g.x1) / 2
    let sitters = labelled.filter(g => !DESCENDERS.has(g.char) && !FLOATERS.has(g.char))
    if (sitters.length === 0) sitters = labelled
    const foot = robustLine(sitters.map(mid), sitters.map(g => g.y1))
    const cap = unit * CAP_OVER_X
    for (const g of labelled) {
      const line = foot(mid(g))
      const h = g.y1 - g.y0 + 1
      let u = unit, base = line - g.y0
      if (CAPITALS.has(g.char)) {
        // Hangs below the line by more than a seventh of a capital → it has a tail.
        const hangs = g.y1 - line > cap * 0.14
        const own = hangs ? line - g.y0 : h
        if (!hangs) base = h
        // Its own height is its measure, unless it is no capital's height at all (a stray size).
        if (own >= cap * 0.7 && own <= cap * 1.4) u = own / CAP_OVER_X
      }
      out.push({ ...g, unit: Math.max(1, Math.round(u)), base: Math.max(0, Math.round(base)) })
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

/**
 * The pen a title is set with: the stroke as a share of the capital height.
 * 'marker' leaves every letter exactly as it was written.
 */
export const PEN_STYLES = ['fine', 'medium', 'bold', 'marker'] as const
export type PenStyle = (typeof PEN_STYLES)[number]
const PEN_RATIO: Record<Exclude<PenStyle, 'marker'>, number> = { fine: 1 / 10.5, medium: 1 / 7.8, bold: 1 / 6.2 }
export function isPenStyle(v: unknown): v is PenStyle {
  return typeof v === 'string' && (PEN_STYLES as readonly string[]).includes(v)
}

/** Longest title that can be typed, and the most lines. */
export const MAX_TYPED_CHARS = 60
export const MAX_TYPED_LINES = 3

/** Height every capital is drawn at in the composed lettering, px. */
export const CAP = 168
/** Baseline to baseline of a stacked title. */
const LEADING = CAP * 1.42
/** The white a letter keeps to its neighbour when both sides are straight (H next to I). */
const TRACK = CAP * 0.17
/** How far into a letter's open side (under a T's arm, inside a C) its neighbour is let in. */
const DEPTH = CAP * 0.3
/** How much of that openness is taken up by moving the letters together. */
const KERN = 0.8
/** Two letters never come closer than this, on any line of the pen. */
const CLEAR = CAP * 0.08
/** The gap between words. */
const WORD = CAP * 0.58

export type ComposeResult =
  | {
      ok: true
      lettering: Lettering
      /** Height of a capital and width of the pen stroke, in the lettering's own pixels. */
      cap: number
      stroke: number
    }
  | { ok: false; missing: string[] }

/** One letter ready to be set: its ink at the composed size and where its baseline is. */
type SetGlyph = {
  alpha: Uint8Array
  width: number
  height: number
  /** Baseline, px down from the glyph's top. */
  base: number
  /** Per row of the cap band (0 = cap line … CAP-1 = just above the baseline): the first and last ink column, or -1. */
  left: Int16Array
  right: Int16Array
  stroke: number
}

/** Scale an alpha field (lanczos). Sharp widens a one-channel image to RGB unless told otherwise: the result is read back as one channel. */
export async function resizeField(field: Field, width: number, height: number): Promise<Field> {
  const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height))
  const { data, info } = await sharp(Buffer.from(field.alpha.buffer, field.alpha.byteOffset, field.alpha.length), {
    raw: { width: field.width, height: field.height, channels: 1 },
  }).resize(w, h, { fit: 'fill', kernel: 'lanczos3' }).toColourspace('b-w').raw().toBuffer({ resolveWithObject: true })
  const alpha = new Uint8Array(w * h)
  const c = info.channels
  for (let i = 0; i < w * h; i++) alpha[i] = data[i * c]
  return { alpha, width: w, height: h }
}

/**
 * A sample as it is set: traced with the pen (handwriting-pen.ts), scaled so
 * a capital is exactly CAP tall, with the profiles the spacing reads.
 */
async function prepareGlyph(sample: GlyphSample, pen: PenStyle): Promise<SetGlyph | null> {
  const { alpha, width, height } = await letteringAlpha(sample.png)
  const field: Field = { alpha, width, height }
  const capNat = sample.unit * CAP_OVER_X
  const natural = strokeWidthOf(field)
  if (!natural) return null
  let inset = 0
  if (pen !== 'marker') {
    const ratio = PEN_RATIO[pen]
    // A pen already within a tenth of the weight asked for is left as it is.
    if (Math.abs(natural / capNat - ratio) > ratio * 0.1) inset = insetFor(natural, capNat, ratio)
  }
  // Tracing finer must never change what the letter IS: if it comes apart, or
  // the wall of a counter gives way (a 6 becoming a hook), less is taken off
  // until it holds — and nothing at all if it never does.
  const before = shapeOf(field, natural)
  let drawn = repen(field, inset, { stroke: natural, hi: true })
  for (let tries = 0; inset > 0 && tries < 3; tries++) {
    const after = shapeOf(drawn.field, natural * PEN_SCALE)
    if (after.parts <= before.parts && after.holes >= before.holes) break
    inset = tries === 2 ? 0 : inset * 0.6
    drawn = repen(field, inset, { stroke: natural, hi: true })
  }
  const ink = cropField(drawn.field)
  if (!ink) return null
  // Tracing finer takes the same off every edge: the letter is that much
  // shorter at the top and the foot, and its baseline rises with the foot.
  const capHi = Math.max(1, (capNat - 2 * drawn.inset) * PEN_SCALE)
  const baseHi = (sample.base - drawn.inset) * PEN_SCALE - ink.top
  const k = CAP / capHi
  const set = await resizeField(ink, ink.width * k, ink.height * k)
  const base = baseHi * k
  const left = new Int16Array(CAP).fill(-1), right = new Int16Array(CAP).fill(-1)
  const top = Math.round(base) - CAP // glyph row of the cap line
  for (let r = 0; r < CAP; r++) {
    const y = top + r
    if (y < 0 || y >= set.height) continue
    const row = y * set.width
    for (let x = 0; x < set.width; x++) if (set.alpha[row + x] > 110) { left[r] = x; break }
    for (let x = set.width - 1; x >= 0; x--) if (set.alpha[row + x] > 110) { right[r] = x; break }
  }
  return { alpha: set.alpha, width: set.width, height: set.height, base, left, right, stroke: drawn.to * PEN_SCALE * k }
}

/**
 * How many separate pieces of ink a letter has and how many enclosed counters,
 * ignoring specks (under a fifth of a stroke-width square). `stroke` is the
 * pen width in the field's own pixels.
 */
function shapeOf(field: Field, stroke: number): { parts: number; holes: number } {
  const { alpha, width: W, height: H } = field
  // One pixel of paper all round, so the outside is one region.
  const w = W + 2, h = H + 2
  const ink = new Uint8Array(w * h), paper = new Uint8Array(w * h).fill(1)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (alpha[y * W + x] > 127) { ink[(y + 1) * w + x + 1] = 1; paper[(y + 1) * w + x + 1] = 0 }
    }
  }
  const speck = Math.max(4, stroke * stroke * 0.2)
  const parts = components(ink, w, h).areas.filter(a => a >= speck).length
  const bg = components(paper, w, h)
  let holes = 0
  for (let k = 0; k < bg.areas.length; k++) {
    const b = bg.boxes[k]
    const outside = b[0] === 0 || b[1] === 0 || b[2] === w - 1 || b[3] === h - 1
    if (!outside && bg.areas[k] >= Math.max(3, speck * 0.05)) holes++
  }
  return { parts, holes }
}

/**
 * The gap to leave between the boxes of two letters (px, may be negative: a T
 * tucks over an L). The white between two shapes is what the eye spaces by,
 * so the gap is the tracking less most of the openness the two facing sides
 * already have, and never so little that ink comes within CLEAR of ink.
 */
export function letterGap(a: { width: number; right: Int16Array }, b: { left: Int16Array }): number {
  let open = 0, n = 0, tight = Infinity
  for (let r = 0; r < CAP; r++) {
    const ra = a.right[r] < 0 ? DEPTH : Math.min(DEPTH, a.width - 1 - a.right[r])
    const lb = b.left[r] < 0 ? DEPTH : Math.min(DEPTH, b.left[r])
    open += ra + lb
    n++
    // Ink facing ink within a few rows of each other is what can collide.
    if (a.right[r] < 0) continue
    for (let d = -3; d <= 3; d++) {
      const q = r + d
      if (q < 0 || q >= CAP || b.left[q] < 0) continue
      const room = a.width - 1 - a.right[r] + b.left[q]
      if (room < tight) tight = room
    }
  }
  let gap = TRACK - KERN * (n ? open / n : 0)
  if (tight !== Infinity) gap = Math.max(gap, CLEAR - tight)
  return Math.max(-DEPTH, Math.min(TRACK, gap))
}

/**
 * Set `text` in the artist's hand from `bank` (see the top of this file). A
 * character with no sample of its own borrows the other case (a capital
 * written once serves as both); anything still missing is reported instead
 * of guessed. Deterministic for a given seed: the same seed picks the same
 * samples.
 */
export async function composeHandwriting(
  text: string, bank: GlyphSample[], opts: { align?: ComposeAlign; seed?: number; pen?: PenStyle } = {},
): Promise<ComposeResult> {
  const lines = textLines(text).slice(0, MAX_TYPED_LINES)
  const align = opts.align ?? 'center'
  const pen = opts.pen ?? 'medium'
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

  const prepared = new Map<GlyphSample, SetGlyph | null>()
  const prepare = async (s: GlyphSample) => {
    if (!prepared.has(s)) prepared.set(s, await prepareGlyph(s, pen))
    return prepared.get(s)!
  }

  type Placed = { g: SetGlyph; x: number; line: number }
  const placed: Placed[] = []
  const lineWidths: number[] = []
  const lastPick = new Map<string, number>()
  let above = 0, below = 0
  for (let li = 0; li < lines.length; li++) {
    let x = 0
    let prev: SetGlyph | null = null
    let space = false
    for (const c of lines[li]) {
      if (c === ' ') { space = true; continue }
      const samples = samplesFor(c)!
      // A repeated letter prefers a sample it did not use last time.
      let pick = Math.floor(r() * samples.length)
      if (samples.length > 1 && lastPick.get(c) === pick) pick = (pick + 1 + Math.floor(r() * (samples.length - 1))) % samples.length
      lastPick.set(c, pick)
      const g = await prepare(samples[pick])
      if (!g) continue
      if (prev) x += space ? WORD : letterGap(prev, g)
      placed.push({ g, x, line: li })
      x += g.width
      prev = g
      space = false
      if (li === 0) above = Math.max(above, g.base)
      if (li === lines.length - 1) below = Math.max(below, g.height - g.base)
    }
    lineWidths.push(x)
  }
  if (placed.length === 0) return { ok: false, missing: [] }

  const maxW = Math.max(...lineWidths)
  const pad = Math.round(CAP * 0.3)
  const W = Math.ceil(maxW + pad * 2)
  const first = Math.ceil(Math.max(above, CAP) + pad)
  const H = Math.ceil(first + (lines.length - 1) * LEADING + below + pad)
  const canvas = new Uint8Array(W * H)
  let strokeSum = 0
  for (const p of placed) {
    const shift = align === 'left' ? 0 : align === 'right' ? maxW - lineWidths[p.line] : (maxW - lineWidths[p.line]) / 2
    const left = Math.round(p.x + pad + shift)
    const top = Math.round(first + p.line * LEADING - p.g.base)
    strokeSum += p.g.stroke
    for (let y = 0; y < p.g.height; y++) {
      const yy = top + y
      if (yy < 0 || yy >= H) continue
      for (let x = 0; x < p.g.width; x++) {
        const xx = left + x
        if (xx < 0 || xx >= W) continue
        const v = p.g.alpha[y * p.g.width + x]
        if (v > canvas[yy * W + xx]) canvas[yy * W + xx] = v
      }
    }
  }
  const stroke = strokeSum / placed.length
  const lettering = await cropLettering(canvas, W, H, stroke)
  return { ok: true, lettering, cap: CAP, stroke }
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
