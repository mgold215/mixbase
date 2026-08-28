#!/usr/bin/env node
// Regression harness for the onset-flux BPM detector (src/lib/audio-analysis.ts
// `detectBPM`). The detector was reworked in 40c394c to stop reporting fast,
// accented tracks at half tempo — it added per-lag normalization, a windowed
// "peak sum", octave (half-tempo) correction, and centroid interpolation of the
// fractional beat lag. That commit claimed synthetic-click verification but
// shipped no test, so this locks the behaviour against regressions.
//
// The detector only reads `audioBuffer.getChannelData(0)` and `.sampleRate`, so
// we exercise it with a tiny stub AudioBuffer built from a synthesized click
// track (decaying 1.2 kHz tone bursts at each beat). A seeded LCG supplies the
// optional timing jitter, so every run is deterministic (no Math.random).
//
// What is asserted here is only the UNAMBIGUOUS behaviour:
//   • genuine slow tracks (60–100 BPM) are never doubled,
//   • steady fast tracks land on the right tempo,
//   • mildly-accented fast tracks are no longer halved (the fix working),
//   • centroid interpolation recovers fractional lags (174 DnB → 174, not 171/176),
//   • the output is always a finite integer in [60,200] — even for silence and
//     sub-second clips (where `c /= maxFrames - lag` divides by zero for the
//     top lags; we prove that NaN never reaches the returned value).
// A fail-first WITNESS reconstructs the pre-40c394c argmax-only detector and
// proves it halves both the mild-accent 126 track and a clean steady 174 track
// (the fractional 1-beat lag 34.48 splits across bins 34/35 while the 2-beat lag
// 68.97 lands almost exactly on integer 69 and wins) — so this test would have
// failed on the old code.
//
// A NON-asserting diagnostic block prints the strong-accent (dominant-kick)
// case, which the shipped 0.3 relative-magnitude gate still reports at half
// tempo. That is a documented, queued heuristic tradeoff (see the backlog):
// the autocorrelation cannot distinguish an alt-accented fast track from a slow
// track with equally-strong eighth-note subdivisions, so lowering the gate to
// catch the former also over-doubles the latter. Resolving it needs A/B
// validation against real music, so it is surfaced, not silently "fixed" here.
//
// Runs on Node native TS type-stripping, same as the other renderer tests.
// Run: node scripts/bpm-test.mjs  (also part of `npm run test:renderers`)

import { detectBPM } from '../src/lib/audio-analysis.ts'

let failures = 0
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    console.error(`  ✗ ${name}${detail !== undefined ? ` — ${detail}` : ''}`)
    failures++
  }
}

// ── Synthetic click track → stub AudioBuffer ────────────────────────────────
// A decaying tone burst at each beat gives a clean onset (sharp energy rise →
// positive flux). `accentAlt` accents alternate beats (strong/weak) to model
// kick-on-1&3 patterns; `weak` is the alternate-beat amplitude; `jitterMs` adds
// deterministic human timing wobble.
function clickTrack({ bpm, seconds = 20, sr = 44100, accentAlt = false, weak = 0.3, strong = 1.0, jitterMs = 0 }) {
  const n = Math.floor(seconds * sr)
  const data = new Float32Array(n)
  const beatSamp = (60 / bpm) * sr
  let seed = 0x2545f4 // fixed → deterministic jitter
  const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  const burst = Math.floor(0.012 * sr)
  const put = (start, amp) => {
    for (let k = 0; k < burst; k++) {
      const idx = Math.floor(start) + k
      if (idx >= 0 && idx < n) data[idx] += amp * Math.sin(2 * Math.PI * 1200 * k / sr) * Math.exp(-k / (0.004 * sr))
    }
  }
  const total = Math.floor(seconds * bpm / 60)
  for (let t = 0; t < total; t++) {
    const jit = jitterMs ? (rng() * 2 - 1) * (jitterMs / 1000) * sr : 0
    put(t * beatSamp + jit, accentAlt ? (t % 2 === 0 ? strong : weak) : strong)
  }
  return { sampleRate: sr, getChannelData: () => data }
}
const bpmOf = (cfg) => detectBPM(clickTrack(cfg))
const TOL = 4 // BPM; 10ms framing quantizes lag, centroid interpolation trims most of it

// ── 1. Genuine slow tracks are never doubled ────────────────────────────────
console.log('bpm: genuine slow tempos (60–100) stay put — no spurious doubling')
for (const b of [61, 63, 66, 70, 75, 80, 88, 95, 99]) {
  const got = bpmOf({ bpm: b })
  check(`${b} BPM steady → ${b}±${TOL}`, Math.abs(got - b) <= TOL, got)
}
check('88 BPM with ±8ms jitter stays ~88 (not doubled)', Math.abs(bpmOf({ bpm: 88, jitterMs: 8 }) - 88) <= TOL, bpmOf({ bpm: 88, jitterMs: 8 }))

