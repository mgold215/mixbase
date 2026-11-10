#!/usr/bin/env node
// Contract test for the handwriting PEN — the same letters traced with a
// finer pen (src/lib/handwriting-pen.ts).
//
// The promise under test: a fat marker's letter comes out with the stroke
// weight asked for and NOTHING else changed — it stays one piece, its
// counters stay open, it keeps its place, and the beads of ink at its stroke
// ends are gone rather than louder; a thin stroke between fat ones survives;
// a line of writing that climbs is levelled with its upright strokes still
// upright; and the body of a line (baseline, x-height) is found from its ink.
//
// Pure maths over alpha fields — no sharp needed beyond drawing the fixtures.
//
// Run: node scripts/handwriting-pen-test.mjs  (also part of `npm test`)

import sharp from 'sharp'
import {
  PEN_SCALE, cropField, distanceTo, insetFor, lineBody, lineSlopeOf, repen, shearLevel, strokeWidthOf,
} from '../src/lib/handwriting-pen.ts'

let failures = 0
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`)
  else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures++ }
}

/** Draw white-on-black SVG shapes and return them as an alpha field. */
async function field(w, h, body) {
  const { data, info } = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#000"/>${body}</svg>`))
    .greyscale().raw().toBuffer({ resolveWithObject: true })
  const alpha = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) alpha[i] = data[i * info.channels]
  return { alpha, width: w, height: h }
}
const at = (f, x, y) => f.alpha[Math.round(y) * f.width + Math.round(x)]
/** Pieces of ink and enclosed holes (4-connected flood fills). */
function shape(f) {
  const { alpha, width: W, height: H } = f
  const w = W + 2, h = H + 2
  const ink = new Uint8Array(w * h)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (alpha[y * W + x] > 127) ink[(y + 1) * w + x + 1] = 1
  const seen = new Uint8Array(w * h)
  const fill = (start, v) => {
    const stack = [start]; seen[start] = 1; let n = 0
    while (stack.length) {
      const i = stack.pop(); n++
      const x = i % w, y = (i - x) / w
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
        const j = yy * w + xx
        if (!seen[j] && ink[j] === v) { seen[j] = 1; stack.push(j) }
      }
    }
    return n
  }
  let parts = 0, holes = -1 // the outside is one background region
  for (let i = 0; i < w * h; i++) {
    if (seen[i]) continue
    const n = fill(i, ink[i])
    if (n < 12) continue
    if (ink[i]) parts++
    else holes++
  }
  return { parts, holes }
}

// ── Distances ───────────────────────────────────────────────────────────────
console.log('distance to the edge')
{
  const sq = await field(61, 61, '<rect x="20" y="20" width="21" height="21" fill="#fff"/>')
  const mask = Uint8Array.from(sq.alpha, v => (v > 127 ? 1 : 0))
  const inside = distanceTo(mask, 61, 61, 0)
  check('the middle of a 21px square is 11px from the paper', Math.abs(inside[30 * 61 + 30] - 11) < 0.01, String(inside[30 * 61 + 30]))
  check('its corner pixel is 1px from the paper', Math.abs(inside[20 * 61 + 20] - 1) < 0.01)
  check('paper is 0 from paper', inside[5 * 61 + 5] === 0)
  const outside = distanceTo(mask, 61, 61, 1)
  check('distance to the ink is exact on the diagonal', Math.abs(outside[10 * 61 + 10] - Math.hypot(10, 10)) < 0.01, String(outside[10 * 61 + 10]))
  const none = distanceTo(new Uint8Array(100), 10, 10, 1)
  check('no ink at all: every distance is the diagonal, not infinity', Number.isFinite(none[0]) && none[0] > 14 && none[0] < 15)
}

