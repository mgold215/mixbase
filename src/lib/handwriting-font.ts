// Handwriting "font" — the artist's own letters, cut out of a photo of their
// writing, re-assembled into any title. No typeface, no AI: every stroke on
// the cover is a stroke the artist actually wrote.
//
// Two sources of letters:
//   sample   — the artist's own lockup photo (e.g. "moodmixformat / REGARDLESS"):
//              line 1 is kept WHOLE as the artist line; line 2 is split into
//              capitals using the known text, so its letters (R E G A D L S)
//              become glyphs, repeated letters giving natural variants.
//   alphabet — one photo of A–Z (optionally 0–9) written in reading order,
//              split the same way; fills in every letter the sample lacks.
//
// Pipeline for a photo (after extractHandwriting has lifted the ink to an
// alpha mask): find ink blobs → find the writing's slope (people write uphill)
// and straighten it → assign blobs to lines → group blobs into letters by
// horizontal overlap (an E's loose middle bar joins its E) → reconcile with
// the known text (split the widest group at its thinnest column when two
// letters touch; merge the closest pair when a letter broke in two) → crop
// each letter with its own baseline.
//
// Pure image maths + sharp; no server-only imports (scripts/handwriting-font-test.mjs).

import sharp from 'sharp'

export type Glyph = {
  char: string
  /** PNG: white RGB, alpha = ink. */
  png: Buffer
  width: number
  height: number
  /** y (px, inside the glyph) of the line the letter sits on. */
  baseline: number
}

export type HandwritingSet = {
  /** Artist line exactly as written (PNG, white + alpha), straightened. */
  artist: { png: Buffer; width: number; height: number; baseline: number } | null
  glyphs: Glyph[]
  /** Capital height in px of the source (median letter height), for scaling. */
  capHeight: number
  /** Median gap between letters, as a fraction of capHeight. */
  gap: number
  /** Distance from the artist baseline to the title baseline, × capHeight. */
  leading: number
  /** Title x offset from the artist line's left edge, × capHeight. */
  indent: number
  /** The writing's original slope in degrees (negative = uphill). */
  slant: number
}

type Blob = { x0: number; y0: number; x1: number; y1: number; area: number; cx: number; cy: number; id: number }

const INK = 90

async function readAlpha(png: Buffer) {
  const { data, info } = await sharp(png).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true })
  return { a: data, W: info.width, H: info.height }
}

function blobsOf(a: Buffer, W: number, H: number, minArea: number) {
  const lab = new Int32Array(W * H)
  const st = new Int32Array(W * H)
  const out: Blob[] = []
  for (let s = 0; s < W * H; s++) {
    if (a[s] < INK || lab[s]) continue
    const id = out.length + 1
    let sp = 0
    st[sp++] = s
    lab[s] = id
    let area = 0, sx = 0, sy = 0, x0 = W, y0 = H, x1 = -1, y1 = -1
    while (sp) {
      const i = st[--sp]
      const x = i % W, y = (i - x) / W
      area++; sx += x; sy += y
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      if (x > 0 && a[i - 1] >= INK && !lab[i - 1]) { lab[i - 1] = id; st[sp++] = i - 1 }
      if (x < W - 1 && a[i + 1] >= INK && !lab[i + 1]) { lab[i + 1] = id; st[sp++] = i + 1 }
      if (y > 0 && a[i - W] >= INK && !lab[i - W]) { lab[i - W] = id; st[sp++] = i - W }
      if (y < H - 1 && a[i + W] >= INK && !lab[i + W]) { lab[i + W] = id; st[sp++] = i + W }
    }
    out.push({ x0, y0, x1, y1, area, cx: sx / area, cy: sy / area, id })
  }
  return { lab, blobs: out.filter(b => b.area >= minArea) }
}

/**
 * Slope + line assignment in one search: the slope at which the blobs'
 * de-sloped heights fall into `lines` tightest clusters (1-D k-means).
 */