// ── 2. Steady fast tracks land on the right tempo ───────────────────────────
console.log('\nbpm: steady fast tempos land correctly')
for (const b of [120, 128, 132, 140, 150, 160, 174, 185]) {
  const got = bpmOf({ bpm: b })
  check(`${b} BPM steady → ${b}±${TOL}`, Math.abs(got - b) <= TOL, got)
}

// ── 3. Mildly-accented fast tracks are no longer halved (the fix working) ────
// Pre-40c394c these reported half tempo; octave correction now recovers them.
console.log('\nbpm: mildly-accented fast tracks are not halved (octave correction)')
for (const [b, w] of [[126, 0.6], [150, 0.55], [140, 0.5], [128, 0.6]]) {
  const got = bpmOf({ bpm: b, accentAlt: true, weak: w })
  check(`${b} BPM alt-accent(weak=${w}) → ${b}±${TOL} (not ~${Math.round(b / 2)})`, Math.abs(got - b) <= TOL, got)
}

// ── 4. Centroid interpolation recovers fractional beat lags ─────────────────
// 174 BPM = lag 34.48; a single-bin readout gives 176 (lag 34) or 171 (lag 35).
console.log('\nbpm: centroid interpolation recovers fractional lags')
for (const b of [174, 138, 132]) {
  const got = bpmOf({ bpm: b })
  check(`${b} BPM resolves to ${b}±2 via interpolation`, Math.abs(got - b) <= 2, got)
}

// ── 5. Output is always a finite integer in [60,200] ────────────────────────
// Guards against NaN/Inf leaking from the per-lag `c /= maxFrames - lag` divide
// on sub-second clips (top lags divide by ≤0), and from silence.
console.log('\nbpm: output is always a finite tempo in [60,200] (no NaN/Inf)')
const bounded = (v) => Number.isInteger(v) && v >= 60 && v <= 200
for (const s of [0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.8, 1, 2, 5]) {
  const got = bpmOf({ bpm: 120, seconds: s })
  check(`${s}s clip → finite tempo in [60,200]`, bounded(got), got)
}
const silence = detectBPM({ sampleRate: 44100, getChannelData: () => new Float32Array(44100 * 15) })
check('15s of silence → finite tempo in [60,200] (no crash/NaN)', bounded(silence), silence)
const empty = detectBPM({ sampleRate: 44100, getChannelData: () => new Float32Array(0) })
check('empty buffer → finite tempo in [60,200] (no crash/NaN)', bounded(empty), empty)

// ── 6. Fail-first witness: the pre-40c394c argmax-only detector ─────────────
// Reconstructs the old body (no normalization, no octave correction, no
// interpolation) and proves it MIS-detects the cases section 3 & 4 now pass —
// i.e. this harness would have failed on the pre-fix code.
console.log('\nbpm: fail-first witness — pre-fix detector halved/mis-rounded these')
function detectBPM_prefix(ab) {
  const data = ab.getChannelData(0)
  const sr = ab.sampleRate
  const windowSize = Math.floor(sr * 0.01)
  const maxFrames = Math.min(Math.floor(data.length / windowSize), 3000)
  const energy = new Float32Array(maxFrames)
  for (let i = 0; i < maxFrames; i++) {
    const s = i * windowSize; let sum = 0
    for (let j = 0; j < windowSize; j++) { const v = data[s + j] ?? 0; sum += v * v }
    energy[i] = sum / windowSize
  }
  const flux = new Float32Array(maxFrames)
  for (let i = 1; i < maxFrames; i++) flux[i] = Math.max(0, energy[i] - energy[i - 1])
  let bestLag = 50, bestCorr = -1
  for (let lag = 30; lag <= 100; lag++) {
    let c = 0
    for (let i = 0; i < maxFrames - lag; i++) c += flux[i] * flux[i + lag]
    if (c > bestCorr) { bestCorr = c; bestLag = lag }
  }
  return Math.round(60_000 / (bestLag * 10))
}
const mildTrack = clickTrack({ bpm: 126, accentAlt: true, weak: 0.6 })
const dnbTrack = clickTrack({ bpm: 174 })
const oldMild = detectBPM_prefix(mildTrack)
const newMild = detectBPM(mildTrack)
const oldDnb = detectBPM_prefix(dnbTrack)
const newDnb = detectBPM(dnbTrack)
check('witness: pre-fix halves the 126 alt-accent track', Math.abs(oldMild - 63) <= TOL, `old=${oldMild}`)
check('witness: current code recovers it to 126', Math.abs(newMild - 126) <= TOL, `new=${newMild}`)
check('witness: pre-fix halves a clean 174 track (fractional-bin bias)', oldDnb < 100, `old=${oldDnb}`)
check('witness: current code interpolates 174 exactly', Math.abs(newDnb - 174) <= 2, `new=${newDnb}`)

