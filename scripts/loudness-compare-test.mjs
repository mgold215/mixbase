#!/usr/bin/env node
// Cross-version loudness comparison test — exercises the REAL production module
// (src/lib/loudness-compare.ts via Node type stripping) plus a source-contract
// pass over the route that persists the numbers. No DB, no network.
//
// Run: node scripts/loudness-compare-test.mjs   (also in `npm run test:renderers`)
//
// The three things worth guarding here, in order of how badly they'd bite:
//
//  1. THE GENRE CANON. −8 to −5 LUFS is the NORM for EDM/techno and must never
//     be scolded, even indirectly. masterVerdict() honours that; a delta rule
//     that quietly read an absolute band would smuggle it straight back in. The
//     translation-invariance case below proves mechanically that no rule can:
//     shift BOTH mixes by −8 dB and the rendered lines must come out
//     byte-identical, which is only possible if every rule reads differences.
//
//  2. VALIDATION AT THE DOOR. A junk number stored once is permanent — every
//     later delta reads it and nothing in the UI can hint that the nonsense came
//     from the payload rather than the mix. So the sanitizer must reject the
//     values that LOOK finite (numeric strings, out-of-range numbers), while
//     still accepting the one legitimate hole: silence measures -Infinity, which
//     JSON turns into null.
//
//  3. THE MEASURED/EDITED BOUNDARY. Loudness is measured, not typed. If the five
//     columns ever appear in PATCH /api/versions/[id]'s allowlist, any client
//     can write any number into the history the comparison is computed from.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { measureLoudness } from '../src/lib/loudness.ts'
import {
  LOUDNESS_ALGO,
  compareLoudness,
  loudnessFromRow,
  sanitizeLoudness,
  toLoudnessColumns,
  toMeasurement,
} from '../src/lib/loudness-compare.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// A complete, valid payload. Individual cases below overwrite one field at a
// time so a rejection can only be attributed to that field.
const GOOD = { integratedLufs: -9.2, shortTermMaxLufs: -6.4, samplePeakDb: -0.8, gatedBlockCount: 1200 }
const withIntegrated = (v) => sanitizeLoudness({ ...GOOD, integratedLufs: v })

// ── 1. sanitizeLoudness rejects what looks finite but isn't a measurement ────

check('sanitizeLoudness accepts a clean payload', JSON.stringify(sanitizeLoudness(GOOD)) === JSON.stringify(GOOD))

for (const [label, value] of [
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
  ["the string '−9.2'", '−9.2'],
  ["the ASCII string '-9.2'", '-9.2'],
  ['an object', {}],
  ['-200 (below the −70 LUFS gate)', -200],
  ['+40 (above full scale)', 40],
]) {
  check(`sanitizeLoudness rejects ${label} as an integrated value`, withIntegrated(value)?.integratedLufs === null)
}

check('sanitizeLoudness rejects a non-object payload', sanitizeLoudness('−9.2') === null && sanitizeLoudness(42) === null && sanitizeLoudness(null) === null)
check('sanitizeLoudness rejects {} — a shape with no measurement in it', sanitizeLoudness({}) === null)

// Sample peak gets a wider window than the LUFS fields on purpose: 32-bit float
// PCM legitimately overshoots 0 dBFS, so a hard 0 ceiling would reject honest
// measurements of real masters.
check('sample peak above 0 dBFS is accepted (float PCM overshoots)', sanitizeLoudness({ ...GOOD, samplePeakDb: 2.5 })?.samplePeakDb === 2.5)
check('sample peak of +40 dBFS is rejected', sanitizeLoudness({ ...GOOD, samplePeakDb: 40 })?.samplePeakDb === null)
check('fractional block counts are rejected', sanitizeLoudness({ ...GOOD, gatedBlockCount: 12.5 })?.gatedBlockCount === null)
check('negative block counts are rejected', sanitizeLoudness({ ...GOOD, gatedBlockCount: -1 })?.gatedBlockCount === null)

