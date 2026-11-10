// Handwriting SHEET — the one photo that sets up "your handwriting" for good,
// with nothing to type:
//
//   one line      your name, the way you sign it (e.g. moodmixformat) — kept
//                 whole, as one image: a signature is a shape, not letters.
//                 The TOP line or the BOTTOM line, whichever it was written on
//                 (pickSignatureRow decides: the line that looks like a name —
//                 joined-up or lowercase — else the one that leaves 36 shapes)
//   other lines   A–Z then 0–9 in capitals, a gap between every character,
//                 broken over as many lines as you like. One or two stray
//                 shapes (the owner's "#" before the digits, a dash) are
//                 found and left out by handwriting-align.ts — when it can
//                 tell them from the letters; otherwise the sheet is refused
//
// The letters are labelled by ORDER (the 36 shapes on the letter lines are
// A, B, C … 9), so nothing is typed. If the count is not 36 (or 26, letters
// only) the sheet is refused with how many shapes each line had — a miscount
// would label every later letter wrong, and a wrong letter is worse than none.
//
// Also here: the title as it is written (capitals, accents stripped, long
// titles broken over two lines), stacking the signature over the title into
// one lockup, and recovering a signature from a lettering photo the artist
// already uploaded (its first line).
//
// Pure image maths over raw pixels plus sharp. No server-only imports —
// scripts/cassette-quick-test.mjs drives it directly under Node.

import sharp from 'sharp'
import { components, cropLettering, extractHandwriting, type Lettering } from './handwriting.ts'
import {
  glyphPng, isGlyphChar, labelGlyphs, letteringAlpha, resizeField, segmentGlyphs, type GlyphRow, type TaughtGlyph,
} from './handwriting-glyphs.ts'
import {
  cropField, lineBody, lineSlopeOf, PEN_SCALE, repen, shearLevel, strokeWidthOf, type Field,
} from './handwriting-pen.ts'
import { findExtraMarks, MAX_EXTRA_MARKS, readsInOrder } from './handwriting-align.ts'

export const SHEET_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
export const SHEET_DIGITS = '0123456789'

export type SheetResult =
  | { ok: true; signature: Lettering; glyphs: TaughtGlyph[]; /** stray shapes that were not letters, left out */ ignored: number }
  | { ok: false; error: string; found: number; expected: number }

