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

function makeStubCtx(stats) {
  const fn = (method) => (...args) => {
    for (const a of args) {
      if (typeof a === 'number' && !Number.isFinite(a)) {
        throw new Error(`${method} received non-finite number: ${args.join(', ')}`)
      }
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

function makeSetup(stats, { W, H, duration, bpm = 122, seed = 42 }) {
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
    createLayer: (w, h) => ({ canvas: { width: w, height: h }, ctx: makeStubCtx(stats) }),
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

console.log(failures === 0 ? '\nAll effects tests passed' : `\n${failures} effects test(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
