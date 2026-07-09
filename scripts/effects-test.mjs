// Free-effects engine smoke test — exercises the REAL production module
// (src/lib/free-effects.ts via Node type stripping), no inline copies.
//
// Run: node scripts/effects-test.mjs
//
// The engine takes an injected layer factory instead of touching the DOM, so
// it runs here against stub 2D contexts that:
//  - throw if any drawing call receives a non-finite number (NaN/Infinity
//    coordinates are the classic way canvas animation code rots silently —
//    the canvas just stops drawing, no error)
//  - count drawImage calls so we know every effect actually drew the artwork
//
// Also asserts the loop math that seamless looping depends on: integer-cycle
// oscillators returning to their start value, beat counts snapping to whole
// numbers, and beat envelopes decaying to ~0 before the wrap.

import {
  EFFECTS,
  EFFECT_IDS,
  mulberry32,
  loopSin,
  snapBeats,
  beatPulse,
  coverDims,
} from '../src/lib/free-effects.ts'

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// ── Stub canvas plumbing ────────────────────────────────────────────────────

function makeStubCtx(stats, log) {
  const fn = (method) => (...args) => {
    for (const a of args) {
      if (typeof a === 'number' && !Number.isFinite(a)) {
        throw new Error(`${method} received non-finite number: ${args.join(', ')}`)
      }
    }
    // Optional draw-call fingerprint: record the numeric args of every call so a
    // test can assert two renders produced byte-identical geometry.
    if (log) {
      const nums = args.filter((a) => typeof a === 'number')
      if (nums.length) log.push(`${method}:${nums.join(',')}`)
    }
    if (method === 'drawImage') stats.drawImage++
    if (method === 'createImageData') {
      const [w, h] = args
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }
    }
    if (method === 'createRadialGradient' || method === 'createLinearGradient') {
      return { addColorStop: () => {} }
    }
    return undefined
  }
  const cache = {}
  return new Proxy(
    {},
    {
      get(_, prop) {
        if (typeof prop !== 'string') return undefined
        return (cache[prop] ??= fn(prop))
      },
      set() {
        return true // fillStyle / globalAlpha / composite assignments
      },
    },
  )
}

function makeSetup(stats, { W, H, duration, bpm = 122, seed = 42 }, log) {
  return {
    W,
    H,
    duration,
    fps: 30,
    bpm,
    seed,
    image: { width: 1200, height: 800 },
    imageWidth: 1200,
    imageHeight: 800,
    // Route layer contexts into the same fingerprint log as the main ctx so
    // per-frame draws onto scratch canvases (e.g. VHS tracking jitter) are seen.
    createLayer: (w, h) => ({ canvas: { width: w, height: h }, ctx: makeStubCtx(stats, log) }),
  }
}

// ── Loop math ───────────────────────────────────────────────────────────────

{
  const rng = mulberry32(1234)
  const vals = [rng(), rng(), rng()]
  const rng2 = mulberry32(1234)
  const vals2 = [rng2(), rng2(), rng2()]
  check('mulberry32 is deterministic per seed', vals.every((v, i) => v === vals2[i]))
  check('mulberry32 output in [0,1)', vals.every(v => v >= 0 && v < 1))
}

{
  let seamless = true
  for (let cycles = 1; cycles <= 4; cycles++) {
    for (const phase of [0, 1.3, 4.2]) {
      if (Math.abs(loopSin(0, cycles, phase) - loopSin(1, cycles, phase)) > 1e-9) seamless = false
    }
  }
  check('loopSin returns to start after one loop (integer cycles)', seamless)
}

check('snapBeats(6s, 122bpm) → 12 whole beats', snapBeats(6, 122) === 12)
check('snapBeats(30s, 124bpm) → 62 whole beats', snapBeats(30, 124) === 62)
check('snapBeats never returns < 1', snapBeats(1, 10) === 1)

{
  const beats = 12
  const atBeat = beatPulse(0, beats)
  const preWrap = beatPulse(1 - 1e-6, beats)
  check('beatPulse peaks at the beat', Math.abs(atBeat - 1) < 1e-9)
  check('beatPulse decays to ~0 before the wrap', preWrap < 0.01, `pre-wrap value ${preWrap.toFixed(5)}`)
}

{
  const a = coverDims(1200, 800, 270, 480) // wide image, portrait canvas
  const b = coverDims(800, 1200, 480, 270) // tall image, landscape canvas
  check('coverDims covers portrait canvas', a.drawW >= 270 && a.drawH >= 480)
  check('coverDims covers landscape canvas', b.drawW >= 480 && b.drawH >= 270)
}