/** Read a handwriting sheet photo (see the top of this file). */
export async function readHandwritingSheet(photo: Buffer): Promise<SheetResult> {
  const lifted = await extractHandwriting(photo)
  const { alpha, width, height } = await letteringAlpha(lifted.png)
  const rows = segmentGlyphs(alpha, width, height)
  const expected = SHEET_LETTERS.length + SHEET_DIGITS.length
  if (rows.length < 2) {
    return {
      ok: false,
      error: 'I can only see one line. Write your name on its own line (top or bottom) and A–Z then 0–9 on the other lines.',
      found: rows[0]?.glyphs.length ?? 0,
      expected,
    }
  }
  const signatureAt = pickSignatureRow(rows)
  let letterRows = signatureAt === 'top' ? rows.slice(1) : rows.slice(0, -1)
  const signatureRow = signatureAt === 'top' ? rows[0] : rows[rows.length - 1]
  let count = letterRows.reduce((n, r) => n + r.glyphs.length, 0)
  let chars = count === expected ? SHEET_LETTERS + SHEET_DIGITS
    : count === SHEET_LETTERS.length ? SHEET_LETTERS
      : null
  let ignored = 0
  if (!chars) {
    // A shape or two too many: find the ones that are not letters at all
    // (a "#", a dash) and leave them out — only when that is clear.
    const base = count > expected ? SHEET_LETTERS + SHEET_DIGITS : count > SHEET_LETTERS.length ? SHEET_LETTERS : null
    const extra = base ? await findExtraMarks(alpha, width, letterRows.flatMap(r => r.glyphs), base) : null
    if (base && extra) {
      const drop = new Set(extra.dropped)
      let at = 0
      letterRows = letterRows
        .map(r => {
          const start = at
          at += r.glyphs.length
          const glyphs = r.glyphs.filter((_, i) => !drop.has(start + i))
          return { glyphs, y0: Math.min(...glyphs.map(g => g.y0)), y1: Math.max(...glyphs.map(g => g.y1)) }
        })
        .filter(r => r.glyphs.length > 0)
      chars = base
      count = base.length
      ignored = extra.dropped.length
    }
  }
  if (!chars) {
    const perRow = letterRows.map(r => r.glyphs.length).join(' · ')
    const unsure = count > expected ? ', and I could not tell which shape is the extra one' : ''
    return {
      ok: false,
      error: `I found ${count} shapes on the letter lines (${perRow}) but expected 36: A–Z then 0–9 and nothing else (no # or dashes)${unsure}. Leave a clear gap between characters and write them in order. Your name was read from the ${signatureAt} line.`,
      found: count,
      expected,
    }
  }
  // Split the run of characters over the rows as written.
  const lines: string[] = []
  let at = 0
  for (const r of letterRows) { lines.push(chars.slice(at, at + r.glyphs.length)); at += r.glyphs.length }
  const labelled = labelGlyphs(letterRows, lines.join('\n'))
  if (!labelled.ok) return { ok: false, error: labelled.error, found: count, expected: chars.length }
  // The count can come out right for the wrong reason (a sloping line cut in
  // two, a name taken for letters). Labels that do not read as written are
  // refused rather than taught: a wrong letter is worse than none.
  const order = await readsInOrder(alpha, width, labelled.glyphs, chars)
  if (!order.ok) {
    return {
      ok: false,
      error: `I counted ${count} shapes but they do not read as A–Z then 0–9 in order. Photograph the sheet straight-on with the lines level, a clear gap between characters, and nothing else on it.`,
      found: count,
      expected,
    }
  }
  const glyphs: TaughtGlyph[] = []
  for (const g of labelled.glyphs) {
    glyphs.push({ char: g.char, unit: g.unit, base: g.base, width: g.x1 - g.x0 + 1, height: g.y1 - g.y0 + 1, png: await glyphPng(alpha, width, g) })
  }
  const signature = await neatSignature(await cropRow(alpha, width, height, signatureRow))
  return { ok: true, signature, glyphs, ignored }
}

/**
 * Which end of the sheet carries the name. A name reads differently from a
 * line of spaced capitals: written joined-up it is one shape far wider than
 * the line is tall, written in lowercase most of its letters stop at the
 * x-height while the line's height is set by the tall ones. When exactly one
 * end line looks like that, it is the name. When neither or both do, the end
 * that leaves 36 (or 26) shapes on the other lines wins; when that does not
 * settle it either, the clearer name wins, else the top line (the layout the
 * instructions describe).
 */
export function pickSignatureRow(rows: GlyphRow[]): 'top' | 'bottom' {
  if (rows.length < 2) return 'top'
  const first = rows[0], last = rows[rows.length - 1]
  const a = nameLikeness(first), b = nameLikeness(last)
  if ((a >= 1) !== (b >= 1)) return b >= 1 ? 'bottom' : 'top'
  const total = rows.reduce((n, r) => n + r.glyphs.length, 0)
  // "Leaves 36 (or 26) shapes" allows the stray marks findExtraMarks can take out.
  const fits = (sig: GlyphRow): boolean => {
    const n = total - sig.glyphs.length
    const near = (want: number) => n >= want && n <= want + MAX_EXTRA_MARKS
    return near(SHEET_LETTERS.length + SHEET_DIGITS.length) || near(SHEET_LETTERS.length)
  }
  const topFits = fits(first), bottomFits = fits(last)
  if (topFits !== bottomFits) return bottomFits ? 'bottom' : 'top'
  return b >= 1 && b > a * 1.5 ? 'bottom' : 'top'
}

