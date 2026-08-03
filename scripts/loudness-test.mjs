#!/usr/bin/env node
// Contract test: the BS.1770-4 loudness measurement in src/lib/loudness.ts.
//
// Two layers of proof:
//   A) Closed-form synthetic signals generated in-process, where the correct
//      answer is known from the spec itself: a full-scale 997 Hz sine reads
//      −3.01 LUFS, amplitude is linear in dB, the −70/−10 gates must exclude
//      a long quiet passage (the part naive implementations get wrong), and a
//      dual-mono stereo signal reads +3.01 dB over one mono channel.
//   B) An INDEPENDENT ORACLE: the bundled ffmpeg's own `ebur128` filter (the
//      reference implementation everyone measures against), run on generated
//      WAVs whose decoded PCM is then fed to measureLoudness — the two
//      integrated readings must agree within ±0.5 LU across tonal, multi-tone,
//      noise, and stereo material. This catches filter-coefficient mistakes
//      that self-consistent synthetic checks cannot.
//
// Run: node scripts/loudness-test.mjs   (also part of `npm run test:renderers`)

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { measureLoudness, masterVerdict, dspDeltas, formatLufs, canMeasureInBrowser, estimateMeasurePeakBytes, MAX_MEASURE_PEAK_BYTES } from '../src/lib/loudness.ts'

const require = createRequire(import.meta.url)
const FFMPEG = require('@ffmpeg-installer/ffmpeg').path

let failures = 0
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}
const close = (a, b, tol) => Math.abs(a - b) <= tol

// ── A. Closed-form synthetic signals ─────────────────────────────────────────
console.log('closed-form signals (the spec supplies the right answer)\n')

const FS = 48000
function sine(freq, seconds, amplitude, fs = FS) {
  const out = new Float32Array(Math.round(seconds * fs))
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / fs)
  return out
}

// Calibration: the −0.691 offset exists precisely so a 0 dBFS 997 Hz sine
// measures −3.01 LUFS (its mean square is 1/2 → −3.01 dB, K-gain ≈ 0 there).
{
  const m = measureLoudness([sine(997, 10, 1.0)], FS)
  check('full-scale 997 Hz sine reads −3.01 LUFS', close(m.integratedLufs, -3.01, 0.1), formatLufs(m.integratedLufs))
  check('its sample peak is ~0 dBFS', close(m.samplePeakDb, 0, 0.05), `${m.samplePeakDb.toFixed(3)} dBFS`)
}

// Linearity: −6.02 dB of amplitude = −6.02 LU of loudness, exactly.
{
  const full = measureLoudness([sine(997, 10, 1.0)], FS)
  const half = measureLoudness([sine(997, 10, 0.5)], FS)
  check('halving amplitude drops loudness by exactly 6.02 LU',
    close(full.integratedLufs - half.integratedLufs, 6.0206, 0.02),
    `Δ = ${(full.integratedLufs - half.integratedLufs).toFixed(3)} LU`)
  check('half amplitude peaks at −6.02 dBFS', close(half.samplePeakDb, -6.0206, 0.05), `${half.samplePeakDb.toFixed(3)} dBFS`)
}

// Gating — the behaviour every naive RMS meter gets wrong. 8 s of a loud sine
// followed by 30 s of a very quiet one: the quiet stretch sits above the −70
// absolute gate but far below the relative gate, so integrated loudness must
// report the LOUD material, not the duration-weighted average.
{
  const loud = sine(997, 8, 0.5)
  const quiet = sine(997, 30, 0.005) // ≈ −49 LUFS: above absolute gate, below relative
  const joined = new Float32Array(loud.length + quiet.length)
  joined.set(loud, 0)
  joined.set(quiet, loud.length)

  const loudOnly = measureLoudness([loud], FS)
  const gated = measureLoudness([joined], FS)
  check('a long quiet tail does not drag integrated loudness down',
    close(gated.integratedLufs, loudOnly.integratedLufs, 0.3),
    `loud-only ${formatLufs(loudOnly.integratedLufs)} vs with-tail ${formatLufs(gated.integratedLufs)}`)

  // Witness: the ungated duration-weighted average is ~7 dB quieter — if the
  // gates were broken, the with-tail reading would collapse toward this.
  const meanSquareUngated = (0.5 ** 2 / 2) * (8 / 38) + (0.005 ** 2 / 2) * (30 / 38)
  const ungatedLufs = -0.691 + 10 * Math.log10(meanSquareUngated)
  check('witness: the ungated average is far lower (gates are load-bearing)',
    loudOnly.integratedLufs - ungatedLufs > 5, `ungated would read ≈ ${ungatedLufs.toFixed(1)} LUFS`)

  // Silence really is unmeasurable, and says so rather than returning junk.
  const silent = measureLoudness([new Float32Array(FS)], FS)
  check('digital silence reads −∞', silent.integratedLufs === -Infinity)
  check('masterVerdict flags unmeasurable audio as an error',
    masterVerdict(silent).some(i => i.level === 'error'))
}

