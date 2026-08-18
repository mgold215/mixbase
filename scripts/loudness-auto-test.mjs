#!/usr/bin/env node
// Contract test: the auto-measure gate in src/lib/loudness-auto.ts, AND the
// call site in src/app/projects/[id]/ProjectClient.tsx that is the feature.
//
// This gate exists to keep an UNASKED-FOR measurement from freezing the page
// after an upload. Sections A–H are about one of two things:
//
//   1. The arithmetic is right (probe scales to full by frame ratio).
//   2. Every degenerate input FAILS CLOSED. A gate that opens on a zero, a NaN
//      or an Infinity is worse than no gate at all — it would open precisely
//      when the timing data was unusable.
//
// Timing is injected rather than measured wherever a number is asserted, so the
// suite is deterministic. The one real-clock check uses a range wide enough that
// it can only fail on a units mistake (seconds vs milliseconds), never on load.
//
// SECTION I EXISTS BECAUSE THE ARITHMETIC ALONE PROVES NOTHING ABOUT THE APP.
// loudness-auto.ts is pure by design, so nothing in A–H can see whether the gate
// is actually WIRED UP — and it was possible to leave every one of these checks
// green (this suite, loudness-test and loudness-compare-test alike) while:
//   * awaiting the measurement inside the upload handler, which destroys the
//     headline "cannot delay or fail an upload" guarantee;
//   * deleting the decoded-memory conjunction, or the file-size pre-gate;
//   * returning the PROBE's loudness as the mix's — the exact false premise
//     section H exists to refute, and which its own comment used to claim this
//     suite would catch. It did not. Section I is what makes it catch.
//
// Run: node scripts/loudness-auto-test.mjs

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { stripComments, functionBody } from './source-contract.mjs'
import {
  AUTO_MEASURE_BUDGET_MS,
  AUTO_MEASURE_PROBE_SECONDS,
  AUTO_MEASURE_MAX_FILE_BYTES,
  autoMeasureProbeFrames,
  canAttemptAutoMeasure,
  extrapolateMeasureMs,
  fitsAutoMeasureBudget,
} from '../src/lib/loudness-auto.ts'
import { measureLoudness, canMeasureInBrowser } from '../src/lib/loudness.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

let failures = 0
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

const FS = 44100

// ── A. Probe sizing ──────────────────────────────────────────────────────────
console.log('probe sizing\n')

{
  const fiveMinutes = 300 * FS
  check(
    'a long mix gets exactly the configured probe window',
    autoMeasureProbeFrames(FS, fiveMinutes) === AUTO_MEASURE_PROBE_SECONDS * FS,
    `${autoMeasureProbeFrames(FS, fiveMinutes)} frames`,
  )
  // 48 kHz must scale with the rate, not inherit a 44.1 k frame count.
  check(
    'the probe window follows the sample rate',
    autoMeasureProbeFrames(48000, 300 * 48000) === AUTO_MEASURE_PROBE_SECONDS * 48000,
    `${autoMeasureProbeFrames(48000, 300 * 48000)} frames at 48 kHz`,
  )
  // A signal shorter than the probe must clamp — handing measureLoudness a
  // frame count past the end of the buffer is the bug this prevents.
  const short = 3 * FS
  check(
    'a mix shorter than the probe clamps to the whole signal',
    autoMeasureProbeFrames(FS, short) === short,
    `${autoMeasureProbeFrames(FS, short)} frames`,
  )
  check('a zero-length signal probes nothing', autoMeasureProbeFrames(FS, 0) === 0)
  check('a nonsense sample rate probes nothing', autoMeasureProbeFrames(0, 300 * FS) === 0)
  check('a NaN frame count probes nothing', autoMeasureProbeFrames(FS, NaN) === 0)
}

// ── B. Extrapolation arithmetic ──────────────────────────────────────────────
console.log('\nextrapolation\n')