/** ≥ 1 when a line of writing looks like a name rather than spaced capitals (see pickSignatureRow). */
function nameLikeness(row: GlyphRow): number {
  const heights = row.glyphs.map(g => g.y1 - g.y0 + 1).sort((a, b) => a - b)
  // The tall letters' height: the 80th percentile, so one flourish or a
  // descender does not make every other letter look short — and not the
  // line's whole extent, which a sloping line stretches.
  const tall = Math.max(1, heights[Math.min(heights.length - 1, Math.floor(heights.length * 0.8))])
  let widest = 0, short = 0
  for (const g of row.glyphs) {
    widest = Math.max(widest, g.x1 - g.x0 + 1)
    if (g.y1 - g.y0 + 1 < tall * 0.72) short++
  }
  const joined = widest / tall / 2                   // one shape twice as wide as the letters are tall
  const lowercase = row.glyphs.length >= 4 ? short / row.glyphs.length / 0.4 : 0  // 40 % of the letters stop short of the tall ones
  return Math.max(joined, lowercase)
}

/**
 * The first line of a lettering the artist already uploaded (white RGB + ink
 * alpha PNG), as a signature — only when the lettering has at least two lines
 * (a name over a title, the way the Studio asks for it). Null otherwise.
 */
export async function signatureFromLettering(png: Buffer): Promise<Lettering | null> {
  const { alpha, width, height } = await letteringAlpha(png)
  const rows = segmentGlyphs(alpha, width, height)
  if (rows.length < 2) return null
  return neatSignature(await cropRow(alpha, width, height, rows[0]))
}

/**
 * A signature as it is kept: levelled (a line of handwriting climbs or drops;
 * the name should sit straight over the title) and without what is not part
 * of it (tidyLine). The pen and the letters are untouched.
 */
export async function neatSignature(sig: Lettering): Promise<Lettering> {
  const raw = await letteringAlpha(sig.png)
  const field = { alpha: raw.alpha, width: raw.width, height: raw.height }
  const level = tidyLine(shearLevel(field, lineSlopeOf(field)))
  try {
    return await cropLettering(level.alpha, level.width, level.height, sig.strokeWidth)
  } catch {
    return sig
  }
}

/** One row of an alpha field as its own lettering: ink outside the row's glyph boxes is dropped. */
async function cropRow(alpha: Uint8Array, W: number, H: number, row: GlyphRow): Promise<Lettering> {
  const keep = new Uint8Array(W * H)
  const m = 2
  for (const g of row.glyphs) {
    for (let y = Math.max(0, g.y0 - m); y <= Math.min(H - 1, g.y1 + m); y++) {
      for (let x = Math.max(0, g.x0 - m); x <= Math.min(W - 1, g.x1 + m); x++) keep[y * W + x] = alpha[y * W + x]
    }
  }
  const strokes = row.glyphs.map(g => Math.min(g.x1 - g.x0 + 1, g.y1 - g.y0 + 1))
  const stroke = strokes.length ? Math.max(3, Math.min(...strokes) * 0.2) : 6
  return cropLettering(keep, W, H, stroke)
}

// ── The title as it is written ──────────────────────────────────────────────

/**
 * Longest line a title is set on before it breaks onto a second line. A
 * lockup is drawn at a share of the cover's WIDTH, so a long single line
 * means small letters: two short lines keep them at a size that reads.
 */
const TITLE_LINE = 13

/**
 * The song title the way the artist writes titles: capitals, accents
 * stripped (é → E), curly quotes straightened, runs of space collapsed, a
 * long title broken at the space nearest its middle. Characters that cannot
 * be written from the sheet are dropped and reported, never substituted.
 */