// Channel summation: the same signal on L and R doubles the power → +3.01 LU.
{
  const mono = sine(997, 10, 0.25)
  const one = measureLoudness([mono], FS)
  const two = measureLoudness([mono, mono], FS)
  check('dual-mono stereo reads +3.01 LU over one channel',
    close(two.integratedLufs - one.integratedLufs, 3.0103, 0.02),
    `Δ = ${(two.integratedLufs - one.integratedLufs).toFixed(3)} LU`)
}

// Short-term max: a hot 3 s chorus inside a quieter track must surface.
{
  const verse = sine(500, 6, 0.1)
  const chorus = sine(500, 3, 0.6)
  const track = new Float32Array(verse.length * 2 + chorus.length)
  track.set(verse, 0)
  track.set(chorus, verse.length)
  track.set(verse, verse.length + chorus.length)
  const m = measureLoudness([track], FS)
  const chorusAlone = measureLoudness([chorus], FS)
  check('short-term max finds the hottest 3 s section',
    close(m.shortTermMaxLufs, chorusAlone.integratedLufs, 0.5),
    `${formatLufs(m.shortTermMaxLufs)} vs chorus ${formatLufs(chorusAlone.integratedLufs)}`)
}

// 44.1 kHz — the coefficients must be derived per sample rate, not copied
// from the spec's 48 kHz table. The same sine must measure the same.
{
  const at48 = measureLoudness([sine(997, 10, 0.5)], 48000)
  const at441 = measureLoudness([sine(997, 10, 0.5, 44100)], 44100)
  check('44.1 kHz agrees with 48 kHz for the same signal',
    close(at48.integratedLufs, at441.integratedLufs, 0.05),
    `${formatLufs(at48.integratedLufs)} vs ${formatLufs(at441.integratedLufs)}`)
}