// ── Stroke width ────────────────────────────────────────────────────────────
console.log('\nstroke width')
{
  const bar = await field(400, 120, '<path d="M40 60 L360 60" stroke="#fff" stroke-width="24" stroke-linecap="round"/>')
  check('a 24px stroke measures 24px', Math.abs(strokeWidthOf(bar) - 24) <= 1.5, strokeWidthOf(bar).toFixed(1))
  // The same pen, with a blob where two strokes ran together: still the pen's width.
  const blobbed = await field(400, 300, '<path d="M40 60 L360 60 M200 60 L200 260" stroke="#fff" stroke-width="24" stroke-linecap="round"/><circle cx="200" cy="60" r="44" fill="#fff"/>')
  check('a blob where strokes ran together does not pass for the pen', Math.abs(strokeWidthOf(blobbed) - 24) <= 2.5, strokeWidthOf(blobbed).toFixed(1))
  // A letter cut tight to its ink (no paper at its edges) measures the same.
  const tight = cropField(bar)
  check('a letter cropped to its ink measures the same', Math.abs(strokeWidthOf(tight) - 24) <= 1.5, strokeWidthOf(tight).toFixed(1))
  check('nothing written → 0', strokeWidthOf(await field(50, 50, '')) === 0)
  check('inset: 30px on a 150px capital to an eighth leaves 17.1px', Math.abs((30 - 2 * insetFor(30, 150, 1 / 8)) / (150 - 2 * insetFor(30, 150, 1 / 8)) - 1 / 8) < 1e-9)
}

// ── Tracing finer ───────────────────────────────────────────────────────────
console.log('\ntracing a fat marker finer')
{
  // An "A": two legs and a bar, 30px marker, 150px tall, with a counter; a
  // bead of ink where the pen lifted off at the right foot.
  const A = await field(220, 200,
    '<path d="M40 175 L110 30 L180 175 M72 120 L148 120" stroke="#fff" stroke-width="30" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
    + '<path d="M180 175 L192 196" stroke="#fff" stroke-width="9" stroke-linecap="round"/>')
  const from = strokeWidthOf(A)
  const inset = insetFor(from, 150, 1 / 8)
  const out = repen(A, inset, { stroke: from })
  check('the result keeps the field size', out.field.width === 220 && out.field.height === 200)
  check('the stroke comes out at the weight asked for', Math.abs(strokeWidthOf(out.field) - (from - 2 * inset)) <= 2.2, `${strokeWidthOf(out.field).toFixed(1)} vs ${(from - 2 * inset).toFixed(1)}`)
  check('…and reports what it did', Math.abs(out.inset - inset) < 1e-6 && Math.abs(out.to - (from - 2 * inset)) < 1e-6)
  const before = shape(A), after = shape(out.field)
  check('still one piece, counter still open', after.parts === 1 && after.holes === before.holes && before.holes === 1, JSON.stringify({ before, after }))
  check('the middle of a stroke is still ink, its old edge is now paper', at(out.field, 75, 102) > 200 && at(out.field, 75 - 15, 102 + 6) < 40, `${at(out.field, 75, 102)} ${at(out.field, 60, 108)}`)
  check('the bead of ink at the foot is gone, not louder', at(out.field, 190, 193) < 40 && at(A, 190, 193) > 200, `${at(out.field, 190, 193)}`)
  check('the foot itself is still there', at(out.field, 176, 166) > 200, String(at(out.field, 176, 166)))

  // An "8": two small counters a fat marker nearly closed. Both must survive.
  const eight = await field(160, 240, '<circle cx="80" cy="72" r="36" stroke="#fff" stroke-width="30" fill="none"/><circle cx="80" cy="162" r="42" stroke="#fff" stroke-width="30" fill="none"/>')
  const e = repen(eight, insetFor(30, 220, 1 / 8), { stroke: 30 })
  check('an 8 keeps both counters', shape(e.field).holes === 2 && shape(e.field).parts === 1, JSON.stringify(shape(e.field)))

  // A hairline joining two fat strokes (the pen ran dry): kept at the nib's width.
  const dry = await field(360, 200, '<path d="M60 30 L60 170 M300 30 L300 170" stroke="#fff" stroke-width="30" stroke-linecap="round"/><path d="M60 100 L300 100" stroke="#fff" stroke-width="9"/>')
  const d = repen(dry, 7, { stroke: 30 })
  check('a hairline thinner than what is taken off is kept, not erased', shape(d.field).parts === 1 && at(d.field, 180, 100) > 150, JSON.stringify(shape(d.field)) + ' ' + at(d.field, 180, 100))
  check('…and never drawn wider than it was', at(d.field, 180, 100 - 7) < 60, String(at(d.field, 180, 93)))

  // Nothing to do → the field itself; hi → the clean master, PEN_SCALE times larger.
  const same = repen(A, 0.1, { stroke: from })
  check('an inset under a third of a pixel changes nothing', same.field === A && same.inset === 0)
  const hi = repen(A, inset, { stroke: from, hi: true })
  check('hi: the master is PEN_SCALE times the input', hi.field.width === 220 * PEN_SCALE && hi.field.height === 200 * PEN_SCALE)
  check('hi: same letter (middle of a stroke is ink at the scaled place)', at(hi.field, 75 * PEN_SCALE, 102 * PEN_SCALE) > 200)
  const plain = repen(A, 0, { stroke: from, hi: true })
  check('hi with no inset still returns the master (a clean enlargement)', plain.field.width === 220 * PEN_SCALE && plain.inset === 0 && shape(plain.field).holes === 1)

  // A thin pen made fuller.
  const thin = await field(220, 200, '<path d="M40 175 L110 30 L180 175 M72 120 L148 120" stroke="#fff" stroke-width="6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>')
  const fuller = repen(thin, -3, { stroke: 6 })
  check('a negative inset widens the stroke', Math.abs(strokeWidthOf(fuller.field) - 12) <= 2, strokeWidthOf(fuller.field).toFixed(1))
}