// ── 2. A REAL measureLoudness output survives the JSON round trip ────────────
// The wire format is the thing being tested, not the maths: the browser POSTs
// `JSON.stringify(measurement)`, and JSON has no -Infinity.

const SR = 48000
const roundTrip = (m) => JSON.parse(JSON.stringify(m))

{
  // 2 s of 1 kHz at half scale — an ordinary, definitely-measurable signal.
  const n = SR * 2
  const tone = new Float32Array(n)
  for (let i = 0; i < n; i++) tone[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / SR)
  const real = measureLoudness([tone], SR)
  const wire = roundTrip(real)
  const clean = sanitizeLoudness(wire)

  check('a real measureLoudness output round-trips through JSON and validates', clean !== null)
  check(
    'the round-tripped numbers are preserved exactly',
    clean?.integratedLufs === real.integratedLufs &&
      clean?.shortTermMaxLufs === real.shortTermMaxLufs &&
      clean?.samplePeakDb === real.samplePeakDb &&
      clean?.gatedBlockCount === real.gatedBlockCount,
    `integrated ${real.integratedLufs.toFixed(2)} LUFS, peak ${real.samplePeakDb.toFixed(2)} dBFS`,
  )
}

{
  // Silence: measureLoudness returns -Infinity for all three dB fields, which
  // JSON writes as null. That must degrade FIELD BY FIELD — the payload is a
  // truthful measurement of a real file, not a corrupt request.
  const silence = new Float32Array(SR * 2)
  const real = measureLoudness([silence], SR)
  check('silence really does measure -Infinity', real.integratedLufs === -Infinity && real.samplePeakDb === -Infinity)

  const wire = roundTrip(real)
  check('JSON turns -Infinity into null', wire.integratedLufs === null && wire.samplePeakDb === null)

  const clean = sanitizeLoudness(wire)
  check('the silent payload is NOT rejected wholesale', clean !== null)
  check(
    'each -Infinity field degrades to null on its own',
    clean?.integratedLufs === null && clean?.shortTermMaxLufs === null && clean?.samplePeakDb === null,
  )
  check('the gated block count survives alongside them', clean?.gatedBlockCount === real.gatedBlockCount)

  // …and widening it back restores the shape the display helpers expect.
  const wide = toMeasurement(clean)
  check('toMeasurement restores -Infinity for the missing fields', wide.integratedLufs === -Infinity && wide.samplePeakDb === -Infinity)
}

// ── 3. compareLoudness needs BOTH sides measured ────────────────────────────

const A = { integratedLufs: -9.0, shortTermMaxLufs: -3.4, samplePeakDb: -1.5, gatedBlockCount: 1000 }
const B = { integratedLufs: -6.0, shortTermMaxLufs: -3.0, samplePeakDb: -1.2, gatedBlockCount: 1000 }
const unmeasured = { integratedLufs: null, shortTermMaxLufs: null, samplePeakDb: null, gatedBlockCount: 0 }

check('compare(null, next) is null', compareLoudness(null, B) === null)
check('compare(prev, null) is null', compareLoudness(A, null) === null)
check('compare(prev, undefined) is null', compareLoudness(A, undefined) === null)
check('an unmeasured previous mix yields no comparison', compareLoudness(unmeasured, B) === null)
check('an unmeasured next mix yields no comparison', compareLoudness(A, unmeasured) === null)
check(
  'a half-measurement (no short-term) yields no comparison',
  compareLoudness({ ...A, shortTermMaxLufs: null }, B) === null && compareLoudness(A, { ...B, shortTermMaxLufs: null }) === null,
)
check('a row with no measured_at reads as unmeasured', loudnessFromRow({ loudness_lufs: -9, loudness_short_term_lufs: -3 }) === null)
check(
  'a measured row reads back through loudnessFromRow',
  loudnessFromRow({
    loudness_lufs: -9,
    loudness_short_term_lufs: -3.4,
    sample_peak_db: -1.5,
    loudness_measured_at: '2026-08-14T00:00:00.000Z',
    loudness_algo: LOUDNESS_ALGO,
  })?.integratedLufs === -9,
)

