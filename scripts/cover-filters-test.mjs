#!/usr/bin/env node
// Contract test for Cassette Studio's "Finish the look" — cover filters:
//   src/lib/cover-filters.ts    settings, presets, validate/clamp, the key code,
//                               the pixel maths (grade, vignette, grain), JPEG out
//   src/lib/cassette-studio.ts  the finalized-key parser that carries the look
//                               (finalized-<fts>-f<code>.jpg) and the
//                               source_path validator for "From mixBase" photos
//
// Drives the real sharp pipeline on synthetic images so the assertions are
// about pixels. The promises under test: a look survives the round trip
// through its storage key exactly and a malformed key never decodes; B&W is
// truly grey; warmth, fade and vignette move pixels the way their names say;
// the preview is capped; grain is deterministic (preview == saved); and a
// client can never name a file outside one of its own projects' folders.
//
// Runs on Node 22 native TS type-stripping, same as the other renderer tests.
// Run: node scripts/cover-filters-test.mjs  (also part of `npm test`)

import sharp from 'sharp'
import {
  ADJUSTMENT_IDS, FILTER_ADJUSTMENTS, FILTER_PRESETS, FILTER_PRESET_IDS, IDENTITY_FILTER, FILTER_CODE_RE,
  applyFilter, applyGrain, decodeFilter, decodeForFilter, encodeFilter, filterRawToJpeg, gradeEncoded, gradePixels,
  grainSeed, isIdentityFilter, normalizeFilter, vignettePixels,
} from '../src/lib/cover-filters.ts'
import {
  artworkStamp, filteredCoverKey, finalizedCoverKey, finalizedCoverStamp, parseFinalizedCover, parseSourcePath,
} from '../src/lib/cassette-studio.ts'