export function titleForHandwriting(title: string): { text: string; dropped: string[] } {
  const plain = title
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[‘’`´]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .toUpperCase().replace(/\s+/g, ' ').trim()
  const dropped = new Set<string>()
  let kept = ''
  for (const c of plain) {
    if (c === ' ' || isGlyphChar(c)) kept += c
    else dropped.add(c)
  }
  kept = kept.replace(/\s+/g, ' ').trim()
  if (kept.length <= TITLE_LINE || !kept.includes(' ')) return { text: kept, dropped: [...dropped] }
  // Break at the space closest to the middle.
  const mid = kept.length / 2
  let best = -1
  for (let i = 0; i < kept.length; i++) if (kept[i] === ' ' && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i
  return { text: `${kept.slice(0, best)}\n${kept.slice(best + 1)}`, dropped: [...dropped] }
}

// ── Lockup ──────────────────────────────────────────────────────────────────

/** The signature's small letters, as a share of the title's capital height. */
const SIG_X = 0.7
/** Its tallest strokes (the d, the f, the t) never stand taller than this share of a capital. */
const SIG_TALL = 1.12
/** The signature's pen against the title's: a touch lighter, so the name sits behind the title. */
const SIG_WEIGHT = 0.88
/** Baseline of the signature to the top of the title, in capital heights. */
const LOCKUP_GAP = 0.44
/** A short title is set up to this much larger so it holds its own under the name. */
const SHORT_TITLE_BOOST = 1.3
/**
 * The lockup is never narrower than this many capital heights (clear margin
 * is added either side). It is drawn at a share of the cover's width, so
 * without a floor a short name over a short title would come out huge and a
 * long one small; with it the letters land within about a third of one size.
 */
const MIN_LOCKUP_CAPS = 9

/** What stackLockup needs to know about a composed title (composeHandwriting returns it). */
export type TitleMetrics = { cap: number; stroke: number }

/**
 * A signature made ready to sit over a title: levelled (handwriting climbs),
 * traced to the title's pen weight and scaled so its small letters are SIG_X
 * of a capital. `cap` and `stroke` are the title's, in the title's pixels.
 */
export async function prepareSignature(png: Buffer, cap: number, stroke: number): Promise<(Field & { baseline: number }) | null> {
  const raw = await letteringAlpha(png)
  const level = tidyLine(shearLevel({ alpha: raw.alpha, width: raw.width, height: raw.height }, lineSlopeOf({ alpha: raw.alpha, width: raw.width, height: raw.height })))
  const body = lineBody(level)
  if (!body) return null
  const xh = Math.max(1, body.baseline - body.top + 1)
  const tall = Math.max(xh, body.baseline - body.inkTop + 1)
  // Its size against the title: the small letters at SIG_X of a capital,
  // unless that would stand its tall strokes above SIG_TALL of one.
  const k = cap * Math.min(SIG_X / xh, SIG_TALL / tall)
  const natural = strokeWidthOf(level)
  const want = (stroke * SIG_WEIGHT) / k
  // Finer only: a signature already lighter than the title's pen is left alone.
  const inset = natural > want * 1.1 ? (natural - want) / 2 : 0
  const drawn = repen(level, inset, { stroke: natural, hi: true })
  const ink = cropField(drawn.field)
  if (!ink) return null
  const scale = k / PEN_SCALE
  const set = await resizeField(ink, ink.width * scale, ink.height * scale)
  const baseline = ((body.baseline + 1 - drawn.inset) * PEN_SCALE - ink.top) * scale
  return { ...set, baseline }
}

/**
 * A level line of writing without what is not part of it: specks, and marks
 * that float wholly under its baseline (the top of a letter from the line
 * below, caught when a climbing line was cut out of its photo). A real
 * descender is joined to its letter and stays.
 */
function tidyLine(field: Field): Field {
  const body = lineBody(field)
  if (!body) return field
  const { alpha, width: W, height: H } = field
  const mask = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) mask[i] = alpha[i] > 60 ? 1 : 0
  const { labels, areas, boxes } = components(mask, W, H)
  if (areas.length === 0) return field
  const xh = Math.max(1, body.baseline - body.top + 1)
  const stroke = strokeWidthOf(field)
  const drop = new Uint8Array(areas.length)
  let dropped = false
  for (let k = 0; k < areas.length; k++) {
    const under = boxes[k][1] > body.baseline + xh * 0.12
    const speck = areas[k] < stroke * stroke * 0.3
    if (under || speck) { drop[k] = 1; dropped = true }
  }
  if (!dropped) return field
  const out = Uint8Array.from(alpha)
  // Soft edge pixels around a dropped mark (alpha ≤ 60) go with it: clear its box.
  for (let k = 0; k < areas.length; k++) {
    if (!drop[k]) continue
    const [x0, y0, x1, y1] = boxes[k]
    for (let y = Math.max(0, y0 - 2); y <= Math.min(H - 1, y1 + 2); y++) {
      for (let x = Math.max(0, x0 - 2); x <= Math.min(W - 1, x1 + 2); x++) {
        const l = labels[y * W + x]
        if (l === 0 || drop[l - 1]) out[y * W + x] = 0
      }
    }
  }
  return { alpha: out, width: W, height: H }
}

/**
 * Stack the signature over the title into one lettering (white RGB + ink
 * alpha), centred on one axis (the lockup sits bottom-centre on the cover, as
 * on the owner's reference). The signature is levelled, traced to the
 * title's pen and sized against the title's capitals (prepareSignature); a
 * short title is set a little larger so it is not lost under a long name.
 * `title` says how tall the title's capitals are and how wide its stroke
 * (composeHandwriting's result); without it the title is taken to be one
 * line of capitals as tall as its image. Either image may be missing; with
 * neither there is nothing to letter.
 */
export async function stackLockup(top: Buffer | null, bottom: Buffer | null, title?: TitleMetrics): Promise<Lettering | null> {
  if (!top && !bottom) return null
  if (!bottom) {
    // The name alone: levelled, otherwise as written.
    const raw = await letteringAlpha(top!)
    const level = tidyLine(shearLevel({ alpha: raw.alpha, width: raw.width, height: raw.height }, lineSlopeOf({ alpha: raw.alpha, width: raw.width, height: raw.height })))
    return cropLettering(level.alpha, level.width, level.height, Math.max(3, strokeWidthOf(level)))
  }
  const t = await letteringAlpha(bottom)
  if (!top) return cropLettering(t.alpha, t.width, t.height, title?.stroke ?? 6)

  let cap = title?.cap ?? t.height
  let stroke = title?.stroke ?? cap / 8.5
  let tf: Field = { alpha: t.alpha, width: t.width, height: t.height }
  let sig = await prepareSignature(top, cap, stroke)
  if (!sig) return cropLettering(t.alpha, t.width, t.height, stroke)
  // A title much narrower than the name: enlarge it (and measure the name against the larger capitals).
  const boost = Math.max(1, Math.min(SHORT_TITLE_BOOST, (sig.width * 0.62) / Math.max(1, tf.width)))
  if (boost > 1.04) {
    tf = await resizeField(tf, tf.width * boost, tf.height * boost)
    cap *= boost
    stroke *= boost
    // The name keeps its size against the ORIGINAL capitals and a pen between the two.
    sig = (await prepareSignature(top, cap / boost, stroke / Math.sqrt(boost))) ?? sig
  }

  // The title's own first capital line starts at its image top (cropLettering
  // crops to the ink, plus a hair of padding).
  const below = sig.height - sig.baseline // what hangs under the name's baseline
  const gap = Math.max(cap * LOCKUP_GAP, below + cap * 0.14)
  const titleTop = Math.round(sig.baseline + gap)
  const W = Math.max(sig.width, tf.width)
  const H = titleTop + tf.height
  const canvas = new Uint8Array(W * H)
  const lay = (f: Field, left: number, y0: number) => {
    for (let y = 0; y < f.height; y++) {
      const yy = y0 + y
      if (yy < 0 || yy >= H) continue
      for (let x = 0; x < f.width; x++) {
        const v = f.alpha[y * f.width + x]
        if (v > canvas[yy * W + left + x]) canvas[yy * W + left + x] = v
      }
    }
  }
  lay(sig, Math.round((W - sig.width) / 2), 0)
  lay(tf, Math.round((W - tf.width) / 2), titleTop)
  const tight = await cropLettering(canvas, W, H, stroke)
  const floor = Math.round(cap * MIN_LOCKUP_CAPS)
  if (tight.width >= floor) return tight
  const side = Math.round((floor - tight.width) / 2)
  const png = await sharp(tight.png)
    .extend({ left: side, right: floor - tight.width - side, top: 0, bottom: 0, background: { r: 255, g: 255, b: 255, alpha: 0 } })
    .png().toBuffer()
  return { png, width: floor, height: tight.height, strokeWidth: tight.strokeWidth }
}