// ── Verdict logic (pure) ─────────────────────────────────────────────────────
// Genre calibration (user feedback, 2026-08-02): −8 to −5 LUFS is the NORM for
// EDM/techno club masters, not a defect — the verdict must inform (turn-down
// number, peak guidance), never scold. Only peak headroom keeps a warning on a
// loud master, and only truly-beyond-club levels (> −5) warn about loudness.
console.log('\nverdict rules')
{
  // A −7 LUFS techno master with sensible headroom is fine — NO warnings.
  const techno = { integratedLufs: -7.0, shortTermMaxLufs: -4, samplePeakDb: -2.1, gatedBlockCount: 100 }
  const verdictTechno = masterVerdict(techno)
  check('a −7 LUFS club master with headroom gets zero warnings',
    verdictTechno.every(i => i.level !== 'warning'), verdictTechno.map(i => i.level).join(', '))
  check('…and an info row acknowledging club-level loudness',
    verdictTechno.some(i => i.level === 'info' && /club/i.test(i.message)))

  // The same master slammed to 0 dBFS peaks: the CLIPPING risk warns (with the
  // stricter loud-master guidance), the loudness itself still does not.
  const technoClipped = { integratedLufs: -7.0, shortTermMaxLufs: -4, samplePeakDb: -0.02, gatedBlockCount: 100 }
  const verdictClipped = masterVerdict(technoClipped)
  check('a clipped club master warns about peaks, not loudness',
    verdictClipped.filter(i => i.level === 'warning').length === 1
      && /peak/i.test(verdictClipped.find(i => i.level === 'warning').message),
    verdictClipped.map(i => i.level).join(', '))
  check('…and the loud-master peak guidance cites −2 dB',
    verdictClipped.some(i => /−2 dB/.test(i.message)))

  // Beyond even club norms, loudness itself finally warns.
  const extreme = { integratedLufs: -4.4, shortTermMaxLufs: -2, samplePeakDb: -0.05, gatedBlockCount: 100 }
  check('past −5 LUFS the loudness itself warns too',
    masterVerdict(extreme).filter(i => i.level === 'warning').length >= 2,
    masterVerdict(extreme).map(i => i.level).join(', '))

  const healthy = { integratedLufs: -13.5, shortTermMaxLufs: -10, samplePeakDb: -1.4, gatedBlockCount: 100 }
  const verdictHealthy = masterVerdict(healthy)
  check('a healthy master gets a single info row (never silence)',
    verdictHealthy.length === 1 && verdictHealthy[0].level === 'info')

  const quiet = { integratedLufs: -22, shortTermMaxLufs: -18, samplePeakDb: -8, gatedBlockCount: 100 }
  check('a very quiet master warns', masterVerdict(quiet).some(i => i.level === 'warning'))

  const deltas = dspDeltas(healthy)
  check('dspDeltas covers the four platforms', deltas.length === 4, deltas.map(d => d.name).join(', '))
  const spotify = deltas.find(d => d.name === 'Spotify')
  check('Spotify delta is integrated − target', close(spotify.deltaDb, -13.5 - -14, 1e-9), `${spotify.deltaDb.toFixed(2)} dB`)
}

// ── B. ffmpeg ebur128 as an independent oracle ───────────────────────────────
console.log('\nffmpeg ebur128 oracle (reference implementation, ±0.5 LU)\n')

const dir = mkdtempSync(join(tmpdir(), 'loudness-test-'))