{
  // 8 s probe of a 300 s mix = 1/37.5 of the work. 20 ms probe ⇒ 750 ms full.
  const probeFrames = 8 * FS
  const totalFrames = 300 * FS
  const est = extrapolateMeasureMs(20, probeFrames, totalFrames)
  check('scales by the frame ratio', Math.abs(est - 750) < 1e-9, `${est.toFixed(1)} ms`)

  // Half the probe time ⇒ half the estimate. Catches an estimate that ignores
  // the measured number and just reports a constant.
  const half = extrapolateMeasureMs(10, probeFrames, totalFrames)
  check('is proportional to the probe time', Math.abs(half - 375) < 1e-9, `${half.toFixed(1)} ms`)

  // Twice the material ⇒ twice the estimate. Catches an estimate that ignores
  // the length of the thing being measured.
  const twice = extrapolateMeasureMs(20, probeFrames, totalFrames * 2)
  check('is proportional to the total length', Math.abs(twice - 1500) < 1e-9, `${twice.toFixed(1)} ms`)

  // A probe covering the whole signal costs what it cost — no scaling.
  check(
    'a whole-signal probe extrapolates to itself',
    extrapolateMeasureMs(12, totalFrames, totalFrames) === 12,
  )
}

// ── C. Degenerate timings must FAIL CLOSED ───────────────────────────────────
// Each of these is a value a real browser can produce. If any returned a small
// number instead of Infinity, the gate would open on unusable data.
console.log('\ndegenerate input fails closed\n')

{
  const frames = 8 * FS
  const total = 300 * FS
  const cases = [
    ['a probe that timed as 0 ms (clock too coarse)', 0],
    ['a negative probe time', -5],
    ['a NaN probe time', NaN],
    ['an Infinite probe time', Infinity],
  ]
  for (const [name, probeMs] of cases) {
    check(`${name} → Infinity`, extrapolateMeasureMs(probeMs, frames, total) === Infinity)
    check(`${name} → gate closed`, fitsAutoMeasureBudget(probeMs, frames, total) === false)
  }
  check('a zero-frame probe → gate closed', fitsAutoMeasureBudget(20, 0, total) === false)
  check('a NaN total → gate closed', fitsAutoMeasureBudget(20, frames, NaN) === false)
  check('a zero total → gate closed', fitsAutoMeasureBudget(20, frames, 0) === false)

  // The gate would fail closed on these anyway (NaN <= x is false, x/0 is
  // Infinity), so it is the RETURNED VALUE that has to be pinned, not just the
  // verdict. extrapolateMeasureMs promises Infinity — "too expensive, refuse" —
  // for every unusable input. Letting it hand back a bare NaN would keep the
  // gate correct today and quietly break any future caller that compares,
  // formats or logs the estimate.
  check('an unusable probe frame count yields Infinity, not NaN', extrapolateMeasureMs(20, NaN, total) === Infinity)
  check('a zero probe frame count yields Infinity', extrapolateMeasureMs(20, 0, total) === Infinity)
  check('an unusable total yields Infinity, not NaN', extrapolateMeasureMs(20, frames, NaN) === Infinity)
}

// ── D. The budget boundary ───────────────────────────────────────────────────
console.log('\nbudget boundary\n')

{
  const probeFrames = 8 * FS
  const total = 300 * FS
  const ratio = total / probeFrames // 37.5
  // Probe times that land exactly on, just under, and just over the budget.
  const atBudget = AUTO_MEASURE_BUDGET_MS / ratio
  check('exactly at the budget is allowed', fitsAutoMeasureBudget(atBudget, probeFrames, total) === true)
  check('just under the budget is allowed', fitsAutoMeasureBudget(atBudget * 0.99, probeFrames, total) === true)
  check('just over the budget is refused', fitsAutoMeasureBudget(atBudget * 1.01, probeFrames, total) === false)
  // A slow device is refused the same material a fast one is allowed. This is
  // the whole point of calibrating rather than guessing a duration cap.
  check('a 5x slower device is refused the same mix', fitsAutoMeasureBudget(atBudget * 5, probeFrames, total) === false)
  check('an explicit budget overrides the default', fitsAutoMeasureBudget(atBudget * 5, probeFrames, total, AUTO_MEASURE_BUDGET_MS * 5) === true)
}

// ── E. Auto is strictly stricter than the manual path ────────────────────────
// The manual "Measure loudness" button is governed by canMeasureInBrowser alone
// (a 600 MB decoded-memory ceiling ≈ 7.4 minutes of 44.1 kHz stereo). The auto
// path is that gate AND the time budget, so it can only ever admit less. The
// property worth asserting is that the conjunction is PROPER: there is material
// the manual button accepts and the auto path declines.
console.log('\nauto is stricter than manual\n')