function fitLines(blobs: Blob[], lines: number) {
  let best = { err: Infinity, slope: 0, assign: [] as number[], centers: [] as number[] }
  for (let slope = -0.35; slope <= 0.35; slope += 0.0025) {
    const r = blobs.map(b => b.cy - slope * b.cx)
    const sorted = [...r].sort((x, y) => x - y)
    let centers = Array.from({ length: lines }, (_, k) => sorted[Math.floor(((k + 0.5) / lines) * sorted.length)])
    let assign: number[] = []
    for (let it = 0; it < 12; it++) {
      assign = r.map(v => centers.reduce((bi, c, i) => (Math.abs(v - c) < Math.abs(v - centers[bi]) ? i : bi), 0))
      centers = centers.map((c, k) => {
        let s = 0, w = 0
        r.forEach((v, i) => { if (assign[i] === k) { s += v * blobs[i].area; w += blobs[i].area } })
        return w ? s / w : c
      })
    }
    let err = 0
    r.forEach((v, i) => { err += (v - centers[assign[i]]) ** 2 * blobs[i].area })
    if (err < best.err) best = { err, slope, assign, centers }
  }
  return best
}

/** Rotate an alpha mask (as PNG) by deg, transparent fill; returns raw alpha. */
async function rotateAlpha(png: Buffer, deg: number) {
  const rotated = await sharp(png).ensureAlpha().rotate(deg, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer()
  return { png: rotated, ...(await readAlpha(rotated)) }
}

type Group = { blobs: Blob[]; x0: number; x1: number; y0: number; y1: number }
const groupOf = (bs: Blob[]): Group => ({
  blobs: bs,
  x0: Math.min(...bs.map(b => b.x0)), x1: Math.max(...bs.map(b => b.x1)),
  y0: Math.min(...bs.map(b => b.y0)), y1: Math.max(...bs.map(b => b.y1)),
})

/** Blobs of one line → letter groups (horizontal overlap joins strokes). */
function letterGroups(bs: Blob[]): Group[] {
  const sorted = [...bs].sort((p, q) => p.x0 - q.x0)
  const groups: Group[] = []
  for (const b of sorted) {
    const g = groups[groups.length - 1]
    const w = b.x1 - b.x0 + 1
    // Overlap by ≥ 40% of the narrower → same letter (E's bar, T's top).
    if (g) {
      const ov = Math.min(g.x1, b.x1) - Math.max(g.x0, b.x0)
      if (ov > 0.4 * Math.min(w, g.x1 - g.x0 + 1)) { groups[groups.length - 1] = groupOf([...g.blobs, b]); continue }
    }
    groups.push(groupOf([b]))
  }
  return groups
}

type Cut = { x0: number; x1: number; y0: number; y1: number; px: Set<number> }

/** Ink pixel indices of a group (its own blobs only), inside its box. */
function groupPixels(g: { x0: number; x1: number; y0: number; y1: number }, ids: Set<number>, a: Buffer, lab: Int32Array, W: number) {
  const px = new Set<number>()
  for (let y = g.y0; y <= g.y1; y++) for (let x = g.x0; x <= g.x1; x++) {
    const i = y * W + x
    if (a[i] >= INK && ids.has(lab[i])) px.add(i)
  }
  return px
}

function boxOf(px: Set<number>, W: number) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1
  for (const i of px) { const x = i % W, y = (i - x) / W; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
  return { x0, x1, y0, y1 }
}

/**
 * Split two touching letters. Candidate cut columns are tried thinnest first;
 * a cut is accepted only if removing a 3-px band there leaves exactly the kind
 * of split two letters make — two connected pieces, each at least a quarter of
 * the ink. (A thin column through one letter's own stroke, like an L's foot,
 * just chips off a sliver and is rejected.) Band pixels go to the nearer side.
 */
function splitTouching(c: Cut, W: number): [Cut, Cut] | null {
  const total = c.px.size
  const cols: { x: number; ink: number }[] = []
  const from = Math.round(c.x0 + (c.x1 - c.x0) * 0.15), to = Math.round(c.x1 - (c.x1 - c.x0) * 0.15)
  for (let x = from; x <= to; x++) {
    let ink = 0
    for (let y = c.y0; y <= c.y1; y++) if (c.px.has(y * W + x)) ink++
    cols.push({ x, ink })
  }
  cols.sort((p, q) => p.ink - q.ink)
  for (const { x: cx } of cols.slice(0, 40)) {
    const rest = new Set<number>()
    for (const i of c.px) { const x = i % W; if (Math.abs(x - cx) > 1) rest.add(i) }
    // Connected pieces of what's left.
    const seen = new Set<number>()
    const pieces: Set<number>[] = []
    for (const s of rest) {
      if (seen.has(s)) continue
      const piece = new Set<number>([s])
      seen.add(s)
      const st = [s]
      while (st.length) {
        const i = st.pop()!
        const x = i % W
        for (const j of [x > 0 ? i - 1 : -1, i + 1, i - W, i + W]) {
          if (j < 0 || seen.has(j) || !rest.has(j)) continue
          if (Math.abs((j % W) - x) > 1) continue
          seen.add(j); piece.add(j); st.push(j)
        }
      }
      pieces.push(piece)
    }
    const big = pieces.filter(p => p.size >= total * 0.25)
    if (big.length !== 2) continue
    const [L, R] = boxOf(big[0], W).x0 < boxOf(big[1], W).x0 ? big : [big[1], big[0]]
    // Everything else (the band, any crumbs) joins the nearer side by x.
    const lb = boxOf(L, W), rb = boxOf(R, W)
    for (const i of c.px) {
      if (L.has(i) || R.has(i)) continue
      const x = i % W
      ;(Math.abs(x - lb.x1) <= Math.abs(x - rb.x0) ? L : R).add(i)
    }
    const mk = (px: Set<number>): Cut => ({ ...boxOf(px, W), px })
    return [mk(L), mk(R)]
  }
  return null
}

/**
 * Make the letter count match the known text: split the widest letter where
 * two letters touch; merge the closest neighbours when a letter came apart.
 */
function reconcile(groups: Group[], want: number, a: Buffer, lab: Int32Array, W: number): Cut[] {
  const cuts: Cut[] = groups.map(g => {
    const px = groupPixels(g, new Set(g.blobs.map(b => b.id)), a, lab, W)
    return { ...boxOf(px, W), px }
  })
  const tried = new Set<Cut>()
  let guard = 0
  while (cuts.length < want && guard++ < 20) {
    const order = cuts.map((c, k) => ({ k, w: c.x1 - c.x0 })).filter(o => !tried.has(cuts[o.k])).sort((p, q) => q.w - p.w)
    if (!order.length) break
    const k = order[0].k
    const parts = splitTouching(cuts[k], W)
    if (!parts) { tried.add(cuts[k]); continue }
    cuts.splice(k, 1, ...parts)
  }
  guard = 0
  while (cuts.length > want && guard++ < 20) {
    let k = 0, gapMin = Infinity
    for (let i = 0; i < cuts.length - 1; i++) {
      const g = cuts[i + 1].x0 - cuts[i].x1
      if (g < gapMin) { gapMin = g; k = i }
    }
    const px = new Set([...cuts[k].px, ...cuts[k + 1].px])
    cuts.splice(k, 2, { ...boxOf(px, W), px })
  }
  return cuts
}

/** Crop a letter's own ink (soft anti-aliased edge kept) as a white+alpha PNG. */
async function cropInk(a: Buffer, W: number, H: number, r: { x0: number; x1: number; y0: number; y1: number }, px: Set<number>, pad = 3) {
  const x0 = Math.max(0, r.x0 - pad), x1 = Math.min(W - 1, r.x1 + pad)
  const y0 = Math.max(0, r.y0 - pad), y1 = Math.min(H - 1, r.y1 + pad)
  const w = x1 - x0 + 1, h = y1 - y0 + 1
  // Soft edge pixels (alpha < INK) belong to the letter if one of its own ink
  // pixels is within 2px.
  const near = (x: number, y: number) => {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue
      if (px.has(yy * W + xx)) return true
    }
    return false
  }
  const out = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = x + x0, sy = y + y0, si = sy * W + sx
    const v = a[si]
    if (!v) continue
    if (!(px.has(si) || (v < INK && near(sx, sy)))) continue
    const o = (y * w + x) * 4
    out[o] = out[o + 1] = out[o + 2] = 255
    out[o + 3] = v
  }
  return { png: await sharp(out, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer(), width: w, height: h, top: y0, left: x0 }
}