// A silent bounce measures -Infinity everywhere and therefore stores as five
// nulls behind a real timestamp. sanitizeLoudness rejects an all-null PAYLOAD
// (that shape means a client sent nothing), but a ROW carries its own proof
// that the measurement happened, and it has to keep reading as measured:
// MasterCheck decides whether to push its localStorage backfill by asking
// exactly this question, so a null here would re-POST the same reading on
// every single mount, forever, and never converge.
{
  const silentRow = {
    loudness_lufs: null,
    loudness_short_term_lufs: null,
    sample_peak_db: null,
    loudness_measured_at: '2026-08-14T00:00:00.000Z',
    loudness_algo: LOUDNESS_ALGO,
  }
  const silent = loudnessFromRow(silentRow)
  check('a stored SILENT measurement still reads as measured', silent !== null, JSON.stringify(silent))
  check('…with every value null rather than invented',
    silent !== null && silent.integratedLufs === null && silent.shortTermMaxLufs === null && silent.samplePeakDb === null)
  check('…and it cannot produce a delta against a real mix',
    compareLoudness(silent, A) === null && compareLoudness(A, silent) === null)
}

// ── 4. The arithmetic, exactly ──────────────────────────────────────────────
// The headline claim: "v7 is 3.0 dB louder than v6 — but the loudest 3 s only
// moved 0.4 dB, so 2.6 dB of that came out of the dynamics."

{
  const c = compareLoudness(A, B) // A is the OLDER mix, B the newer one
  check('integratedDeltaDb is next − prev', Math.abs(c.integratedDeltaDb - 3.0) < 1e-9, `got ${c.integratedDeltaDb}`)
  check('shortTermDeltaDb is next − prev', Math.abs(c.shortTermDeltaDb - 0.4) < 1e-9, `got ${c.shortTermDeltaDb}`)
  check('crestSpentDb is integrated − shortTerm', Math.abs(c.crestSpentDb - 2.6) < 1e-9, `got ${c.crestSpentDb}`)
  check('the louder + crest-spent case names the dynamics', c.lines.some((l) => /dynamics/i.test(l.message)))
  check('the crest-factor line is a warning, not a shrug', c.lines.some((l) => l.level === 'warning' && /dynamics/i.test(l.message)))
  check('the reported figures are the rounded deltas', c.lines.some((l) => l.message.includes('3.0 dB louder')) && c.lines.some((l) => l.message.includes('2.6 dB')))
}

// ── 5. Translation invariance — the canon guard ─────────────────────────────
// Shift BOTH mixes down by 8 dB and nothing about the CHANGE between them has
// changed, so not one character of the output may move. If any rule ever reads
// an absolute LUFS band (e.g. "you're above −6 now"), this is what catches it.
//
// Sample peaks are shifted too but deliberately parked well clear of the −0.1
// dBFS ceiling on both sides: that crossing rule is the one legitimately
// absolute rule in the module (a lossy-transcode fact, not a taste call), and
// this case is about the loudness rules.

{
  const shift = (m, dB) => ({ ...m, integratedLufs: m.integratedLufs + dB, shortTermMaxLufs: m.shortTermMaxLufs + dB, samplePeakDb: m.samplePeakDb + dB })
  const loud = compareLoudness(A, B)
  const quiet = compareLoudness(shift(A, -8), shift(B, -8))
  check(
    'shifting both mixes by −8 dB leaves the lines byte-identical',
    JSON.stringify(loud.lines) === JSON.stringify(quiet.lines),
    JSON.stringify(quiet.lines.map((l) => l.message)),
  )

  // Every message the module can emit, gathered from each branch, must be free
  // of level judgement. "−8 to −5 LUFS is the norm" is the user's canon.
  const everyMessage = [
    ...loud.lines,
    ...quiet.lines,
    ...compareLoudness(B, A).lines,                                                    // quieter
    ...compareLoudness(A, { ...A, integratedLufs: -6.0, shortTermMaxLufs: -0.4 }).lines, // louder, peaks moved with it
    ...compareLoudness(A, { ...A, integratedLufs: -9.1 }).lines,                        // dead zone
    ...compareLoudness(A, { ...B, samplePeakDb: 0.0 }).lines,                           // peak crossing
  ].map((l) => l.message)

  const SCOLDING = /too loud|too quiet|should be|LUFS target/i
  const offenders = everyMessage.filter((m) => SCOLDING.test(m))
  check('no message scolds the level', offenders.length === 0, offenders.join(' | '))
  check('no message quotes an absolute LUFS value at all', !everyMessage.some((m) => /LUFS/i.test(m)))
  check('gathered every branch', everyMessage.length >= 10, `${everyMessage.length} messages`)
}