function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const out = []
    const err = []
    p.stdout.on('data', d => out.push(d))
    p.stderr.on('data', d => err.push(d))
    p.on('error', reject)
    p.on('close', code => {
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() })
      else reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(err).toString().slice(-400)}`))
    })
  })
}

/** ffmpeg's own integrated reading for a file: the `I: -xx.x LUFS` summary line.
 *  ebur128 also logs a running `I:` on every progress frame (starting at −70
 *  before it has data), so take the LAST match — the end-of-run summary. */
async function oracleIntegrated(file) {
  const { stderr } = await run(['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128', '-f', 'null', '-'])
  const matches = [...stderr.matchAll(/I:\s*(-?[\d.]+)\s*LUFS/g)]
  if (!matches.length) throw new Error(`ebur128 summary not found in ffmpeg output:\n${stderr.slice(-400)}`)
  return Number(matches[matches.length - 1][1])
}

/** Decode a file to float32 PCM and split interleaved samples per channel. */
async function decode(file, channels) {
  const { stdout } = await run(['-v', 'error', '-i', file, '-f', 'f32le', '-acodec', 'pcm_f32le', '-'])
  const interleaved = new Float32Array(stdout.buffer, stdout.byteOffset, stdout.byteLength / 4)
  const perCh = Math.floor(interleaved.length / channels)
  const out = []
  for (let c = 0; c < channels; c++) {
    const ch = new Float32Array(perCh)
    for (let i = 0; i < perCh; i++) ch[i] = interleaved[i * channels + c]
    out.push(ch)
  }
  return out
}

const CASES = [
  { name: 'pure 997 Hz tone', gen: 'sine=frequency=997:sample_rate=48000:duration=8', channels: 1, rate: 48000 },
  { name: 'bass + treble multi-tone', gen: "aevalsrc=0.4*sin(2*PI*60*t)+0.15*sin(2*PI*3000*t):s=48000:d=8", channels: 1, rate: 48000 },
  { name: 'white noise', gen: 'anoisesrc=colour=white:amplitude=0.25:sample_rate=48000:duration=8:seed=42', channels: 1, rate: 48000 },
  { name: 'stereo tone (44.1 kHz)', gen: 'sine=frequency=440:sample_rate=44100:duration=8', channels: 2, rate: 44100, extra: ['-ac', '2'] },
]

try {
  for (const c of CASES) {
    const wav = join(dir, `${c.name.replace(/[^a-z0-9]+/gi, '-')}.wav`)
    await run(['-y', '-v', 'error', '-f', 'lavfi', '-i', c.gen, ...(c.extra ?? []), wav])
    const [expected, channels] = await Promise.all([oracleIntegrated(wav), decode(wav, c.channels)])
    const ours = measureLoudness(channels, c.rate).integratedLufs
    check(`${c.name}: agrees with ffmpeg ebur128`, close(ours, expected, 0.5),
      `ours ${ours.toFixed(2)} vs ffmpeg ${expected.toFixed(2)} LUFS`)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}


// ── 2026-08-03: the in-browser decode gate ───────────────────────────────────
// The gate this replaced read `fileSizeBytes != null && fileSizeBytes > 150MB`.
// Two independent defects: it guessed memory from the UPLOAD SIZE on the
// assumption that decoding costs ~4x the file (the real figure is ~10x, and it
// scales with duration x sample rate, not file bytes), and `!= null` meant an
// UNKNOWN size fell OPEN — so every mix uploaded from the iOS app, which writes
// neither file_size_bytes nor duration_seconds, skipped the check entirely.
// The gate now runs after decode, where the true cost is exactly knowable.
console.log('\nIn-browser decode gate')
{
  const stereoSamples = sec => Math.round(sec * 44100)

  // Sanity: the estimator matches the documented memory model.
  //   n x (8 x channels [prefixes] + 8 [scratch] + 4 x channels [decoded])
  const n = stereoSamples(600) // 10 minutes
  check('the estimator reproduces the measured ~1 GB for a 10-minute stereo mix',
    close(estimateMeasurePeakBytes(n, 2) / 1e9, 0.85, 0.15),
    `${(estimateMeasurePeakBytes(n, 2) / 1e9).toFixed(2)} GB`)

  check('a 3-minute stereo track is measurable',
    canMeasureInBrowser(stereoSamples(180), 2) === true)
  check('a 30-minute DJ mix is refused',
    canMeasureInBrowser(stereoSamples(1800), 2) === false)
  check('mono doubles the allowance vs stereo',
    canMeasureInBrowser(stereoSamples(600), 1) === true &&
    canMeasureInBrowser(stereoSamples(600), 2) === false)

  // Degenerate inputs must FAIL CLOSED — the old gate's cardinal sin was
  // treating "I don't know" as "it's fine".
  check('zero samples is refused', canMeasureInBrowser(0, 2) === false)
  check('NaN sample count is refused', canMeasureInBrowser(NaN, 2) === false)
  check('NaN channel count is refused', canMeasureInBrowser(stereoSamples(60), NaN) === false)
  check('negative input is refused', canMeasureInBrowser(-1, 2) === false)

  // Witness: the pre-fix gate on a 9-minute mix uploaded from iOS (no recorded
  // size) and on a 10-minute WAV that sits just under the old 150 MB threshold.
  const preFixGate = (fileSizeBytes) => !(fileSizeBytes != null && fileSizeBytes > 150 * 1024 * 1024)
  check('witness: pre-fix ALLOWED an iOS upload with no recorded size',
    preFixGate(null) === true)
  check('the fixed gate refuses that same 9-minute signal',
    canMeasureInBrowser(stereoSamples(540), 2) === false)
  check('witness: pre-fix ALLOWED a 101 MB 10-minute WAV (needs ~1 GB)',
    preFixGate(101 * 1024 * 1024) === true)
  check('the fixed gate refuses it',
    canMeasureInBrowser(stereoSamples(600), 2) === false)

  check('the budget is stated in bytes and is phone-sized',
    MAX_MEASURE_PEAK_BYTES > 0 && MAX_MEASURE_PEAK_BYTES <= 1024 * 1024 * 1024)
}

if (failures > 0) {
  console.error(`\nloudness: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nloudness: all checks passed')
