// Extra marks on a handwriting sheet — found, not guessed.
//
// A sheet is labelled by ORDER (handwriting-sheet.ts), so one stray shape
// among the letters (the owner's "#" before the digits, a dash, a stray dot
// the lift kept) would shift every label after it. With one or two shapes
// too many, this module works out WHICH shapes are not letters: every way of
// leaving out that many shapes is tried, each shape is compared with plain
// type of the letter it would then be labelled (the bundled Futura, blurred
// to a small cell so a hand's wobble does not count), and the way that reads
// best wins — only when it reads clearly better than the runner-up. When it
// does not (the extra shape looks as much like a letter as the letter does),
// nothing is dropped and the sheet is refused as before: a wrong letter is
// worse than none.
//
// The type is never used to label the letters themselves — a hand's "Z" may
// look more like the type's "2" and that is fine, because the comparison only
// has to tell "this shape is the letter written here" from "this shape is a
// stroke that is not a letter at all", summed over the whole sheet.
//
// Pure image maths over raw pixels plus sharp (Pango for the type, like the
// finalized-artwork overlay). No server-only imports — scripts drive it
// directly under Node.

import sharp from 'sharp'
import { join } from 'node:path'
import type { GlyphBox } from './handwriting-glyphs.ts'

const FONT_PATH = join(process.cwd(), 'src/fonts/FuturaBold.ttf')
const FONT_DESC = 'Futura Bold'
/** Shapes are compared in a cell this many pixels square, blurred. */
const CELL = 24
const BLUR = 1.1
/**
 * The best way of leaving shapes out must beat the runner-up by this much
 * (summed similarity). Measured on the owner's whiteboard sheet, the "#"
 * before the digits wins by 0.25–0.40 at every tilt up to 7°; two ways
 * that differ only in which of two alike shapes goes win by ~0.
 */
export const EXTRA_MARK_MARGIN = 0.15
/** At most this many extra shapes are looked for. */
export const MAX_EXTRA_MARKS = 2

export type ExtraMarks = {
  /** Indices (into the glyph list given) that are the letters, in order. */
  keep: number[]
  /** Indices that are not letters and are left out. */
  dropped: number[]
  /** How clearly the chosen way beat the runner-up. */
  margin: number
}

/**
 * Which of `glyphs` (left-to-right, top-to-bottom, as the sheet reads) are
 * the letters of `chars`, when there are one or two shapes too many. Null
 * when the count is right or too far off, or when no way of leaving shapes
 * out reads clearly better than the others.
 */
export async function findExtraMarks(alpha: Uint8Array, W: number, glyphs: GlyphBox[], chars: string, minMargin = EXTRA_MARK_MARGIN): Promise<ExtraMarks | null> {
  const k = glyphs.length - chars.length
  if (k < 1 || k > MAX_EXTRA_MARKS) return null
  const S = await similarity(alpha, W, glyphs, chars)
  const n = glyphs.length
  const score = (drop: number[]): number => {
    let s = 0, c = 0
    for (let g = 0; g < n; g++) {
      if (drop.includes(g)) continue
      s += S[g][c++]
    }
    return s
  }
  let best: { drop: number[]; s: number } | null = null
  let second = -Infinity
  const consider = (drop: number[]) => {
    const s = score(drop)
    if (!best || s > best.s) { if (best) second = Math.max(second, best.s); best = { drop, s } }
    else second = Math.max(second, s)
  }
  if (k === 1) for (let a = 0; a < n; a++) consider([a])
  else for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) consider([a, b])
  if (!best) return null
  const chosen: { drop: number[]; s: number } = best
  const margin = chosen.s - second
  if (!(margin >= minMargin)) return null
  const dropped = new Set(chosen.drop)
  return { keep: Array.from({ length: n }, (_, i) => i).filter(i => !dropped.has(i)), dropped: chosen.drop, margin }
}

// ── Similarity ──────────────────────────────────────────────────────────────

/** Hand-held photos tilt a little; the type is compared at these tilts (degrees) and the best counts. */
const TILTS = [-8, -4, 0, 4, 8]

/** S[g][c]: how much shape g looks like the type of chars[c] (correlation, the best tilt). */
async function similarity(alpha: Uint8Array, W: number, glyphs: GlyphBox[], chars: string): Promise<number[][]> {
  const vectors = await Promise.all(glyphs.map(g => glyphVector(alpha, W, g)))
  const types = await typeVectors(chars)
  return vectors.map(v => Array.from(chars, ch => Math.max(...types.get(ch)!.map(t => dot(v, t)))))
}

