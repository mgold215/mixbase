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
  GLYPH_CHARS, composeHandwriting, glyphKey, isGlyphChar, labelGlyphs, letteringAlpha, parseGlyphKey,
  segmentGlyphs, teachGlyphs, textLines,
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
    // Scaled to one x-height: the o (ring, 60px in its photo) should come
    // out about UNIT (110px) tall; the lettering (with the l's ascender) is
    // taller than that but under 2 x-heights.
    check('…set at the common x-height', h > 130 && h < 260, `${h}`)
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

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\nall handwriting-glyphs checks passed')