{
  // A 6-minute stereo mix sits inside the memory ceiling — the button offers it.
  const sixMinutes = 360 * FS
  check('the manual gate accepts a 6-minute stereo mix', canMeasureInBrowser(sixMinutes, 2) === true)

  // On a device ~3x slower than a current laptop (24 ms to probe 8 s), the same
  // mix extrapolates past the budget, so the auto path declines what the button
  // still offers. That gap IS the feature: the slow device keeps the explicit
  // button with its visible progress instead of an unexplained freeze.
  const slowProbeMs = 24
  const est = extrapolateMeasureMs(slowProbeMs, 8 * FS, sixMinutes)
  check(
    'the auto gate declines it on a ~3x slower device',
    fitsAutoMeasureBudget(slowProbeMs, 8 * FS, sixMinutes) === false,
    `${est.toFixed(0)} ms estimated`,
  )
  // ...while a current laptop (~8 ms) takes it. Same mix, different device,
  // different answer — which a fixed duration cap could never express.
  check(
    'and accepts it on a current laptop',
    fitsAutoMeasureBudget(8, 8 * FS, sixMinutes) === true,
    `${extrapolateMeasureMs(8, 8 * FS, sixMinutes).toFixed(0)} ms estimated`,
  )

  // The memory ceiling is the backstop no probe speed can talk past: however
  // fast the device, a mix over ~7.4 minutes is refused outright.
  check('the memory ceiling refuses a 10-minute stereo mix', canMeasureInBrowser(600 * FS, 2) === false)
}

// ── F. The file-size pre-gate admits anything the real gate could ────────────
// This cap only exists to bound the arrayBuffer() allocation. If it were ever
// set below what the decoded-memory gate accepts, it would silently become the
// real limit — and a much dumber one, since file bytes say little about decoded
// cost (a 7-minute FLAC and a 7-minute WAV decode to the same thing).
console.log('\nfile-size pre-gate\n')

{
  // Heaviest realistic master: 48 kHz, 32-bit float, stereo = 384 kB/s.
  const bytesPerSecond = 48000 * 4 * 2
  const secondsAdmitted = AUTO_MEASURE_MAX_FILE_BYTES / bytesPerSecond
  check(
    'admits >7 minutes of the heaviest realistic master format',
    secondsAdmitted > 7 * 60,
    `${(secondsAdmitted / 60).toFixed(1)} min of 48k/32f stereo`,
  )
  // ...and the decoded-memory ceiling gives out at ~7.4 minutes, well before
  // that, so the byte cap is never the binding constraint.
  check(
    'while the decoded-memory ceiling binds first',
    canMeasureInBrowser(Math.round(7.5 * 60 * FS), 2) === false,
    '7.5 min of stereo already exceeds the 600 MB ceiling',
  )
}

// ── F2. The pre-probe conjunction ────────────────────────────────────────────
// canAttemptAutoMeasure composes the byte cap with the decoded-memory ceiling.
// The case that matters is the one the byte cap alone cannot see.
console.log('\npre-probe gates compose\n')

{
  const fits = canMeasureInBrowser
  const sixMinFrames = 360 * FS

  check(
    'a normal 6-minute WAV passes both gates',
    canAttemptAutoMeasure(60 * 1024 * 1024, sixMinFrames, 2, fits) === true,
  )

  // THE case: a small compressed file that decodes past the memory ceiling.
  // 20 MB of FLAC/MP3 is nothing on disk and ~1.2 GB decoded at 12 minutes.
  const twelveMinFrames = 720 * FS
  check(
    'a SMALL file that decodes huge is still refused',
    canAttemptAutoMeasure(20 * 1024 * 1024, twelveMinFrames, 2, fits) === false,
    'the byte cap cannot see this — only the memory ceiling can',
  )
  // ...and the converse: a huge file is refused before anything is decoded,
  // even though its decoded size would have been fine.
  check(
    'a file over the byte cap is refused regardless of decoded size',
    canAttemptAutoMeasure(AUTO_MEASURE_MAX_FILE_BYTES + 1, 60 * FS, 2, fits) === false,
  )
  check(
    'exactly at the byte cap is still allowed',
    canAttemptAutoMeasure(AUTO_MEASURE_MAX_FILE_BYTES, 60 * FS, 2, fits) === true,
  )
  // The decoded shape must reach the ceiling the RIGHT WAY ROUND. Peak cost is
  // samples × (12 × channels + 8), so transposing the two arguments always
  // UNDER-estimates and quietly makes the gate more permissive. Most durations
  // give the same verdict either way and hide it; this one does not — a 9.4-min
  // stereo mix costs 800 MB read correctly (refused) and 572 MB transposed
  // (admitted).
  check(
    'a 9.4-minute stereo mix is refused, and for the right reason',
    canAttemptAutoMeasure(60 * 1024 * 1024, 25_000_000, 2, fits) === false,
    '800 MB correct vs 572 MB if the arguments were transposed',
  )

  // Unknown size must fail CLOSED — iOS uploads write no file size at all.
  check('an unknown file size is refused', canAttemptAutoMeasure(null, sixMinFrames, 2, fits) === false)
  check('an undefined file size is refused', canAttemptAutoMeasure(undefined, sixMinFrames, 2, fits) === false)
  check('a NaN file size is refused', canAttemptAutoMeasure(NaN, sixMinFrames, 2, fits) === false)
  check('a zero-byte file is refused', canAttemptAutoMeasure(0, sixMinFrames, 2, fits) === false)
}