function median(v: number[]) { const s = [...v].sort((p, q) => p - q); return s.length ? s[Math.floor(s.length / 2)] : 0 }

/**
 * Split handwriting (white+alpha PNG from extractHandwriting) into lines and
 * letters, given the text that was written. `lines` is the written text, one
 * entry per line; spaces are ignored. Throws when the ink can't be matched to
 * the text (e.g. a line is missing).
 */
export async function splitHandwriting(png: Buffer, lines: string[]) {
  const first = await readAlpha(png)
  const pre = blobsOf(first.a, first.W, first.H, 25)
  if (pre.blobs.length === 0) throw new Error('No writing found.')
  const fit = fitLines(pre.blobs, lines.length)
  const slant = (Math.atan(fit.slope) * 180) / Math.PI
  // Straighten, then measure again on level writing.
  const lvl = await rotateAlpha(png, -slant)
  const { lab, blobs } = blobsOf(lvl.a, lvl.W, lvl.H, 25)
  const fit2 = fitLines(blobs, lines.length)
  const order = fit2.centers.map((c, i) => ({ c, i })).sort((p, q) => p.c - q.c).map(o => o.i)
  const out = lines.map((text, li) => {
    const k = order[li]
    const mine = blobs.filter((_, i) => fit2.assign[i] === k)
    const letters = text.replace(/\s+/g, '').split('')
    const cuts = reconcile(letterGroups(mine), letters.length, lvl.a, lab, lvl.W)
    return { text, letters, cuts }
  })
  return { level: lvl, lab, lines: out, slant }
}