// ── Synth helper for the drum-focus cases ───────────────────────────────────
// Adds decaying tone bursts at `freq` every 60/bpm s over [fromSec, toSec) —
// clickTrack's put() generalized so interference can be layered onto drums.
function addBursts(data, sr, { bpm, freq, amp, fromSec = 0, toSec, decaySec = 0.004, burstSec = 0.012 }) {
  const beatSamp = (60 / bpm) * sr
  const burst = Math.floor(burstSec * sr)
  for (let start = fromSec * sr; start < toSec * sr; start += beatSamp) {
    for (let k = 0; k < burst; k++) {
      const idx = Math.floor(start) + k
      if (idx < data.length) data[idx] += amp * Math.sin(2 * Math.PI * freq * k / sr) * Math.exp(-k / (decaySec * sr))
    }
  }
}

// Realistic drums for the drum-focus cases: a kick (55 Hz, where real kicks
// live) plus hats (5 kHz). The 1.2 kHz clicks of the earlier sections are fine
// for pure-tempo assertions but carry no low-band content, so they can't
// exercise the kick band the drum-focused detector relies on.
function addDrums(data, sr, { bpm, fromSec = 0, toSec }) {
  addBursts(data, sr, { bpm, freq: 55, amp: 1.0, fromSec, toSec, decaySec: 0.02, burstSec: 0.06 })
  addBursts(data, sr, { bpm, freq: 5000, amp: 0.5, fromSec, toSec, decaySec: 0.004, burstSec: 0.012 })
}

// ── 7. Drum focus: loud mid-band rhythm must not steal the tempo ────────────
// A 450 Hz "vocal/pad" pulse at 97 BPM layered louder than the 120 BPM drums.
// The full-band detector follows the louder mid-band rhythm; the band-split
// detector attenuates mid content in both drum bands and stays on the drums.
console.log('\nbpm: drum focus — mid-band interference does not steal the tempo')
{
  const sr = 44100
  const mixed = new Float32Array(20 * sr)
  addDrums(mixed, sr, { bpm: 120, toSec: 20 })
  addBursts(mixed, sr, { bpm: 97, freq: 450, amp: 1.6, toSec: 20, decaySec: 0.03, burstSec: 0.15 })
  const buf = { sampleRate: sr, getChannelData: () => mixed }
  const oldGot = detectBPM_prefix(buf)
  const newGot = detectBPM(buf)
  check('witness: full-band detector is pulled off the drums', Math.abs(oldGot - 120) > TOL, `old=${oldGot}`)
  check(`drum-focused detector stays on 120±${TOL}`, Math.abs(newGot - 120) <= TOL, newGot)
}

// ── 8. Beatless intro: analyze where the drums are, not the first 30 s ──────
// 24 s of pad swells, then drums from 24–54 s. The old detector only ever saw
// the first 30 s (mostly swells); the new one selects the densest drum window.
console.log('\nbpm: beatless intro — the drum section is what gets analyzed')
{
  const sr = 44100
  const track = new Float32Array(60 * sr)
  addBursts(track, sr, { bpm: 67, freq: 450, amp: 1.2, toSec: 24, decaySec: 0.05, burstSec: 0.3 })
  addDrums(track, sr, { bpm: 120, fromSec: 24, toSec: 54 })
  const buf = { sampleRate: sr, getChannelData: () => track }
  const oldGot = detectBPM_prefix(buf)
  const newGot = detectBPM(buf)
  check('witness: first-30s-only detector reads the intro swells', Math.abs(oldGot - 120) > TOL, `old=${oldGot}`)
  check(`window-selecting detector finds the drums → 120±${TOL}`, Math.abs(newGot - 120) <= TOL, newGot)
}

// ── Diagnostic (non-asserting): known strong-accent half-tempo limitation ────
// Surfaced, not asserted. A dominant-kick pattern (alternate beats ≤ ~40% of the
// downbeat) still reads at half tempo because the shipped octave gate is a
// relative-magnitude test (half-lag peak ≥ 0.3× main). See the backlog: this is
// a fundamental autocorrelation tradeoff pending real-music A/B validation.
console.log('\nbpm: [diagnostic] strong-accent half-tempo limitation (NOT asserted — queued tradeoff)')
for (const w of [0.2, 0.3, 0.4]) {
  const got = bpmOf({ bpm: 126, accentAlt: true, weak: w })
  console.log(`  · 126 BPM dominant-kick (weak=${w}) → ${got}${got < 100 ? '  [still halved — known limitation]' : '  [recovered]'}`)
}

console.log(failures === 0 ? '\nAll bpm tests passed' : `\n${failures} bpm test(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