// ── Shape vectors ───────────────────────────────────────────────────────────

/** One shape of an ink alpha field as a normalised vector (zero mean, unit length). */
async function glyphVector(alpha: Uint8Array, W: number, box: GlyphBox): Promise<Float32Array> {
  const w = box.x1 - box.x0 + 1, h = box.y1 - box.y0 + 1
  const crop = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) crop[y * w + x] = alpha[(y + box.y0) * W + (x + box.x0)]
  return shapeVector(crop, w, h)
}

let typeCache: Map<string, Float32Array[]> | null = null

/** The type of every character in `chars`, as shape vectors at each tilt (rendered once per process). */
async function typeVectors(chars: string): Promise<Map<string, Float32Array[]>> {
  if (!typeCache) typeCache = new Map()
  for (const ch of new Set(chars)) {
    if (typeCache.has(ch)) continue
    typeCache.set(ch, await Promise.all(TILTS.map(t => typeVector(ch, t))))
  }
  return typeCache
}

async function typeVector(ch: string, tilt: number): Promise<Float32Array> {
  const markup = ch.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const png = await sharp({ text: { text: markup, fontfile: FONT_PATH, font: `${FONT_DESC} 96`, dpi: 72, rgba: true } }).png().toBuffer()
  const { data, info } = await sharp(png).rotate(tilt, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const W = info.width, H = info.height
  // Crop to the ink, as the sheet's shapes are.
  let x0 = W, y0 = H, x1 = -1, y1 = -1
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (data[(y * W + x) * 4 + 3] > 32) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
  }
  if (x1 < 0) throw new Error(`The type has no shape for "${ch}"`)
  const w = x1 - x0 + 1, h = y1 - y0 + 1
  const crop = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) crop[y * w + x] = data[((y + y0) * W + (x + x0)) * 4 + 3]
  return shapeVector(crop, w, h)
}

/**
 * A shape (ink alpha, tightly cropped) fitted into the comparison cell with
 * its proportions kept (a "1" stays a thin bar, an "O" fills the cell),
 * blurred, then normalised so the dot product of two such vectors is their
 * correlation.
 */
async function shapeVector(crop: Uint8Array, w: number, h: number): Promise<Float32Array> {
  const rgba = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) { rgba[i * 4] = 255; rgba[i * 4 + 1] = 255; rgba[i * 4 + 2] = 255; rgba[i * 4 + 3] = crop[i] }
  const { data } = await sharp(rgba, { raw: { width: w, height: h, channels: 4 } })
    .resize(CELL, CELL, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 }, kernel: 'lanczos3' })
    .blur(BLUR)
    .raw().toBuffer({ resolveWithObject: true })
  const n = CELL * CELL
  const v = new Float32Array(n)
  let mean = 0
  for (let i = 0; i < n; i++) { v[i] = data[i * 4 + 3] / 255; mean += v[i] }
  mean /= n
  let norm = 0
  for (let i = 0; i < n; i++) { v[i] -= mean; norm += v[i] * v[i] }
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < n; i++) v[i] /= norm
  return v
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/**
 * Does a labelling read as written? Each labelled shape is ranked against
 * the type of every character (1 = it looks most like its own letter). A
 * sheet labelled right ranks low on average (the owner's whiteboard: ~6 of
 * 36, a third of the letters first); one labelled off by a line or a shape
 * ranks like chance (~18). `shiftedRank` is the same measure with every
 * label moved one place, the nearest wrong labelling — a right one reads
 * clearly better than it (or plainly well on its own).
 */
export async function readsInOrder(alpha: Uint8Array, W: number, glyphs: GlyphBox[], chars: string): Promise<{ meanRank: number; shiftedRank: number; ok: boolean }> {
  const S = await similarity(alpha, W, glyphs, chars)
  const n = Math.min(glyphs.length, chars.length)
  const rank = (g: number, c: number): number => S[g].filter(v => v > S[g][c]).length + 1
  let mine = 0, left = 0, right = 0
  for (let g = 0; g < n; g++) {
    mine += rank(g, g)
    left += rank(g, (g + 1) % n)
    right += rank(g, (g + n - 1) % n)
  }
  const meanRank = mine / n
  const shiftedRank = Math.min(left, right) / n
  // Reads as written when it ranks plainly well, or clearly better than the nearest wrong labelling.
  const ok = meanRank <= chars.length / 4.5 || meanRank <= shiftedRank - 2
  return { meanRank, shiftedRank, ok }
}