// ── 6. Antisymmetry ─────────────────────────────────────────────────────────

{
  const ab = compareLoudness(A, B)
  const ba = compareLoudness(B, A)
  check('integratedDeltaDb flips sign with the arguments', ab.integratedDeltaDb === -ba.integratedDeltaDb)
  check('shortTermDeltaDb flips sign with the arguments', ab.shortTermDeltaDb === -ba.shortTermDeltaDb)
  check('crestSpentDb flips sign with the arguments', ab.crestSpentDb === -ba.crestSpentDb)
  check('the reversed direction reads as quieter', ba.lines.some((l) => /quieter/i.test(l.message)))
  check('the reversed direction never claims it got louder', !ba.lines.some((l) => /louder/i.test(l.message)))
}

// ── 7. The dead zone ────────────────────────────────────────────────────────
// 0.2 dB apart is inside the variation of two exports of the same session.
// Claiming a crest-factor change there would be inventing signal out of noise.

{
  const near = { ...A, integratedLufs: A.integratedLufs + 0.2, shortTermMaxLufs: A.shortTermMaxLufs - 1.4 }
  const c = compareLoudness(A, near)
  check('0.2 dB apart reads as the same level', c.lines.some((l) => /same level/i.test(l.message)))
  check('the dead zone makes no crest-factor claim', !c.lines.some((l) => /dynamics|limiting/i.test(l.message)), JSON.stringify(c.lines.map((l) => l.message)))
  check('the dead zone still reports the true deltas', Math.abs(c.integratedDeltaDb - 0.2) < 1e-9 && Math.abs(c.crestSpentDb - 1.6) < 1e-9)

  // …and 0.3 dB, the first step outside it, does speak up.
  const past = { ...A, integratedLufs: A.integratedLufs + 0.4 }
  check('0.4 dB apart is reported as a change', compareLoudness(A, past).lines.some((l) => /louder/i.test(l.message)))
}

// ── 8. Source contract: measured is not editable, and the heal is wired ─────

const patchRoute = read('src/app/api/versions/[id]/route.ts')
const loudnessRoute = read('src/app/api/versions/[id]/loudness/route.ts')
const healSrc = read('src/lib/schema-heal.ts')

const LOUDNESS_COLS = ['loudness_lufs', 'loudness_short_term_lufs', 'sample_peak_db', 'loudness_measured_at', 'loudness_algo']

// The allowlist literal, not the whole file — that is the actual door.
const allowlistOf = (src) => src.match(/const allowed = \[[^\]]*\]/)?.[0] ?? ''
const leaked = (src) => LOUDNESS_COLS.filter((c) => allowlistOf(src).includes(c))

check('the PATCH allowlist was found', allowlistOf(patchRoute).length > 0, allowlistOf(patchRoute))
check('the PATCH allowlist contains no loudness column', leaked(patchRoute).length === 0, leaked(patchRoute).join(', '))

// Witness — the same check against a doctored allowlist, proving it can fail.
const WITNESS = "const allowed = ['status', 'label', 'loudness_lufs', 'allow_download'] as const"
check('witness: the check catches a loudness column in the allowlist', leaked(WITNESS).length === 1 && leaked(WITNESS)[0] === 'loudness_lufs')

