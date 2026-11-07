// Handwriting SHEET — the one photo that sets up "your handwriting" for good,
// with nothing to type:
//
//   one line      your name, the way you sign it (e.g. moodmixformat) — kept
//                 whole, as one image: a signature is a shape, not letters.
//                 The TOP line or the BOTTOM line, whichever it was written on
//                 (pickSignatureRow decides: the line that looks like a name —
//                 joined-up or lowercase — else the one that leaves 36 shapes)
//   other lines   A–Z then 0–9 in capitals, a gap between every character,
//                 broken over as many lines as you like, nothing else on the
//                 sheet (a # or a dash would be taken for a letter)
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
import { cropLettering, extractHandwriting, type Lettering } from './handwriting.ts'
import {
  glyphPng, isGlyphChar, labelGlyphs, letteringAlpha, segmentGlyphs, type GlyphRow, type TaughtGlyph,
} from './handwriting-glyphs.ts'

export const SHEET_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
export const SHEET_DIGITS = '0123456789'

export type SheetResult =
  | { ok: true; signature: Lettering; glyphs: TaughtGlyph[] }
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
  const letterRows = signatureAt === 'top' ? rows.slice(1) : rows.slice(0, -1)
  const signatureRow = signatureAt === 'top' ? rows[0] : rows[rows.length - 1]
  const count = letterRows.reduce((n, r) => n + r.glyphs.length, 0)
  const chars = count === expected ? SHEET_LETTERS + SHEET_DIGITS
    : count === SHEET_LETTERS.length ? SHEET_LETTERS
      : null
  if (!chars) {
    const perRow = letterRows.map(r => r.glyphs.length).join(' · ')
    return {
      ok: false,
      error: `I found ${count} shapes on the letter lines (${perRow}) but expected 36: A–Z then 0–9 and nothing else (no # or dashes). Leave a clear gap between characters and write them in order. Your name was read from the ${signatureAt} line.`,
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
  const glyphs: TaughtGlyph[] = []
  for (const g of labelled.glyphs) {
    glyphs.push({ char: g.char, unit: g.unit, base: g.base, width: g.x1 - g.x0 + 1, height: g.y1 - g.y0 + 1, png: await glyphPng(alpha, width, g) })
  }
  const signature = await cropRow(alpha, width, height, signatureRow)
  return { ok: true, signature, glyphs }
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
  const fits = (sig: GlyphRow): boolean => {
    const n = total - sig.glyphs.length
    return n === SHEET_LETTERS.length + SHEET_DIGITS.length || n === SHEET_LETTERS.length
  }
  const topFits = fits(first), bottomFits = fits(last)
  if (topFits !== bottomFits) return bottomFits ? 'bottom' : 'top'
  return b >= 1 && b > a * 1.5 ? 'bottom' : 'top'
}

/** ≥ 1 when a line of writing looks like a name rather than spaced capitals (see pickSignatureRow). */
function nameLikeness(row: GlyphRow): number {
  const h = Math.max(1, row.y1 - row.y0 + 1)
  const heights = row.glyphs.map(g => g.y1 - g.y0 + 1).sort((a, b) => a - b)
  // The tall letters' height: the 80th percentile, so one flourish or a
  // descender does not make every other letter look short.
  const tall = Math.max(1, heights[Math.min(heights.length - 1, Math.floor(heights.length * 0.8))])
  let widest = 0, short = 0
  for (const g of row.glyphs) {
    widest = Math.max(widest, g.x1 - g.x0 + 1)
    if (g.y1 - g.y0 + 1 < tall * 0.72) short++
  }
  const joined = widest / h / 2                      // one shape twice as wide as the line is tall
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
  return cropRow(alpha, width, height, rows[0])
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

/** Longest line a title is set on before it breaks onto a second line. */
const TITLE_LINE = 16

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

/**
 * Stack the signature over the title into one lettering (white RGB + ink
 * alpha), centred on one axis (the lockup sits bottom-centre on the cover,
 * as on the owner's reference): the signature at 85% of the title's height,
 * a small gap between. Either may be missing; with neither there is nothing
 * to letter.
 */
export async function stackLockup(top: Buffer | null, bottom: Buffer | null): Promise<Lettering | null> {
  if (!top && !bottom) return null
  if (!top || !bottom) {
    const only = (top ?? bottom)!
    const { alpha, width, height } = await letteringAlpha(only)
    return cropLettering(alpha, width, height, 6)
  }
  const bm = await sharp(bottom).metadata()
  const tm = await sharp(top).metadata()
  const bw = bm.width ?? 1, bh = bm.height ?? 1
  const th = Math.max(1, Math.round(bh * 0.85))
  const tw = Math.max(1, Math.round((tm.width ?? 1) * (th / (tm.height ?? 1))))
  const gap = Math.round(bh * 0.12)
  const W = Math.max(bw, tw), H = th + gap + bh
  const topPng = await sharp(top).resize(tw, th, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer()
  const { data } = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } } })
    .composite([
      { input: topPng, left: Math.round((W - tw) / 2), top: 0 },
      { input: bottom, left: Math.round((W - bw) / 2), top: th + gap },
    ])
    .raw().toBuffer({ resolveWithObject: true })
  const alpha = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) alpha[i] = data[i * 4 + 3]
  return cropLettering(alpha, W, H, 6)
}