// ── Every effect renders every frame with finite numbers ────────────────────

const SHAPES = [
  { name: 'portrait 6s', W: 270, H: 480, duration: 6 },
  { name: 'landscape 30s', W: 480, H: 270, duration: 30 },
]

for (const id of EFFECT_IDS) {
  for (const shape of SHAPES) {
    const stats = { drawImage: 0 }
    const frames = shape.duration * 30
    // Sample the full loop but keep the 30s case fast (every 3rd frame)
    const step = shape.duration > 10 ? 3 : 1
    let error = null
    try {
      const draw = EFFECTS[id].create(makeSetup(stats, shape))
      const ctx = makeStubCtx(stats)
      for (let f = 0; f < frames; f += step) {
        draw(ctx, f / frames, f)
      }
    } catch (e) {
      error = e
    }
    check(
      `${id} renders ${shape.name} without errors`,
      !error && stats.drawImage > 0,
      error ? String(error) : `${stats.drawImage} drawImage calls`,
    )
  }
}

check('EFFECT_IDS matches EFFECTS registry', EFFECT_IDS.every(id => EFFECTS[id]) && EFFECT_IDS.length === Object.keys(EFFECTS).length)
check(
  'every effect has label + description',
  EFFECT_IDS.every(id => EFFECTS[id].label && EFFECTS[id].description && typeof EFFECTS[id].beatSynced === 'boolean'),
)

// ── Determinism: a frame's output depends only on (seed, frame) ─────────────
// The seed contract (free-effects.ts EffectSetup.seed / Visualizer.tsx: "the
// live preview is exactly the motion you get in the video") holds ONLY if
// rendering frame K is independent of which frames were drawn before it — the
// preview is a free-running rAF loop (repeats/skips frames) while the recording
// sweeps 0..N-1 once. Per-frame unseeded Math.random(), or a single shared
// per-effect RNG stream, both break this. These asserts FAIL on such an engine
// and PASS once per-frame randomness is drawn from frameRng(seed, frame).

const DET_SHAPE = { name: 'det', W: 270, H: 480, duration: 6 }
const DET_N = DET_SHAPE.duration * 30 // 180 frames
const DET_PROBES = [5, 23, 37, 61, 89, 113, 149] // spread across the loop

// Render only frame `probe` into a fresh log, after first drawing `warm` frames
// through the SAME instance to advance any state it holds. `warm` ≥ 1 in every
// caller so the lazily-cached vignette gradient is already built in both runs
// (that caching is deterministic and correct; we only compare per-frame draws).
function probeLog(id, seed, probe, warm) {
  const stats = { drawImage: 0 }
  const log = []
  const draw = EFFECTS[id].create(makeSetup(stats, { ...DET_SHAPE, seed }, log))
  const ctx = makeStubCtx(stats, log)
  for (let f = 0; f < warm; f++) draw(ctx, f / DET_N, f)
  log.length = 0 // discard setup + warm-up; capture ONLY the probe frame
  draw(ctx, probe / DET_N, probe)
  return log.join('|')
}

// Full-loop fingerprint for a seed — proves the seed actually drives the motion.
function loopLog(id, seed) {
  const stats = { drawImage: 0 }
  const log = []
  const draw = EFFECTS[id].create(makeSetup(stats, { ...DET_SHAPE, seed }, log))
  const ctx = makeStubCtx(stats, log)
  for (let f = 0; f < DET_N; f++) draw(ctx, f / DET_N, f)
  return log.join('|')
}

for (const id of EFFECT_IDS) {
  // (1) History independence: each probe frame renders identically whether drawn
  //     right after warm-up frame 0 or after a full pass over the loop. This is
  //     the preview==recording guarantee.
  let historyIndependent = true
  let mismatch = ''
  for (const probe of DET_PROBES) {
    if (probeLog(id, 42, probe, 1) !== probeLog(id, 42, probe, DET_N)) {
      historyIndependent = false
      mismatch = `frame ${probe} differs after a full-loop pass`
      break
    }
  }
  check(`${id}: frame output is history-independent (preview==recording)`, historyIndependent, mismatch)

  // (2) Same seed reproduces the loop exactly; a different seed changes it (so
  //     the fix didn't accidentally freeze the randomness to a constant).
  const seedA = loopLog(id, 42)
  check(`${id}: identical seed reproduces the loop exactly`, seedA === loopLog(id, 42))
  check(`${id}: a different seed changes the loop`, seedA !== loopLog(id, 999))
}

console.log(failures === 0 ? '\nAll effects tests passed' : `\n${failures} effects test(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