check('the loudness route wires the schema heal', /ensureVersionLoudnessColumns/.test(loudnessRoute) && /isMissingVersionLoudnessColumn/.test(loudnessRoute))
check('the loudness route retries after healing', /await ensureVersionLoudnessColumns\(\)/.test(loudnessRoute) && /for \(let attempt/.test(loudnessRoute))
check('the loudness route takes identity from the header only', /request\.headers\.get\('X-User-Id'\)/.test(loudnessRoute) && !/body\.(user|userId|user_id)/.test(loudnessRoute))
check('the loudness route checks ownership through the project join', /mb_projects!inner\(user_id\)/.test(loudnessRoute))
check('the loudness route stamps the SERVER clock', /toLoudnessColumns\(\s*measurement,\s*new Date\(\)\.toISOString\(\)\s*\)/.test(loudnessRoute))
check('the loudness route never reads a client timestamp', !/measured_at['"]?\s*[:=]\s*body/.test(loudnessRoute) && !/body\.[a-zA-Z_]*[Mm]easured/.test(loudnessRoute))
check('the loudness route is rate limited', /loudnessLimiter/.test(loudnessRoute) && /checkUserLimit/.test(loudnessRoute))
check('the loudness route validates the id', /isUuid\(id\)/.test(loudnessRoute))

check('schema-heal exports ensureVersionLoudnessColumns', /export function ensureVersionLoudnessColumns\b/.test(healSrc))
check('schema-heal exports isMissingVersionLoudnessColumn', /export function isMissingVersionLoudnessColumn\b/.test(healSrc))
for (const col of LOUDNESS_COLS) {
  check(`the heal adds "${col}" idempotently`, new RegExp(`add column if not exists ${col}\\b`, 'i').test(healSrc))
}
// Without the reload nudge the retry right after the ALTER is still answered
// from PostgREST's stale schema cache, so the first save after a fresh deploy
// fails even though the DDL worked.
{
  const healBlock = healSrc.slice(healSrc.indexOf('const VERSION_LOUDNESS_SQL'), healSrc.indexOf('export function isMissingVersionLoudnessColumn'))
  check("the heal ends with notify pgrst, 'reload schema'", /notify pgrst, 'reload schema';/.test(healBlock))
}
check('isMissingVersionLoudnessColumn matches a real PostgREST error', isMissingVersionLoudnessColumnLike("Could not find the 'loudness_lufs' column of 'mb_versions' in the schema cache"))
check('isMissingVersionLoudnessColumn ignores unrelated errors', !isMissingVersionLoudnessColumnLike('duplicate key value violates unique constraint'))

// The detector is re-derived from the shipped regex rather than imported:
// schema-heal.ts pulls in @sentry/nextjs, which cannot load under plain Node.
function isMissingVersionLoudnessColumnLike(message) {
  const body = healSrc.slice(healSrc.indexOf('export function isMissingVersionLoudnessColumn'))
  const src = body.match(/\/([^/]+)\/\.test\(error\.message\)/)?.[1]
  if (!src) return false
  return new RegExp(src).test(message)
}

// ── The stored-column shape ─────────────────────────────────────────────────

{
  const at = '2026-08-14T12:00:00.000Z'
  const cols = toLoudnessColumns(sanitizeLoudness(GOOD), at)
  check('toLoudnessColumns writes exactly the five migration-032 columns', JSON.stringify(Object.keys(cols).sort()) === JSON.stringify([...LOUDNESS_COLS].sort()))
  check('toLoudnessColumns carries the server timestamp through untouched', cols.loudness_measured_at === at)
  check('toLoudnessColumns records the algorithm', cols.loudness_algo === LOUDNESS_ALGO)
  check('a silent measurement stores nulls, not infinities', toLoudnessColumns(sanitizeLoudness({ integratedLufs: null, shortTermMaxLufs: null, samplePeakDb: null, gatedBlockCount: 0 }), at).loudness_lufs === null)
  // Round trip: what the route writes must read back as what it wrote.
  check('columns written by the route read back through loudnessFromRow', JSON.stringify(loudnessFromRow(cols)) === JSON.stringify({ ...sanitizeLoudness(GOOD), gatedBlockCount: null }))
}

console.log(failures === 0 ? '\nAll loudness-compare tests passed' : `\n${failures} loudness-compare test(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