/**
 * Build a handwriting set from the artist's lockup sample: line 1 (artist
 * name) kept whole, line 2 split into capital glyphs.
 */
export async function setFromSample(png: Buffer, artistText: string, titleText: string): Promise<HandwritingSet> {
  const { level, lab, lines, slant } = await splitHandwriting(png, [artistText, titleText])
  const [artistLine, titleLine] = lines
  const W = level.W, H = level.H
  const glyphs: Glyph[] = []
  const bottoms: number[] = []
  for (let i = 0; i < titleLine.cuts.length; i++) bottoms.push(titleLine.cuts[i].y1)
  // Baseline of the title line: median letter bottom (handwriting wobbles; the
  // median ignores a tail like an R's flourish).
  const titleBase = median(bottoms)
  const heights = titleLine.cuts.map(c => c.y1 - c.y0 + 1)
  const capHeight = median(heights)
  for (let i = 0; i < titleLine.cuts.length; i++) {
    const c = titleLine.cuts[i]
    const crop = await cropInk(level.a, W, H, c, c.px)
    glyphs.push({ char: titleLine.letters[i].toUpperCase(), png: crop.png, width: crop.width, height: crop.height, baseline: titleBase - crop.top })
  }
  const gaps: number[] = []
  for (let i = 1; i < titleLine.cuts.length; i++) gaps.push(titleLine.cuts[i].x0 - titleLine.cuts[i - 1].x1)
  const ab = artistLine.cuts
  const ar = { x0: Math.min(...ab.map(c => c.x0)), x1: Math.max(...ab.map(c => c.x1)), y0: Math.min(...ab.map(c => c.y0)), y1: Math.max(...ab.map(c => c.y1)) }
  const artistBase = median(ab.map(c => c.y1))
  const artistPx = new Set<number>()
  for (const c of ab) for (const i of c.px) artistPx.add(i)
  const artistCrop = await cropInk(level.a, W, H, ar, artistPx, 4)
  return {
    artist: { png: artistCrop.png, width: artistCrop.width, height: artistCrop.height, baseline: artistBase - artistCrop.top },
    glyphs,
    capHeight,
    gap: Math.max(0.05, median(gaps) / capHeight),
    leading: (titleBase - artistBase) / capHeight,
    indent: (titleLine.cuts[0].x0 - ar.x0) / capHeight,
    slant,
  }
}

// ── Writing new titles ─────────────────────────────────────────────────────

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