// ── Levelling ───────────────────────────────────────────────────────────────
console.log('\nlevelling a line that climbs')
{
  let stems = ''
  for (let i = 0; i < 9; i++) { const x = 40 + i * 60; stems += `<rect x="${x}" y="${190 - 0.12 * x - 70}" width="14" height="70" fill="#fff"/>` }
  const line = await field(600, 220, stems)
  const slope = lineSlopeOf(line)
  check('the slope is read off the feet (dy/dx ≈ −0.12)', Math.abs(slope + 0.12) < 0.01, slope.toFixed(4))
  const level = shearLevel(line, slope)
  const feet = []
  for (let x = 0; x < level.width; x++) for (let y = level.height - 1; y >= 0; y--) if (level.alpha[y * level.width + x] > 127) { feet.push(y); break }
  check('after the shear every foot is on one row', Math.max(...feet) - Math.min(...feet) <= 2, `${Math.min(...feet)}..${Math.max(...feet)}`)
  // Upright strokes stay upright: a stem is still 14 columns wide.
  let cols = 0
  for (let x = 30; x < 70; x++) { let any = false; for (let y = 0; y < level.height; y++) if (level.alpha[y * level.width + x] > 127) any = true; if (any) cols++ }
  check('upright strokes stay upright (a shear, not a rotation)', cols === 14, String(cols))
  check('a level line is left alone', shearLevel(level, 0) === level && Math.abs(lineSlopeOf(level)) < 0.01)
  check('too little ink to tell: no slope', lineSlopeOf(await field(40, 40, '<rect x="10" y="10" width="6" height="20" fill="#fff"/>')) === 0)
}

// ── The body of a line ──────────────────────────────────────────────────────
console.log('\nthe body of a line')
{
  // Lowercase: ten small letters 60px tall on a baseline at y=160, two with
  // ascenders reaching y=40, one with a descender to y=200.
  let ink = ''
  for (let i = 0; i < 10; i++) ink += `<rect x="${30 + i * 50}" y="100" width="30" height="60" fill="#fff"/>`
  ink += '<rect x="130" y="40" width="10" height="70" fill="#fff"/><rect x="380" y="40" width="10" height="70" fill="#fff"/><rect x="230" y="150" width="10" height="50" fill="#fff"/>'
  const body = lineBody(await field(560, 240, ink))
  check('the body is the band of small letters', body && Math.abs(body.top - 100) <= 3 && Math.abs(body.baseline - 159) <= 3, JSON.stringify(body))
  check('…ascenders and descenders are outside it', body && body.inkTop <= 41 && body.inkBottom >= 198, JSON.stringify(body))
  check('an empty field has no body', lineBody(await field(40, 40, '')) === null)
  const c = cropField(await field(100, 80, '<rect x="20" y="30" width="40" height="10" fill="#fff"/>'))
  check('cropField: the ink box and where it was', c && c.width === 40 && c.height === 10 && c.left === 20 && c.top === 30, JSON.stringify(c && { w: c.width, h: c.height, l: c.left, t: c.top }))
  check('cropField: nothing → null', cropField(await field(20, 20, '')) === null)
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\nall handwriting-pen checks passed')
