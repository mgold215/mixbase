#!/usr/bin/env node
// Contract test for the handwriting glyph bank — "type in your own handwriting":
//   src/lib/handwriting-glyphs.ts  glyph keys, segmentation, labelling, composition
//
// Drives the real sharp pipeline on synthetic lettering so every assertion is
// about pixels and counts. The promise under test: a photo of separated
// letters plus the text it says becomes one sample per letter (dots joined to
// their i, lines told apart, x-height and baseline measured from the letters
// that define them); a count that disagrees is refused rather than guessed; a
// typed title is set from those samples only, scaled to one x-height, on a
// baseline, missing letters reported, never invented; and a key can never
// name another user's sample.
//
// Run: node scripts/handwriting-glyphs-test.mjs  (also part of `npm test`)

import sharp from 'sharp'
import {
  CAP, CAP_OVER_X, GLYPH_CHARS, PEN_STYLES, composeHandwriting, glyphKey, isGlyphChar, isPenStyle, labelGlyphs, letterGap,
  letteringAlpha, parseGlyphKey, robustLine, segmentGlyphs, teachGlyphs, textLines,
} from '../src/lib/handwriting-glyphs.ts'

let failures = 0
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`)
  else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures++ }
}

const svg = (w, h, body) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`))

// Hand-built "letters" (no system font, so counts are exact): on line 1 a
// cap T, an o, an i with its dot and a tall l; on line 2 a g with a tail, an
// o and a full stop. Baselines at y=200 and y=420; x-height 60.
const INK = '#1a1a1a'
const LETTERS = `
  <path d="M60 110 L140 110 M100 110 L100 200" stroke="${INK}" stroke-width="14" fill="none"/>
  <circle cx="210" cy="170" r="24" stroke="${INK}" stroke-width="12" fill="none"/>
  <path d="M290 146 L290 200" stroke="${INK}" stroke-width="14"/><circle cx="290" cy="118" r="8" fill="${INK}"/>
  <path d="M360 100 L360 200" stroke="${INK}" stroke-width="14"/>
  <circle cx="110" cy="390" r="24" stroke="${INK}" stroke-width="12" fill="none"/><path d="M134 390 L134 450 Q134 470 100 462" stroke="${INK}" stroke-width="12" fill="none"/>
  <circle cx="210" cy="390" r="24" stroke="${INK}" stroke-width="12" fill="none"/>
  <circle cx="280" cy="414" r="7" fill="${INK}"/>
`
const letteringPng = await svg(460, 520, `<rect width="460" height="520" fill="#fff"/>${LETTERS}`)
  .negate({ alpha: false }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  .then(({ data, info }) => {
    // Ink → white RGB with the darkness as alpha (the shape extractHandwriting returns).
    const out = Buffer.alloc(info.width * info.height * 4)
    for (let i = 0; i < info.width * info.height; i++) {
      out[i * 4] = 255; out[i * 4 + 1] = 255; out[i * 4 + 2] = 255; out[i * 4 + 3] = data[i * 4]
    }
    return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer()
  })

// ── Keys ────────────────────────────────────────────────────────────────────
console.log('glyph keys')
{
  const me = '11111111-2222-4333-8444-555555555555', them = '99999999-2222-4333-8444-555555555555'
  const k = glyphKey(me, 'a', 61.4, 70.6, 1790000000000)
  check('key carries the code point, unit and baseline', k === `studio/${me}/glyph-0061-61-71-1790000000000.png`, k)
  const p = parseGlyphKey(k, me)
  check('round-trips', p && p.char === 'a' && p.unit === 61 && p.base === 71 && p.ts === '1790000000000', JSON.stringify(p))
  check("another user's key is not mine", parseGlyphKey(k, them) === null)
  check('a space is not a glyph', !isGlyphChar(' ') && parseGlyphKey(`studio/${me}/glyph-0020-61-71-1790000000000.png`, me) === null)
  check('a subject or lettering key is not a glyph', parseGlyphKey(`studio/${me}/subject-1790000000000.png`, me) === null)
  check('nested or malformed keys are rejected', parseGlyphKey(`studio/${me}/x/glyph-0061-61-71-1790000000000.png`, me) === null && parseGlyphKey(`studio/${me}/glyph-0061-061-71-1790000000000.png`, me) === null)
  check('every teachable character makes a valid key', [...GLYPH_CHARS].every(c => parseGlyphKey(glyphKey(me, c, 50, 50, 1790000000000), me)?.char === c))
  let threw = false
  try { glyphKey(me, '€', 50, 50, 1) } catch { threw = true }
  check('an unteachable character throws', threw)
  check('text lines: trimmed, blanks dropped, spaces collapsed', JSON.stringify(textLines('  Toil \n\n go  on \n')) === JSON.stringify(['Toil', 'go on']))
}

// ── Segmentation + labelling ────────────────────────────────────────────────
console.log('\nsegmentation + labelling')
const { alpha, width, height } = await letteringAlpha(letteringPng)
const rows = segmentGlyphs(alpha, width, height)
check('two lines of writing', rows.length === 2, String(rows.length))
check('four letters on line 1 (the i-dot joined to its i)', rows[0]?.glyphs.length === 4, String(rows[0]?.glyphs.length))
check('three on line 2 (the full stop counts)', rows[1]?.glyphs.length === 3, String(rows[1]?.glyphs.length))
check('letters come out left to right', rows[0]?.glyphs.every((g, i, a) => i === 0 || g.x0 > a[i - 1].x0))
{
  const res = labelGlyphs(rows, 'Toil\ngo.')
  check('labels match the text', res.ok && res.glyphs.map(g => g.char).join('') === 'Toilgo.', res.ok ? res.glyphs.map(g => g.char).join('') : res.error)
  if (res.ok) {
    const g = Object.fromEntries(res.glyphs.map(x => [x.char, x]))
    check('x-height measured from the o (≈60px)', Math.abs(g.o.unit - 60) <= 3, String(g.o.unit))
    check('the tall l shares the line\'s unit', g.l.unit === g.o.unit)
    check('baseline: the o sits on it', Math.abs(g.o.base - (g.o.y1 - g.o.y0 + 1)) <= 2, `${g.o.base} vs ${g.o.y1 - g.o.y0 + 1}`)
    check('baseline: the l reaches down to it from higher up', g.l.base > g.o.base + 30, String(g.l.base))
    check('the g hangs below the baseline', g.g.base < g.g.y1 - g.g.y0 + 1 - 30, `${g.g.base} of ${g.g.y1 - g.g.y0 + 1}`)
    check('the i includes its dot', g.i.y0 < g.o.y0 - 10, `${g.i.y0} vs ${g.o.y0}`)
  }
  const bad = labelGlyphs(rows, 'Toil\ngone')
  check('a count mismatch is refused, naming the line', !bad.ok && /Line 2/.test(bad.error) && bad.rows[1].found === 3 && bad.rows[1].expected === 4, bad.ok ? 'ok?!' : bad.error)
  const lines = labelGlyphs(rows, 'Toilgo.')
  check('a line-count mismatch is refused', !lines.ok && /2 lines/.test(lines.error), lines.ok ? 'ok?!' : lines.error)
  const chars = labelGlyphs(rows, 'Toil\ngo€')
  check('an unteachable character is refused', !chars.ok && /€/.test(chars.error))
}

// ── Teaching from a photo ───────────────────────────────────────────────────
console.log('\nteaching from a photo')
const photo = await svg(1200, 800, `
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e8eaec"/><stop offset="1" stop-color="#bcc0c4"/></linearGradient></defs>
  <rect width="1200" height="800" fill="url(#g)"/>
  <g transform="translate(300 120) scale(1.4)">${LETTERS}</g>
`).jpeg({ quality: 90 }).toBuffer()
const taught = await teachGlyphs({ photo }, 'Toil\ngo.')
check('seven samples taught', taught.ok && taught.glyphs.length === 7, taught.ok ? String(taught.glyphs.length) : taught.error)
let bank = []
if (taught.ok) {
  bank = taught.glyphs.map(g => ({ char: g.char, unit: g.unit, base: g.base, png: g.png }))
  check('each sample is a PNG of its own box', taught.glyphs.every(g => g.png[0] === 0x89 && g.width > 4 && g.height > 4))
  const o = taught.glyphs.find(g => g.char === 'o')
  check('units scale with the photo (≈84px for a 1.4× shot)', o && Math.abs(o.unit - 84) <= 5, String(o?.unit))
}
const fromLettering = await teachGlyphs({ lettering: letteringPng }, 'Toil\ngo.')
check('an existing lettering teaches the same letters', fromLettering.ok && fromLettering.glyphs.map(g => g.char).join('') === 'Toilgo.')

// ── Composition ─────────────────────────────────────────────────────────────
console.log('\ncomposition')
{
  const one = await composeHandwriting('Toil', bank, { seed: 7 })
  check('a typed word becomes a lettering', one.ok && one.lettering.png[0] === 0x89, one.ok ? '' : JSON.stringify(one))
  if (one.ok) {
    const { alpha: a, width: w, height: h } = await letteringAlpha(one.lettering.png)
    let ink = 0
    for (let i = 0; i < a.length; i++) if (a[i] > 128) ink++
    check('…with ink in it', ink > 2000, String(ink))
    check('…wider than tall', w > h * 1.5, `${w}x${h}`)
    // Scaled to one x-height: the o (ring, 60px in its photo) comes out
    // CAP / 1.45 tall; the lettering (with the l's ascender) is taller than
    // that but under 2 x-heights.
    check('…set at the common x-height', h > 130 && h < 260, `${h}`)
    check('…and says how tall its capitals are and how wide its pen', one.cap === CAP && one.stroke > 4 && one.stroke < CAP / 3, `${one.cap} ${one.stroke}`)
    const again = await composeHandwriting('Toil', bank, { seed: 7 })
    check('same seed → same lettering', again.ok && again.lettering.png.equals(one.lettering.png))
    const other = await composeHandwriting('Toil', bank, { seed: 8 })
    check('another seed → a different take', other.ok && !other.lettering.png.equals(one.lettering.png))
  }
  const two = await composeHandwriting('Toil\ngo.', bank, { seed: 7 })
  check('two lines stack', two.ok && one.ok && two.lettering.height > one.lettering.height * 1.6, two.ok && one.ok ? `${two.lettering.height} vs ${one.lettering.height}` : '')
  const borrowed = await composeHandwriting('toil', bank, { seed: 7 })
  check('a letter borrows the other case when only that was taught', borrowed.ok)
  const missing = await composeHandwriting('Toil zap', bank, { seed: 7 })
  check('untaught letters are reported, never invented', !missing.ok && missing.missing.sort().join('') === 'apz', JSON.stringify(missing))
  const spaced = await composeHandwriting('T o', bank, { seed: 7 })
  const tight = await composeHandwriting('To', bank, { seed: 7 })
  check('a space widens the word', spaced.ok && tight.ok && spaced.lettering.width > tight.lettering.width + 40)
  const empty = await composeHandwriting('   ', bank, { seed: 7 })
  check('blank text composes nothing', !empty.ok && empty.missing.length === 0)
}

// ── A sign-writer's setting ─────────────────────────────────────────────────
console.log('\na row that climbs, capitals of different sizes')
{
  // Seven capitals written along a line that climbs 5° (dy/dx = -0.0875), one
  // smaller than the rest, one (the J) hanging 45px below the line.
  const line = x => 300 - 0.0875 * x
  const boxes = []
  const chars = 'HEILTJO'
  for (let i = 0; i < chars.length; i++) {
    const x0 = 40 + i * 110, x1 = x0 + 70, mid = (x0 + x1) / 2
    const tall = chars[i] === 'I' ? 100 : 140
    const hang = chars[i] === 'J' ? 45 : 0
    boxes.push({ x0, y0: Math.round(line(mid) - tall), x1, y1: Math.round(line(mid) + hang) })
  }
  const row = { glyphs: boxes, y0: Math.min(...boxes.map(b => b.y0)), y1: Math.max(...boxes.map(b => b.y1)) }
  const res = labelGlyphs([row], chars)
  check('the row is labelled', res.ok, res.ok ? '' : res.error)
  if (res.ok) {
    const g = Object.fromEntries(res.glyphs.map(x => [x.char, x]))
    const h = c => g[c].y1 - g[c].y0 + 1
    check('a capital on the line stands on its own foot, wherever the line had climbed to', ['H', 'E', 'L', 'T', 'O'].every(c => g[c].base === h(c)), ['H', 'E', 'L', 'T', 'O'].map(c => `${g[c].base}/${h(c)}`).join(' '))
    check('…and is measured by its own height', ['H', 'E', 'L', 'T', 'O'].every(c => Math.abs(g[c].unit * CAP_OVER_X - h(c)) <= 1.5))
    check('a capital written smaller is its own measure too (it will be set as tall as the rest)', g.I.base === h('I') && Math.abs(g.I.unit * CAP_OVER_X - 100) <= 1.5, `${g.I.unit}`)
    check('the J keeps its tail: measured from the line up', Math.abs(g.J.base - 141) <= 3 && Math.abs(g.J.unit * CAP_OVER_X - 141) <= 3, `${g.J.base} ${g.J.unit}`)
  }
  const fit = robustLine([0, 100, 200, 300, 400, 500], [300, 291, 283, 274, 330, 256])
  check('one letter hanging below does not pull the line off the others', Math.abs(fit(400) - 265) < 3 && Math.abs(fit(0) - 300) < 3, `${fit(0)} ${fit(400)}`)
}

console.log('\nset like a sign-writer would')
{
  // A bank of capitals drawn by a fat pen (26px on a 120px letter) at
  // different sizes: an H 120px tall, an I only 80px tall, an L and a T.
  const glyph = async (w, h, body) => {
    const { data, info } = await svg(w, h, `<rect width="${w}" height="${h}" fill="#000"/>${body}`).greyscale().raw().toBuffer({ resolveWithObject: true })
    const out = Buffer.alloc(w * h * 4)
    for (let i = 0; i < w * h; i++) { out[i * 4] = 255; out[i * 4 + 1] = 255; out[i * 4 + 2] = 255; out[i * 4 + 3] = data[i * info.channels] }
    return sharp(out, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer()
  }
  const pen = 'stroke="#fff" stroke-width="26" stroke-linecap="round" fill="none"'
  const caps = [
    { char: 'H', unit: 120 / CAP_OVER_X, base: 120, png: await glyph(100, 120, `<path d="M13 13 L13 107 M87 13 L87 107 M13 60 L87 60" ${pen}/>`) },
    { char: 'I', unit: 80 / CAP_OVER_X, base: 80, png: await glyph(18, 80, `<path d="M9 9 L9 71" stroke="#fff" stroke-width="18" stroke-linecap="round"/>`) },
    { char: 'L', unit: 120 / CAP_OVER_X, base: 120, png: await glyph(90, 120, `<path d="M13 13 L13 107 L77 107" ${pen} stroke-linejoin="round"/>`) },
    { char: 'T', unit: 120 / CAP_OVER_X, base: 120, png: await glyph(110, 120, `<path d="M13 13 L97 13 M55 13 L55 107" ${pen}/>`) },
  ]
  const columns = async png => {
    const { alpha: a, width: w, height: h } = await letteringAlpha(png)
    // Runs of inked columns = letters; each with its top and bottom row.
    const runs = []
    let open = null
    for (let x = 0; x <= w; x++) {
      let top = -1, bottom = -1
      if (x < w) for (let y = 0; y < h; y++) if (a[y * w + x] > 128) { if (top < 0) top = y; bottom = y }
      if (top >= 0) { open ??= { x0: x, top, bottom }; open.x1 = x; open.top = Math.min(open.top, top); open.bottom = Math.max(open.bottom, bottom) }
      else if (open) { runs.push(open); open = null }
    }
    return runs
  }
  const hi = await composeHandwriting('HI', caps, { seed: 1 })
  const runs = hi.ok ? await columns(hi.lettering.png) : []
  // H is two stems and a bar: one run; I is another.
  check('two letters set', hi.ok && runs.length === 2, hi.ok ? String(runs.length) : JSON.stringify(hi))
  if (runs.length === 2) {
    const [H, I] = runs
    check('the small I is set as tall as the H', Math.abs((H.bottom - H.top) - (I.bottom - I.top)) <= 4, `${H.bottom - H.top} vs ${I.bottom - I.top}`)
    check('…both a capital height tall', Math.abs((H.bottom - H.top + 1) - CAP) <= 4, String(H.bottom - H.top + 1))
    check('…standing on one line', Math.abs(H.bottom - I.bottom) <= 2 && Math.abs(H.top - I.top) <= 4, `${H.bottom} ${I.bottom}`)
    check('…never touching', I.x0 - H.x1 >= CAP * 0.06, String(I.x0 - H.x1))
  }
  // One pen: the fat strokes are traced to the weight asked for, whatever size the letter was written.
  check('medium pen ≈ an eighth of the capital', hi.ok && hi.stroke > CAP / 9.5 && hi.stroke < CAP / 6.5, hi.ok ? String(hi.stroke) : '')
  const fine = await composeHandwriting('HI', caps, { seed: 1, pen: 'fine' }), bold = await composeHandwriting('HI', caps, { seed: 1, pen: 'bold' }), asis = await composeHandwriting('HI', caps, { seed: 1, pen: 'marker' })
  check('fine < medium < bold', fine.ok && bold.ok && fine.stroke < hi.stroke - 2 && hi.stroke < bold.stroke - 2, `${fine.ok && fine.stroke} ${hi.stroke} ${bold.ok && bold.stroke}`)
  check('marker: the letters as they were written (26px on 120 → about 36px here)', asis.ok && asis.stroke > bold.stroke && asis.stroke > CAP / 5.5, asis.ok ? String(asis.stroke) : '')
  check('pen names', isPenStyle('fine') && isPenStyle('marker') && !isPenStyle('brush') && PEN_STYLES.length === 4)
  // Spacing by the white between the shapes: an open pair is drawn together, a straight pair is not.
  const lt = await composeHandwriting('LT', caps, { seed: 1 }), hh = await composeHandwriting('HH', caps, { seed: 1 })
  const width = async r => (await sharp(r.lettering.png).metadata()).width
  const single = async c => width(await composeHandwriting(c, caps, { seed: 1 }))
  if (lt.ok && hh.ok) {
    const gapLT = (await width(lt)) - (await single('L')) - (await single('T'))
    const gapHH = (await width(hh)) - 2 * (await single('H'))
    check('L and T tuck together; H and H keep their distance', gapLT < gapHH - CAP * 0.08, `${gapLT.toFixed(0)} vs ${gapHH.toFixed(0)}`)
    check('…and H–H is the plain tracking', Math.abs(gapHH - CAP * 0.17) < CAP * 0.06, gapHH.toFixed(0))
  }
  const flat = (w, right, left) => ({ width: w, right: new Int16Array(CAP).fill(right), left: new Int16Array(CAP).fill(left) })
  check('letterGap: two straight sides get the tracking', Math.abs(letterGap(flat(100, 99, 0), flat(100, 99, 0)) - CAP * 0.17) < 0.5)
  check('letterGap: two open sides get less, but never touch', letterGap(flat(100, 60, 0), flat(100, 99, 40)) < CAP * 0.17 - 10 && letterGap(flat(100, 60, 0), flat(100, 99, 40)) + 39 + 40 >= CAP * 0.08 - 0.5)
  // No jitter: the same title is the same picture when there is one sample of each letter.
  const a1 = await composeHandwriting('HILT', caps, { seed: 1 }), a2 = await composeHandwriting('HILT', caps, { seed: 99 })
  check('one sample per letter → the same lettering whatever the seed', a1.ok && a2.ok && a1.lettering.png.equals(a2.lettering.png))
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\nall handwriting-glyphs checks passed')