function hashText(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

/** The title as it will be written: capitals, letters/digits/spaces only. */
export function normalizeTitle(title: string): string {
  return title.toUpperCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Characters of `title` this set can't write yet. */
export function missingLetters(set: HandwritingSet, title: string): string[] {
  const have = new Set(set.glyphs.map(g => g.char))
  const miss = new Set<string>()
  for (const ch of normalizeTitle(title)) if (ch !== ' ' && !have.has(ch)) miss.add(ch)
  return [...miss].sort()
}

/** Break a long title onto two lines at the space nearest the middle. */
function wrap(title: string): string[] {
  if (title.length <= 14 || !title.includes(' ')) return [title]
  const mid = title.length / 2
  let best = -1
  for (let i = 0; i < title.length; i++) if (title[i] === ' ' && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i
  return [title.slice(0, best), title.slice(best + 1)]
}

/**
 * Write `title` in the artist's hand under their artist line, as one lockup
 * PNG (white + alpha — the same shape extractHandwriting produces, so it drops
 * straight into the lettering pipeline). Repeated letters rotate through the
 * variants the artist actually wrote; every letter gets a whisper of its own
 * size/tilt/baseline wobble; the whole lockup is tilted back to the artist's
 * own uphill slant. Deterministic per title. Throws when a letter is missing
 * (check missingLetters first).
 */
export async function writeTitle(set: HandwritingSet, title: string, opts: { artist?: boolean } = {}): Promise<{ png: Buffer; width: number; height: number }> {
  const text = normalizeTitle(title)
  if (!text) throw new Error('Nothing to write.')
  const missing = missingLetters(set, text)
  if (missing.length) throw new Error(`Missing letters: ${missing.join(' ')}`)
  const r = rng(hashText(text))
  const cap = set.capHeight
  const byChar = new Map<string, Glyph[]>()
  for (const g of set.glyphs) byChar.set(g.char, [...(byChar.get(g.char) ?? []), g])
  const used = new Map<string, number>()

  type Placed = { input: Buffer; left: number; top: number }
  const placed: Placed[] = []
  const lines = wrap(text)
  const lineGap = set.leading * cap * 0.92
  // Artist line first (as written), then title lines below it.
  let y = 0
  let minX = 0, maxX = 0, minY = Infinity, maxY = -Infinity
  const put = (input: Buffer, left: number, top: number, w: number, h: number) => {
    placed.push({ input, left: Math.round(left), top: Math.round(top) })
    minX = Math.min(minX, left); maxX = Math.max(maxX, left + w)
    minY = Math.min(minY, top); maxY = Math.max(maxY, top + h)
  }
  if (opts.artist !== false && set.artist) {
    put(set.artist.png, 0, -set.artist.baseline, set.artist.width, set.artist.height)
    y = lineGap
  }
  for (const line of lines) {
    let x = set.indent * cap
    for (const ch of line) {
      if (ch === ' ') { x += cap * 0.55; continue }
      const variants = byChar.get(ch)!
      const n = used.get(ch) ?? 0
      used.set(ch, n + 1)
      const g = variants[n % variants.length]
      // Scale to this set's cap height (alphabet glyphs come from another photo).
      const gc = (g as Glyph & { cap?: number }).cap ?? cap
      const s = (cap / gc) * (0.97 + r() * 0.06)
      const tilt = (r() - 0.5) * 3
      const w = Math.max(1, Math.round(g.width * s)), h = Math.max(1, Math.round(g.height * s))
      let img = await sharp(g.png).resize(w, h, { fit: 'fill' }).png().toBuffer()
      let iw = w, ih = h
      if (Math.abs(tilt) > 0.2) {
        img = await sharp(img).rotate(tilt, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer()
        const m = await sharp(img).metadata()
        iw = m.width ?? w; ih = m.height ?? h
      }
      const bob = (r() - 0.5) * 0.04 * cap
      const top = y - g.baseline * s - (ih - h) / 2 + bob
      put(img, x - (iw - w) / 2, top, iw, ih)
      x += w + set.gap * cap * (0.85 + r() * 0.3)
    }
    y += lineGap * 0.95
  }
  const pad = Math.round(cap * 0.1)
  const W = Math.ceil(maxX - minX) + pad * 2, H = Math.ceil(maxY - minY) + pad * 2
  const flat = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } } })
    .composite(placed.map(p => ({ input: p.input, left: p.left - Math.floor(minX) + pad, top: p.top - Math.floor(minY) + pad, blend: 'over' as const })))
    .png()
    .toBuffer()
  // Back to the artist's own uphill slant, then trim.
  const slanted = await sharp(flat).rotate(set.slant, { background: { r: 255, g: 255, b: 255, alpha: 0 } }).png().toBuffer()
  const trimmed = await sharp(slanted).trim({ background: { r: 255, g: 255, b: 255, alpha: 0 }, threshold: 1 }).png().toBuffer()
  // Whiten RGB (rotation/resize can leave grey fringes in RGB under alpha).
  const { data, info } = await sharp(trimmed).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  for (let i = 0; i < data.length; i += 4) { data[i] = data[i + 1] = data[i + 2] = 255 }
  const png = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer()
  return { png, width: info.width, height: info.height }
}