let failures = 0
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`)
  else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures++ }
}

const flat = (w, h, rgb, fmt = 'png') =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } })[fmt]().toBuffer()
const rawOf = (buf) => sharp(buf).raw().toBuffer({ resolveWithObject: true })
const s = (over = {}) => ({ ...IDENTITY_FILTER, preset: 'custom', ...over })
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

async function regionMean(buf, region) {
  const { data, info } = await sharp(buf).extract(region).raw().toBuffer({ resolveWithObject: true })
  let sum = 0
  for (let i = 0; i < data.length; i += info.channels) sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
  return sum / (info.width * info.height)
}

// ── Presets + adjustments (the GET payload) ─────────────────────────────────
console.log('presets + adjustments')
{
  const ids = FILTER_PRESETS.map(p => p.id)
  check('the ten contract preset ids, in order',
    same(ids, ['original', 'film', 'faded', 'warm', 'cool', 'noir', 'mono', 'sepia', 'punch', 'dusk']) && same(ids, [...FILTER_PRESET_IDS]), ids.join(','))
  check('every preset has a label', FILTER_PRESETS.every(p => typeof p.label === 'string' && p.label.length > 0))
  check('every preset carries its own id as the label it reports', FILTER_PRESETS.every(p => p.settings.preset === p.id))
  check('every preset is already valid (normalize is a no-op on it)',
    FILTER_PRESETS.every(p => same(normalizeFilter(p.settings), p.settings)))
  check('Original is the identity, every other preset changes something',
    isIdentityFilter(FILTER_PRESETS[0].settings) && FILTER_PRESETS.slice(1).every(p => !isIdentityFilter(p.settings)))
  const tone = id => FILTER_PRESETS.find(p => p.id === id).settings.tone
  check('Noir and Mono are B&W, Sepia is sepia, the rest colour',
    tone('noir') === 'bw' && tone('mono') === 'bw' && tone('sepia') === 'sepia' &&
    ['original', 'film', 'faded', 'warm', 'cool', 'punch', 'dusk'].every(id => tone(id) === 'color'))
  const noir = FILTER_PRESETS.find(p => p.id === 'noir').settings, mono = FILTER_PRESETS.find(p => p.id === 'mono').settings
  check('Noir is the high-contrast B&W, Mono the soft one', noir.contrast > 25 && mono.contrast <= 0)
  check('seven adjustments with the contract ranges',
    same(FILTER_ADJUSTMENTS.map(a => [a.id, a.min, a.max]), [
      ['brightness', -100, 100], ['contrast', -100, 100], ['saturation', -100, 100], ['warmth', -100, 100],
      ['fade', 0, 100], ['grain', 0, 100], ['vignette', 0, 100],
    ]) && same([...ADJUSTMENT_IDS], FILTER_ADJUSTMENTS.map(a => a.id)))
  check('identity is "original", all zeros, colour',
    same(IDENTITY_FILTER, { preset: 'original', brightness: 0, contrast: 0, saturation: 0, warmth: 0, fade: 0, grain: 0, vignette: 0, tone: 'color' }))
}

// ── Validation ──────────────────────────────────────────────────────────────
console.log('\nvalidate + clamp')
{
  const ok = { preset: 'film', brightness: 4, contrast: 10, saturation: -12, warmth: 8, fade: 16, grain: 28, vignette: 22, tone: 'color' }
  check('valid settings pass unchanged', same(normalizeFilter(ok), ok))
  const c = normalizeFilter({ ...ok, brightness: 500, contrast: -999, fade: -5, grain: 12.6, vignette: 1e9, warmth: -0.2 })
  check('out-of-range numbers are clamped, fractions rounded',
    c && c.brightness === 100 && c.contrast === -100 && c.fade === 0 && c.grain === 13 && c.vignette === 100, JSON.stringify(c))
  check('−0 folds to 0', c && Object.is(c.warmth, 0))
  check('an unknown preset string is kept as "custom" (it is only a label)', normalizeFilter({ ...ok, preset: 'vsco-a6' })?.preset === 'custom')
  check('"custom" is accepted as is', normalizeFilter({ ...ok, preset: 'custom' })?.preset === 'custom')
  const bad = [
    [null, 'null'], [5, 'a number'], ['film', 'a string'], [[ok], 'an array'],
    [(() => { const o = { ...ok }; delete o.grain; return o })(), 'a missing number'],
    [(() => { const o = { ...ok }; delete o.tone; return o })(), 'a missing tone'],
    [(() => { const o = { ...ok }; delete o.preset; return o })(), 'a missing preset'],
    [{ ...ok, brightness: '10' }, 'a numeric string'],
    [{ ...ok, contrast: null }, 'a null number'],
    [{ ...ok, fade: NaN }, 'NaN'],
    [{ ...ok, grain: Infinity }, 'Infinity'],
    [{ ...ok, tone: 'grey' }, 'an unknown tone'],
    [{ ...ok, tone: 'BW' }, 'a mis-cased tone'],
    [{ ...ok, preset: 7 }, 'a non-string preset'],
  ]
  for (const [v, label] of bad) check(`rejected: ${label}`, normalizeFilter(v) === null)
}

// ── Identity ────────────────────────────────────────────────────────────────
console.log('\nidentity')
check('identity is identity', isIdentityFilter(IDENTITY_FILTER))
check('the preset label does not matter — numbers + tone do', isIdentityFilter(s({ preset: 'film' })))
check('B&W at zero is not identity', !isIdentityFilter(s({ tone: 'bw' })))
check('sepia at zero is not identity', !isIdentityFilter(s({ tone: 'sepia' })))
for (const id of ADJUSTMENT_IDS) check(`${id} 1 is not identity`, !isIdentityFilter(s({ [id]: 1 })))

// ── The key code ────────────────────────────────────────────────────────────
console.log('\nkey code: encode/decode')
{
  let allRound = true, allShape = true
  for (const p of FILTER_PRESETS) {
    const code = encodeFilter(p.settings)
    if (!/^[a-z0-9]{1,40}$/.test(code) || !FILTER_CODE_RE.test(code)) allShape = false
    if (!same(decodeFilter(code), p.settings)) allRound = false
  }
  check('every preset round-trips exactly', allRound)
  check('codes are [a-z0-9], ≤ 40 chars', allShape)
  // Fuzz: random settings, including out-of-range ones → decode(encode(x)) === normalize(x).
  let seed = 1
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  const tones = ['color', 'bw', 'sepia']
  const presets = [...FILTER_PRESET_IDS, 'custom', 'whatever']
  let fuzzOk = true, fuzzMsg = ''
  for (let i = 0; i < 2000; i++) {
    const x = { preset: presets[Math.floor(rnd() * presets.length)], tone: tones[Math.floor(rnd() * 3)] }
    for (const a of FILTER_ADJUSTMENTS) x[a.id] = Math.round((rnd() * 2.4 - 1.2) * 100 * 10) / 10
    const n = normalizeFilter(x)
    const back = decodeFilter(encodeFilter(n))
    if (!same(back, n) || encodeFilter(back) !== encodeFilter(n)) { fuzzOk = false; fuzzMsg = JSON.stringify(x); break }
  }
  check('2000 random settings (incl. out-of-range) round-trip to their clamped values', fuzzOk, fuzzMsg)
  check('extremes round-trip', same(decodeFilter(encodeFilter(s({ brightness: -100, contrast: 100, saturation: -100, warmth: 100, fade: 100, grain: 100, vignette: 100, tone: 'sepia' }))),
    s({ brightness: -100, contrast: 100, saturation: -100, warmth: 100, fade: 100, grain: 100, vignette: 100, tone: 'sepia' })))
  check('encode clamps what it is given', same(decodeFilter(encodeFilter(s({ brightness: 900 }))), s({ brightness: 100 })))
  const good = encodeFilter(FILTER_PRESETS[1].settings)
  const malformed = [
    ['', 'empty'],
    [good.slice(0, -1), 'one char short'],
    [good + '0', 'one char long'],
    ['2' + good.slice(1), 'unknown format version'],
    [good.toUpperCase(), 'upper case'],
    [good.slice(0, 1) + 'b' + good.slice(2), 'preset index past the list'],
    [good.slice(0, 2) + 'x' + good.slice(3), 'unknown tone letter'],
    [good.slice(0, 3) + 'zz' + good.slice(5), 'brightness out of range (zz)'],
    [good.slice(0, 3) + '5l' + good.slice(5), 'brightness 101 (just past the range)'],
    [good.slice(0, 11) + '2t' + good.slice(13), 'fade 101 (0..100 slider)'],
    [good.slice(0, 5) + '-1' + good.slice(7), 'a minus sign'],
    [good.slice(0, 5) + '..' + good.slice(7), 'dots'],
    [` ${good}`, 'leading space'],
  ]
  for (const [code, label] of malformed) check(`decode refuses: ${label}`, decodeFilter(code) === null, String(code))
  check('decode refuses non-strings', decodeFilter(null) === null && decodeFilter(42) === null && decodeFilter({}) === null)
  check('a fade of exactly 100 decodes', decodeFilter(encodeFilter(s({ fade: 100 })))?.fade === 100)
}

// ── Finalized keys + photo paths (cassette-studio.ts) ───────────────────────
console.log('\nfinalized keys carry the look')
{
  const proj = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const other = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee'
  const fts = '1790000000000'
  const film = FILTER_PRESETS.find(p => p.id === 'film').settings
  const key = filteredCoverKey(proj, fts, film)
  check('filtered key shape', key === `${proj}/finalized-${fts}-f${encodeFilter(film)}.jpg`, key)
  check('plain finalized key shape', finalizedCoverKey(proj, fts) === `${proj}/finalized-${fts}.jpg`)
  check('finalizedCoverStamp still reads a plain key', finalizedCoverStamp(`${proj}/finalized-${fts}.jpg`, proj) === fts)
  check('finalizedCoverStamp accepts finalized-<fts>-f<code>.jpg (the moving cover still finds title-<fts>)',
    finalizedCoverStamp(key, proj) === fts)
  check('parseFinalizedCover returns the stamp and the decoded look', same(parseFinalizedCover(key, proj), { fts, filter: film }))
  check('parseFinalizedCover: a plain key has no look', same(parseFinalizedCover(`${proj}/finalized-${fts}.jpg`, proj), { fts, filter: null }))
  const code = encodeFilter(film)
  const junk = [
    [`${proj}/finalized-${fts}-f.jpg`, 'an empty code'],
    [`${proj}/finalized-${fts}-f${code}x.jpg`, 'a code that does not decode'],
    [`${proj}/finalized-${fts}-f${'1'.repeat(41)}.jpg`, 'a 41-char code'],
    [`${proj}/finalized-${fts}-fZZZ.jpg`, 'an upper-case code'],
    [`${proj}/finalized-${fts}-g${code}.jpg`, 'a different marker'],
    [`${proj}/finalized-${fts}-f${code}.png`, 'the wrong extension'],
    [`${proj}/finalized-${fts}-f${code}.jpg.png`, 'a trailing extension'],
    [`${proj}/finalized-${fts}--f${code}.jpg`, 'a doubled separator'],
    [`${proj}/finalized-123-f${code}.jpg`, 'a short stamp'],
    [`${proj}/x/finalized-${fts}-f${code}.jpg`, 'a nested key'],
    [`${other}/finalized-${fts}-f${code}.jpg`, "another project's key"],
    [`${proj.toUpperCase()}/finalized-${fts}-f${code}.jpg`, 'an upper-case project segment'],
    [`${proj}/ai-cassette-${fts}.jpg`, 'a cover key'],
  ]
  for (const [k, label] of junk) {
    check(`refused: ${label}`, finalizedCoverStamp(k, proj) === null && parseFinalizedCover(k, proj) === null, k)
  }
  check('refused: null / a non-uuid project', finalizedCoverStamp(null, proj) === null && finalizedCoverStamp(`x/finalized-${fts}.jpg`, 'x') === null)

  check('artworkStamp: Studio covers', artworkStamp(`${proj}/ai-cassette-${fts}.jpg`, proj) === fts && artworkStamp(`${proj}/cassette-${fts}.jpg`, proj) === fts)
  check('artworkStamp: generated + uploaded artwork', artworkStamp(`${proj}/ai-${fts}.webp`, proj) === fts && artworkStamp(`${proj}/${fts}.jpeg`, proj) === fts && artworkStamp(`${proj}/${fts}.png`, proj) === fts)
  check('artworkStamp: a plain finalized restored as the artwork', artworkStamp(`${proj}/finalized-${fts}.jpg`, proj) === fts)
  check('artworkStamp: no stamp in the name → null', artworkStamp(`${proj}/deezer-631765241.jpg`, proj) === null && artworkStamp(`${proj}/cover.png`, proj) === null)
  check('artworkStamp: a filtered cover is never a base', artworkStamp(key, proj) === null)
  check("artworkStamp: another project's / nested / bucket-root keys → null",
    artworkStamp(`${other}/ai-${fts}.jpg`, proj) === null && artworkStamp(`${proj}/x/ai-${fts}.jpg`, proj) === null && artworkStamp(`${proj}-${fts}.jpg`, proj) === null)
}

console.log('\nsource_path ("From mixBase" photos)')
{
  const proj = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const good = [`${proj}/ai-1790000000000.jpg`, `${proj}/1790000000000.jpeg`, `${proj}/cover.png`, `${proj}/IMG_0042.webp`, `${proj}/ai-cassette-1790000000000.jpg`]
  for (const p of good) {
    const r = parseSourcePath(p)
    check(`accepted: ${p.slice(37)}`, r !== null && r.projectId === proj && r.path === p && r.leaf === p.slice(37))
  }
  const bad = [
    [`${proj}/../${proj}/x.jpg`, 'traversal through ..'],
    [`../${proj}/x.jpg`, 'leading ..'],
    [`${proj}/..jpg`, 'a dot-dot leaf'],
    [`${proj}/a..b.jpg`, '.. inside the name'],
    [`${proj}/.hidden.jpg`, 'a dot file'],
    [`${proj}/%2e%2e/x.jpg`, 'percent-encoded dots'],
    [`${proj}/x/y.jpg`, 'a nested folder'],
    [`${proj}\\x.jpg`, 'a backslash'],
    [`/${proj}/x.jpg`, 'a leading slash'],
    [`${proj}/x y.jpg`, 'a space'],
    [`${proj}/x.jpg\u0000.png`, 'a NUL byte'],
    [`${proj.toUpperCase()}/x.jpg`, 'an upper-case uuid'],
    [`aaaaaaaa-bbbb-cccc-dddd/x.jpg`, 'a short uuid'],
    [`covers/${proj}/x.jpg`, 'a legacy prefix'],
    [`studio/${proj}/subject-1790000000000.png`, 'a studio file'],
    [`x.jpg`, 'a bucket-root key'],
    [`${proj}/`, 'a folder'],
    [`${proj}/x.gif`, 'a gif'],
    [`${proj}/x.svg`, 'an svg'],
    [`${proj}/x.heic`, 'a heic'],
    [`${proj}/x.mp4`, 'a video'],
    [`${proj}/x.JPG`, 'an upper-case extension'],
    [`${proj}/x.jpg.exe`, 'a trailing extension'],
    [`${proj}/x`, 'no extension'],
    [`${proj}/${'a'.repeat(260)}.jpg`, 'an over-long name'],
  ]
  for (const [p, label] of bad) check(`refused: ${label}`, parseSourcePath(p) === null, p)
  check('refused: non-strings', parseSourcePath(null) === null && parseSourcePath(42) === null && parseSourcePath({ path: good[0] }) === null)

  // The iOS app uploads artwork to the bucket ROOT as <projectId>-<unixSeconds>.jpg.
  const root = `${proj}-1791979122.jpg`
  const r = parseSourcePath(root)
  check('accepted: an iOS bucket-root upload', r !== null && r.projectId === proj && r.path === root && r.leaf === root)
  check('accepted: iOS root upload as png/webp/jpeg', [`${proj}-1791979122.png`, `${proj}-1791979122.webp`, `${proj}-1791979122.jpeg`].every(p => parseSourcePath(p)?.projectId === proj))
  const badRoot = [
    [`collection-${proj}-1787222896.jpg`, 'a collection cover at the root'],
    [`${proj}-abc.jpg`, 'a non-numeric suffix'],
    [`${proj}-12345678.jpg`, 'a too-short stamp'],
    [`${proj}-17919791220000.jpg`, 'a too-long stamp'],
    [`${proj.toUpperCase()}-1791979122.jpg`, 'an upper-case root uuid'],
    [`${proj}-1791979122.gif`, 'a root gif'],
    [`${proj}-1791979122.jpg/x.jpg`, 'a root name used as a folder'],
    [`${proj}1791979122.jpg`, 'no separator'],
  ]
  for (const [p, label] of badRoot) check(`refused: ${label}`, parseSourcePath(p) === null, p)
}

// ── Pixels ──────────────────────────────────────────────────────────────────
console.log('\npixels')
{
  // A colourful 64×64 RGBA test card: hue sweep across x, brightness down y.
  const W = 64, H = 64
  const card = Buffer.alloc(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4
    card[i] = (x * 4) & 255; card[i + 1] = (y * 4) & 255; card[i + 2] = ((x + y) * 2) & 255; card[i + 3] = (x * 7 + y) & 255
  }
  const bw = Buffer.from(card)
  gradePixels(bw, 4, s({ tone: 'bw', contrast: 30, warmth: 40, saturation: 50, fade: 20, brightness: 10 }))
  let grey = true, alphaKept = true
  for (let i = 0; i < bw.length; i += 4) {
    if (bw[i] !== bw[i + 1] || bw[i + 1] !== bw[i + 2]) grey = false
    if (bw[i + 3] !== card[i + 3]) alphaKept = false
  }
  check('B&W makes r = g = b on every pixel, whatever else is set', grey)
  check('RGBA: the alpha channel is untouched', alphaKept)

  const sat = Buffer.from(card.subarray(0, W * H * 4))
  gradePixels(sat, 4, s({ saturation: -100 }))
  let desat = true
  for (let i = 0; i < sat.length; i += 4) if (Math.max(sat[i], sat[i + 1], sat[i + 2]) - Math.min(sat[i], sat[i + 1], sat[i + 2]) > 1) desat = false
  check('saturation −100 is fully desaturated', desat)

  const sepia = Buffer.from([128, 128, 128])
  gradePixels(sepia, 3, s({ tone: 'sepia' }))
  check('sepia turns grey brown (r > g > b)', sepia[0] > sepia[1] && sepia[1] > sepia[2], [...sepia].join(','))

  const warm = Buffer.from([128, 128, 128]), cool = Buffer.from([128, 128, 128])
  gradePixels(warm, 3, s({ warmth: 60 }))
  gradePixels(cool, 3, s({ warmth: -60 }))
  check('warmth > 0 raises R relative to B on a grey pixel', warm[0] > warm[2], [...warm].join(','))
  check('warmth < 0 raises B relative to R', cool[2] > cool[0], [...cool].join(','))

  const dark = Buffer.from([0, 0, 0, 10, 10, 10])
  gradePixels(dark, 3, s({ fade: 60 }))
  check('fade lifts the darkest value', dark[0] > 20 && dark[0] === dark[1] && dark[1] === dark[2], [...dark].join(','))
  const white = Buffer.from([255, 255, 255])
  gradePixels(white, 3, s({ fade: 100 }))
  check('fade pulls white in only a touch', white[0] < 255 && white[0] > 230, String(white[0]))

  const ramp = Buffer.from([0, 0, 0, 64, 64, 64, 128, 128, 128, 192, 192, 192, 255, 255, 255])
  const up = Buffer.from(ramp), down = Buffer.from(ramp)
  gradePixels(up, 3, s({ brightness: 60 }))
  gradePixels(down, 3, s({ brightness: -60 }))
  check('brightness raises / lowers the mid-tones', up[6] > 128 && down[6] < 128, `${up[6]} / ${down[6]}`)
  check('brightness keeps black and white where they are', up[0] === 0 && up[12] === 255 && down[0] === 0 && down[12] === 255)
  const hi = Buffer.from(ramp), lo = Buffer.from(ramp)
  gradePixels(hi, 3, s({ contrast: 80 }))
  gradePixels(lo, 3, s({ contrast: -80 }))
  check('contrast spreads / squeezes around mid-grey', hi[3] < 64 && hi[9] > 192 && lo[3] > 64 && lo[9] < 192, `${hi[3]},${hi[9]} / ${lo[3]},${lo[9]}`)

  const id = Buffer.from(card)
  gradePixels(id, 4, IDENTITY_FILTER)
  check('the identity grade changes nothing', id.equals(card))

  // Vignette on a flat field: corners darker than the centre.
  const VW = 200, VH = 120
  const field = Buffer.alloc(VW * VH * 3, 200)
  vignettePixels(field, VW, VH, 3, 80)
  const at = (x, y) => field[(y * VW + x) * 3]
  check('vignette darkens the corners more than the centre', at(0, 0) < at(100, 60) - 60 && at(100, 60) >= 198, `${at(0, 0)} vs ${at(100, 60)}`)
  check('vignette: edges sit between', at(100, 0) < at(100, 60) && at(100, 0) > at(0, 0))
  const rgba = Buffer.alloc(10 * 10 * 4, 200)
  vignettePixels(rgba, 10, 10, 4, 100)
  check('vignette leaves alpha alone', rgba[3] === 200 && rgba[rgba.length - 1] === 200)

  // Grain on raw: deterministic, monochrome, scaled.
  const GW = 300, GH = 200
  const g1 = Buffer.alloc(GW * GH * 3, 120), g2 = Buffer.alloc(GW * GH * 3, 120), g3 = Buffer.alloc(GW * GH * 3, 120)
  await applyGrain(g1, GW, GH, 3, 60, grainSeed(s({ grain: 60 })))
  await applyGrain(g2, GW, GH, 3, 60, grainSeed(s({ grain: 60 })))
  await applyGrain(g3, GW, GH, 3, 60, grainSeed(s({ grain: 61 })))
  check('grain: same settings → identical pixels', g1.equals(g2))
  check('grain: a different grain setting → a different pattern', !g1.equals(g3))
  let mono = true, varied = 0
  for (let i = 0; i < g1.length; i += 3) {
    if (g1[i] !== g1[i + 1] || g1[i + 1] !== g1[i + 2]) mono = false
    if (g1[i] !== 120) varied++
  }
  check('grain is monochrome (B&W stays grey)', mono)
  check('grain actually moves pixels', varied > GW * GH * 0.5, String(varied))
  check('grain seed ignores every slider but grain', grainSeed(s({ grain: 30, brightness: 50, tone: 'bw' })) === grainSeed(s({ grain: 30 })))
}

// ── Images (JPEG in, JPEG out) ──────────────────────────────────────────────
console.log('\nimages')
{
  const big = await flat(3000, 2000, [90, 80, 70], 'jpeg')
  const prev = await rawOf(await applyFilter(big, FILTER_PRESETS[1].settings, { maxSide: 1080, quality: 85 }))
  check('preview respects maxSide (3000×2000 → 1080×720)', prev.info.width === 1080 && prev.info.height === 720, `${prev.info.width}×${prev.info.height}`)
  const portrait = await rawOf(await applyFilter(await flat(1200, 3000, [90, 80, 70], 'jpeg'), FILTER_PRESETS[2].settings, { maxSide: 1080 }))
  check('…on the long side for portrait too (1200×3000 → 432×1080)', portrait.info.width === 432 && portrait.info.height === 1080, `${portrait.info.width}×${portrait.info.height}`)
  const small = await rawOf(await applyFilter(await flat(500, 300, [90, 80, 70]), FILTER_PRESETS[3].settings, { maxSide: 1080 }))
  check('…and never enlarges a smaller image', small.info.width === 500 && small.info.height === 300)
  const full = await rawOf(await applyFilter(big, FILTER_PRESETS[1].settings))
  check('without maxSide the size is kept', full.info.width === 3000 && full.info.height === 2000)

  const out = await applyFilter(big, FILTER_PRESETS[1].settings, { maxSide: 1080 })
  check('output is a JPEG', out[0] === 0xff && out[1] === 0xd8)

  // Deterministic: the same look on the same base is the same bytes, so a
  // preview and a save agree and a repeated save is the same object.
  const night = await sharp({ create: { width: 640, height: 640, channels: 3, background: { r: 30, g: 34, b: 48 } } })
    .composite([{ input: await flat(160, 100, [230, 180, 90]), left: 240, top: 300 }]).jpeg().toBuffer()
  const film = FILTER_PRESETS.find(p => p.id === 'film').settings
  const a = await applyFilter(night, film), b = await applyFilter(night, film)
  check('the same look on the same image → identical bytes (grain is seeded)', a.equals(b))
  const decoded = await decodeForFilter(night)
  const viaRaw = await filterRawToJpeg(decoded, film)
  check('filterRawToJpeg on a decoded base == applyFilter', viaRaw.equals(a))
  const again = await filterRawToJpeg(decoded, film)
  check('filterRawToJpeg never mutates the (cached) base', again.equals(viaRaw))

  // Preview == saved, in miniature: the ≤1080 preview of a 2160² cover vs the
  // full-size save scaled down to 1080 — same grade, vignette and grain field.
  const cover = await sharp({ create: { width: 2160, height: 2160, channels: 3, background: { r: 60, g: 70, b: 90 } } })
    .composite([{ input: await flat(800, 500, [200, 160, 120]), left: 680, top: 900 }]).jpeg({ quality: 95 }).toBuffer()
  const noir = FILTER_PRESETS.find(p => p.id === 'noir').settings
  const preview = await sharp(await applyFilter(cover, noir, { maxSide: 1080 })).raw().toBuffer()
  const saved = await sharp(await applyFilter(cover, noir)).resize(1080, 1080).raw().toBuffer()
  let diff = 0
  for (let i = 0; i < preview.length; i++) diff += Math.abs(preview[i] - saved[i])
  diff /= preview.length
  check('the preview matches the saved cover scaled down (mean |Δ| < 6)', diff < 6, diff.toFixed(2))

  // Vignette through the whole pipeline.
  const lit = await rawOf(await applyFilter(await flat(400, 400, [180, 180, 180]), s({ vignette: 70 })))
  const px = (x, y) => lit.data[(y * lit.info.width + x) * 3]
  check('applyFilter vignette: corners darker than the centre', px(2, 2) < px(200, 200) - 40, `${px(2, 2)} vs ${px(200, 200)}`)

  // B&W through JPEG stays grey to within the codec's rounding.
  const bwOut = await rawOf(await applyFilter(night, s({ tone: 'bw', grain: 50, vignette: 40, fade: 20 })))
  let maxSpread = 0
  for (let i = 0; i < bwOut.data.length; i += 3) {
    maxSpread = Math.max(maxSpread, Math.max(bwOut.data[i], bwOut.data[i + 1], bwOut.data[i + 2]) - Math.min(bwOut.data[i], bwOut.data[i + 1], bwOut.data[i + 2]))
  }
  check('a B&W cover is grey after JPEG (channel spread ≤ 3)', maxSpread <= 3, String(maxSpread))

  // Identity through the pipeline is (almost) the input.
  const idOut = await rawOf(await applyFilter(night, IDENTITY_FILTER))
  const nightRaw = await rawOf(night)
  let idDiff = 0
  for (let i = 0; i < idOut.data.length; i++) idDiff += Math.abs(idOut.data[i] - nightRaw.data[i])
  check('Original only re-encodes (mean |Δ| < 1.5)', idDiff / idOut.data.length < 1.5, (idDiff / idOut.data.length).toFixed(2))

  // Inputs: greyscale JPEG and RGBA PNG both come out 3-channel.
  const greyJpeg = await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 99, g: 99, b: 99 } } }).toColourspace('b-w').jpeg().toBuffer()
  const gDec = await decodeForFilter(greyJpeg)
  check('a greyscale JPEG decodes to RGB', gDec.data.length === 40 * 30 * 3 && gDec.width === 40)
  const pngA = await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 200, g: 10, b: 10, alpha: 0.5 } } }).png().toBuffer()
  const aDec = await decodeForFilter(pngA)
  check('an RGBA PNG is flattened to RGB', aDec.data.length === 20 * 20 * 3)
  const exif = await sharp({ create: { width: 60, height: 20, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().withMetadata({ orientation: 6 }).toBuffer()
  const eDec = await decodeForFilter(exif)
  check('EXIF rotation is baked in', eDec.width === 20 && eDec.height === 60, `${eDec.width}×${eDec.height}`)

  // Every preset keeps a night cover a picture: not crushed to black, not blown out.
  let sane = true, worst = ''
  for (const p of FILTER_PRESETS) {
    const m = await regionMean(await applyFilter(night, p.settings), { left: 0, top: 0, width: 640, height: 640 })
    if (m < 12 || m > 200) { sane = false; worst = `${p.id}=${m.toFixed(1)}` }
  }
  check('every preset keeps a night scene within a sane exposure', sane, worst)

  // The moving cover's layers.
  const layerPng = await sharp({ create: { width: 30, height: 20, channels: 4, background: { r: 200, g: 120, b: 40, alpha: 0.4 } } }).png().toBuffer()
  const graded = await rawOf(await gradeEncoded(layerPng, s({ tone: 'bw', contrast: 20 }), { format: 'png' }))
  check('gradeEncoded png keeps alpha', graded.info.channels === 4 && graded.data[3] === Math.round(0.4 * 255), String(graded.data[3]))
  check('gradeEncoded png grades the colour', graded.data[0] === graded.data[1] && graded.data[1] === graded.data[2])
  const plate = await rawOf(await gradeEncoded(await flat(300, 300, [150, 150, 150], 'jpeg'), s({ vignette: 80 }), { format: 'jpeg', vignette: true }))
  check('gradeEncoded jpeg + vignette darkens the plate corners', plate.data[0] < plate.data[(150 * 300 + 150) * 3] - 30)
  const plateNoVig = await rawOf(await gradeEncoded(await flat(300, 300, [150, 150, 150], 'jpeg'), s({ vignette: 80 }), { format: 'jpeg' }))
  check('…and only when asked (the cassette layer and title get none)', Math.abs(plateNoVig.data[0] - plateNoVig.data[(150 * 300 + 150) * 3]) <= 2)
}

if (failures) {
  console.error(`\n✗ ${failures} cover-filters check(s) failed`)
  process.exit(1)
}
console.log('\n✓ cover-filters: all checks passed')
