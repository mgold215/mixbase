// Finalize renderer smoke test — exercises the REAL production module
// (src/lib/finalize-render.ts, imported via Node's type stripping), not a copy.
// A previous version of this script re-implemented the renderer inline, which
// let the real code ship a black-text regression the test could never see.
//
// Run: node scripts/finalize-test.mjs
//
// Asserts, on synthetic sources where every pixel color is known:
//  1. Text glyphs composite as WHITE (near-white pixel mass on a pure-black
//     source with the rule OFF — any bright pixels can only be glyphs).
//  2. Source pixels far from the text block are untouched (JPEG tolerance).
//  3. Every position × size × filter combination renders without throwing.
//  4. Overlong titles auto-shrink instead of overflowing the image.

import sharp from 'sharp'
import { buildFinalized, POSITIONS, FILTERS } from '../src/lib/finalize-render.ts'

const W = 1024, H = 1024
let failures = 0

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

async function makeSource(background) {
  return sharp({ create: { width: W, height: H, channels: 3, background } })
    .jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toBuffer()
}

async function rawPixels(buf) {
  return sharp(buf).raw().toBuffer({ resolveWithObject: true })
}

function countBright(data, channels, min = 230) {
  let n = 0
  for (let i = 0; i < data.length; i += channels) {
    if (data[i] >= min && data[i + 1] >= min && data[i + 2] >= min) n++
  }
  return n
}

// ── 1. Glyph color: on pure black, rule OFF, bright pixels are glyphs only ──
{
  const black = await makeSource({ r: 0, g: 0, b: 0 })
  const out = await buildFinalized(black, 'PLAY', 'moodmixformat', 'bottom-center', 'medium', false, 'none')
  const { data, info } = await rawPixels(out)
  const bright = countBright(data, info.channels)
  // "PLAY" + "moodmixformat" at medium size cover thousands of pixels at 1024².
  check('text renders WHITE (rule off, black source)', bright > 2000, `${bright} near-white px`)
}

// ── 2. Rule ON adds the divider but glyphs must still dominate ──────────────
{
  const black = await makeSource({ r: 0, g: 0, b: 0 })
  const out = await buildFinalized(black, 'PLAY', 'moodmixformat', 'bottom-center', 'medium', true, 'none')
  const { data, info } = await rawPixels(out)
  const bright = countBright(data, info.channels)
  check('text + rule render WHITE', bright > 3000, `${bright} near-white px`)
}

// ── 3. Source pixels far from the bottom-center block stay untouched ────────
{
  const SRC = { r: 32, g: 42, b: 52 }
  const src = await makeSource(SRC)
  const out = await buildFinalized(src, 'NEVERTHELESS', 'moodmixformat', 'bottom-center', 'medium', true, 'none')
  const { data, info } = await rawPixels(out)
  const spots = [[10, 10], [512, 400], [1000, 30], [5, 500]]
  const ok = spots.every(([x, y]) => {
    const i = (y * info.width + x) * info.channels
    return Math.abs(data[i] - SRC.r) <= 1 && Math.abs(data[i + 1] - SRC.g) <= 1 && Math.abs(data[i + 2] - SRC.b) <= 1
  })
  check('non-text pixels match source within 1 LSB', ok)
}

// ── 4. Full matrix: every position × size × filter renders and stays white ──
{
  const black = await makeSource({ r: 0, g: 0, b: 0 })
  let rendered = 0, whiteOk = 0, errors = []
  for (const position of POSITIONS) {
    for (const size of ['small', 'medium', 'large']) {
      try {
        const out = await buildFinalized(black, 'MIDNIGHT DRIVE', 'moodmixformat', position, size, true, 'none')
        rendered++
        const { data, info } = await rawPixels(out)
        if (countBright(data, info.channels) > 1500) whiteOk++
      } catch (e) {
        errors.push(`${position}/${size}: ${e.message}`)
      }
    }
  }
  check('all 27 position×size combos render', rendered === 27, errors.join('; ') || `${rendered}/27`)
  check('all 27 combos have white text', whiteOk === 27, `${whiteOk}/27`)

  let filterOk = 0
  for (const filter of FILTERS) {
    try {
      await buildFinalized(black, 'PLAY', 'moodmixformat', 'bottom-center', 'medium', true, filter)
      filterOk++
    } catch { /* counted below */ }
  }
  check(`all ${FILTERS.length} filters render`, filterOk === FILTERS.length, `${filterOk}/${FILTERS.length}`)
}

// ── 5. Overlong title auto-shrinks instead of overflowing ───────────────────
{
  const black = await makeSource({ r: 0, g: 0, b: 0 })
  const long = 'AN EXTREMELY LONG TITLE THAT WOULD DEFINITELY OVERFLOW THE IMAGE WIDTH WITHOUT AUTO SHRINK'
  const out = await buildFinalized(black, long, 'moodmixformat', 'bottom-center', 'large', true, 'none')
  const { data, info } = await rawPixels(out)
  // No bright pixel may reach the outer 1% margin — text stayed inside padding.
  const margin = Math.round(W * 0.01)
  let edgeBright = 0
  for (let y = 0; y < info.height; y++) {
    for (const x of [margin, info.width - 1 - margin]) {
      const i = (y * info.width + x) * info.channels
      if (data[i] >= 230 && data[i + 1] >= 230 && data[i + 2] >= 230) edgeBright++
    }
  }
  check('overlong title stays inside side padding', edgeBright === 0, `${edgeBright} bright edge px`)
}

console.log('---')
console.log(failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