// ── G. Real clock, real measureLoudness ──────────────────────────────────────
// Two couplings the pure arithmetic cannot prove: that a probe taken as a
// SUBARRAY is something measureLoudness accepts, and that the estimate is in
// the same units as the thing it predicts.
console.log('\nend-to-end against the real measurement\n')

{
  const seconds = 60
  const n = seconds * FS
  const sig = new Float32Array(n)
  let s = 12345
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    sig[i] = 0.4 * Math.sin((2 * Math.PI * 110 * i) / FS) + 0.15 * ((s / 0x7fffffff) * 2 - 1)
  }
  const probeFrames = autoMeasureProbeFrames(FS, n)
  const probe = [sig.subarray(0, probeFrames), sig.subarray(0, probeFrames)]

  let threw = null
  const t0 = performance.now()
  try { measureLoudness(probe, FS) } catch (e) { threw = e }
  const probeMs = performance.now() - t0
  check('measureLoudness accepts a subarray probe', threw === null, threw ? String(threw) : undefined)

  const t1 = performance.now()
  measureLoudness([sig, sig], FS)
  const actualMs = performance.now() - t1
  const predicted = extrapolateMeasureMs(probeMs, probeFrames, n)

  // Deliberately wide. A units error (s vs ms) or an inverted ratio is orders of
  // magnitude off and caught here; ordinary machine load is not.
  check(
    'the estimate is within an order of magnitude of the truth',
    predicted > actualMs * 0.25 && predicted < actualMs * 10,
    `predicted ${predicted.toFixed(0)} ms vs actual ${actualMs.toFixed(0)} ms`,
  )
  // The safety direction: warm-up makes a short probe look EXPENSIVE, so the
  // estimate should sit at or above the truth. Reported either way; only a
  // gross under-estimate fails.
  check(
    'and it does not grossly under-estimate',
    predicted > actualMs * 0.5,
    `ratio ${(predicted / actualMs).toFixed(2)}x`,
  )
}

// ── H. Why the probe is a STOPWATCH and never a measurement ──────────────────
// The premise this feature was once built on — "analyzeFile already decodes the
// first chunk, so loudness is nearly free" — is false, and this is the proof
// kept executable: a prefix of a mix with a quiet intro reads nothing like the
// mix.
//
// This section proves the PROPERTY only. It cannot see the call site, so on its
// own it does not stop anyone "optimising" the auto path by reporting the
// probe's own LUFS — the comment here used to claim it would, and that claim was
// false: the swap was made and this suite stayed green. Section I is the half
// that bites, pinning the returned measurement to the full channels. Together
// they say what is wrong with the swap AND that it has not happened.
console.log('\nthe probe is a stopwatch, not a measurement\n')

{
  const intro = 25, body = 120
  const n = (intro + body) * FS
  const sig = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const amp = i < intro * FS ? 0.01 : 0.5 // quiet intro, loud body
    sig[i] = amp * Math.sin((2 * Math.PI * 220 * i) / FS)
  }
  const probeFrames = autoMeasureProbeFrames(FS, n)
  const prefixLufs = measureLoudness([sig.subarray(0, probeFrames)], FS).integratedLufs
  const fullLufs = measureLoudness([sig], FS).integratedLufs
  check(
    'a prefix of a quiet-intro mix is NOT the mix loudness',
    Math.abs(prefixLufs - fullLufs) > 10,
    `prefix ${prefixLufs.toFixed(1)} vs full ${fullLufs.toFixed(1)} LUFS`,
  )
}

// ── I. Source contract: the integration in ProjectClient.tsx ─────────────────
// Everything above is arithmetic over a pure module. The feature is the call
// site, and these are the properties a pure test structurally cannot reach:
// that the upload cannot wait on the measurement, that the gates are actually
// consulted and in the right order, and that what reaches the user is the
// measurement of the WHOLE mix rather than the stopwatch's 8-second slice.
//
// Anchored to extracted function bodies rather than character windows, and read
// from comment-stripped source, so neither a guard that survives only in a
// comment nor a few lines of drift can make one of these pass by accident.
console.log('\nsource contract: the call site in ProjectClient.tsx\n')

{
  const CLIENT = 'src/app/projects/[id]/ProjectClient.tsx'
  const raw = read(CLIENT)
  const src = stripComments(raw)

  // Self-test of the stripper before anything leans on it: the file HAS comments
  // and the stripped copy has none. A stripper that silently no-opped would let
  // a deleted guard keep passing from the comment that describes it.
  check(
    'comments are stripped before any contract below is matched',
    /^\s*\/\//m.test(raw) && !/^\s*\/\//m.test(src),
    `${raw.length} → ${src.length} chars`,
  )

  const measureFn = functionBody(src, 'async function measureUploadedFile')
  const scheduleFn = functionBody(src, 'function scheduleAutoMeasure')
  const uploadFn = functionBody(src, 'async function handleUpload')

  // Positive locators FIRST. Every "does NOT contain" assertion below is
  // vacuously true against an empty slice, so a rename must fail HERE, loudly,
  // rather than quietly disarming the section.
  check(
    'the three regions under contract were located',
    measureFn.length > 0 && scheduleFn.length > 0 && uploadFn.length > 0,
    `measure ${measureFn.length} / schedule ${scheduleFn.length} / upload ${uploadFn.length} chars`,
  )

  // ── I.1 The upload cannot wait on the measurement ─────────────────────────
  // The whole justification for measuring unasked is that it is free to the
  // user. `await measureUploadedFile(file)` in the upload handler — a one-line
  // "simplification" that removes an indirection — silently spends the entire
  // decode + measure inside the upload, which is the one thing this design
  // promises it can never do.
  check(
    'the upload handler hands off to the SCHEDULER',
    /scheduleAutoMeasure\(file, newVersion\.id as string,/.test(uploadFn),
  )
  check(
    '…and never names the measurement itself',
    uploadFn.length > 0 && !/measureUploadedFile/.test(uploadFn),
  )
  const schedCall = uploadFn.split('\n').find(l => l.includes('scheduleAutoMeasure('))
  check(
    '…calling it as a bare statement: not awaited, not assigned, not returned',
    !!schedCall && schedCall.trim().startsWith('scheduleAutoMeasure('),
    schedCall ? schedCall.trim().slice(0, 80) : 'no call found',
  )
  const scheduleSignature = scheduleFn.slice(0, scheduleFn.indexOf('{'))
  check(
    'the scheduler declares a void return, so there is nothing to await',
    /\):\s*void\s*$/.test(scheduleSignature.trimEnd()),
    scheduleSignature.replace(/\s+/g, ' ').trim().slice(0, 90),
  )
  const measureMentions = [...src.matchAll(/measureUploadedFile\b/g)].length
  check(
    'the measurement has exactly one caller, and it is the scheduler',
    measureMentions === 2 && /const m = await measureUploadedFile\(file\)/.test(scheduleFn),
    `${measureMentions} mention(s) in the file (declaration + one call)`,
  )
  check(
    'and it is scheduled only after the version row exists',
    uploadFn.indexOf('if (versionRes.ok)') !== -1
    && uploadFn.indexOf('if (versionRes.ok)') < uploadFn.indexOf('scheduleAutoMeasure('),
  )

  // ── I.2 Every gate is consulted, in the order that makes it cheap ─────────
  const iSize = measureFn.indexOf('file.size > AUTO_MEASURE_MAX_FILE_BYTES')
  const iRead = measureFn.indexOf('file.arrayBuffer()')
  const iMemory = measureFn.indexOf('canAttemptAutoMeasure(')
  const iProbe = measureFn.indexOf('autoMeasureProbeFrames(')
  const iBudget = measureFn.indexOf('fitsAutoMeasureBudget(')
  const iFull = measureFn.indexOf('return measureLoudness(')

  check(
    'gate 1 — the file-size pre-gate is present and refuses',
    /if \(file\.size > AUTO_MEASURE_MAX_FILE_BYTES\) return null/.test(measureFn),
  )
  check(
    '…standing BEFORE the arrayBuffer() allocation it exists to bound',
    iSize !== -1 && iRead !== -1 && iSize < iRead, `gate@${iSize} read@${iRead}`,
  )
  // Pinned argument-for-argument: the decoded SHAPE (frames, channels) has to
  // reach the ceiling the right way round — section F2 shows a transposition
  // under-estimates the cost and quietly makes the gate more permissive.
  check(
    'gate 2 — the decoded-memory conjunction is present, with the real ceiling',
    /if \(!canAttemptAutoMeasure\(file\.size, decoded\.length, decoded\.numberOfChannels, canMeasureInBrowser\)\) return null/
      .test(measureFn),
  )
  check(
    'gate 3 — the measured-time budget is present and refuses',
    /if \(!fitsAutoMeasureBudget\(probeMs, probeFrames, decoded\.length\)\) return null/.test(measureFn),
  )
  check(
    'the gates run cheapest-first and ALL of them precede the full measurement',
    [iSize, iMemory, iProbe, iBudget, iFull].every(i => i !== -1)
    && iSize < iMemory && iMemory < iProbe && iProbe < iBudget && iBudget < iFull,
    `size@${iSize} memory@${iMemory} probe@${iProbe} budget@${iBudget} full@${iFull}`,
  )

  // ── I.3 The probe is a stopwatch — section H, made to bite ────────────────
  const returned = [...measureFn.matchAll(/return measureLoudness\([^\n]*/g)].map(m => m[0].trim())
  check(
    'exactly one measurement is returned to the caller',
    returned.length === 1, returned.join(' | ') || 'none',
  )
  check(
    '…and it is measured over the FULL channels, never the probe slice',
    returned.length === 1
    && returned[0] === 'return measureLoudness(channels, decoded.sampleRate)'
    && !/subarray|\.map\(/.test(returned[0]),
    returned[0] ?? 'none',
  )
  const probeLine = measureFn.split('\n').find(l => l.includes('subarray(0, probeFrames)'))
  check(
    'the probe measures a prefix of the same channels',
    !!probeLine
    && /measureLoudness\(channels\.map\(ch => ch\.subarray\(0, probeFrames\)\), decoded\.sampleRate\)/.test(probeLine),
    probeLine ? probeLine.trim().slice(0, 90) : 'no probe found',
  )
  check(
    '…and its RESULT is thrown away: not returned, not assigned, not cached',
    !!probeLine && probeLine.trim().startsWith('measureLoudness('),
    probeLine ? probeLine.trim().slice(0, 90) : 'no probe found',
  )
  check(
    '…because the only thing taken from it is the clock',
    /const probeStart = performance\.now\(\)\s*\n\s*measureLoudness\(channels\.map/.test(measureFn)
    && /\n\s*const probeMs = performance\.now\(\) - probeStart/.test(measureFn),
  )
  check(
    'a probe that sized to nothing refuses rather than measuring an empty slice',
    /if \(probeFrames <= 0\) return null/.test(measureFn),
  )

  // ── I.4 Nothing re-derives the number between gate and storage ────────────
  // The other end of the same hole: a measurement that survives I.3 could still
  // be replaced on the way out. What is cached and what is POSTed must both be
  // exactly the value measureUploadedFile returned.
  check(
    'the number cached and POSTed is exactly what the gated measurement returned',
    /const m = await measureUploadedFile\(file\)/.test(scheduleFn)
    && /if \(!m\) return/.test(scheduleFn)
    && /writeLoudnessCache\(versionId, m\)/.test(scheduleFn)
    && /body: JSON\.stringify\(m\)/.test(scheduleFn),
  )
}

console.log(failures === 0 ? '\nall auto-measure gate checks passed' : `\n${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
