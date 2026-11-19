// ─── Mix Check — the measuring half ──────────────────────────────────────────
// Master Check (src/lib/loudness.ts) answers "how loud is it". This answers
// "what is wrong with it": where the energy sits band by band, how the low end
// behaves in the sections that carry the kick, how wide and how mono-safe each
// band is, what clipped, and how every second of the song compares with the
// seconds around it. src/lib/mix-check-findings.ts turns two or more of these
// measurements into notes.
//
// Pure and streaming on purpose. The server (src/lib/mix-check-server.ts) pipes
// ffmpeg's decoded PCM straight in, chunk by chunk, so a ten-minute WAV never
// sits in memory as samples: what is kept per analysis frame is ~240 band
// powers, a few megabytes for any song. The node suite
// (scripts/mix-check-test.mjs) feeds it synthetic mixes through the same door.
// No '@/…' imports — the suite loads this through Node's type stripping.
//
// What it deliberately is not: a beat tracker or a stem separator. "Rhythm
// sections" are found by how often the low band is struck, not by fitting a
// tempo grid, so a drum & bass or half-time mix is sectioned as readily as a
// four-on-the-floor one.

import { kWeighting, type Biquad } from './loudness.ts'

export const MIX_CHECK_ALGO = 'mix-check-v1'

/** Everything is measured at this rate; the server asks ffmpeg to resample. */
export const ANALYSIS_RATE = 44100

/** Loudness every spectrum is gained to before two mixes are compared. */
export const MATCH_LUFS = -10

const NFFT = 16384
const HOP = 8192
const ENV_SEC = 0.01          // low-band / full-band envelope resolution
const BLOCK_SEC = 0.1         // loudness sub-block (four make a 400 ms block)
const ACTIVE_FLOOR_LUFS = -50 // frames quieter than this are not "the mix"
const CORE_WINDOW_LU = 4      // the core is the rhythm within this of its upper quartile
const CLIP_LEVEL = 0.985      // |sample| at or above this, three in a row = a clipped run

/** The seven bands notes are written about. Edges in Hz. */
export const MIX_BANDS = [
  { key: 'sub', label: 'Sub', range: '30–65 Hz', lo: 30, hi: 65 },
  { key: 'punch', label: 'Kick and bass body', range: '65–120 Hz', lo: 65, hi: 120 },
  { key: 'upperBass', label: 'Upper bass', range: '120–250 Hz', lo: 120, hi: 250 },
  { key: 'lowMid', label: 'Low mids', range: '250–500 Hz', lo: 250, hi: 500 },
  { key: 'mid', label: 'Mids', range: '500 Hz–2 kHz', lo: 500, hi: 2000 },
  { key: 'presence', label: 'Upper mids', range: '2–6 kHz', lo: 2000, hi: 6000 },
  { key: 'air', label: 'Highs', range: '6–16 kHz', lo: 6000, hi: 16000 },
] as const

export type MixBandKey = (typeof MIX_BANDS)[number]['key']

/** The small part of a measurement that other mixes are compared against. It is
 *  what the catalog and the reference tracks keep — a few hundred bytes. */
export type MixSummary = {
  /** 'full' = a whole mix; 'preview' = a short lossy clip (levels only). */
  src: 'full' | 'preview'
  dur: number
  /** Seven band levels (MIX_BANDS order), dBFS at MATCH_LUFS, in the core. */
  b: number[]
  /** Third-octave spectrum of the core at MATCH_LUFS (THIRD_OCTAVE_HZ). */
  s3: number[]
  /** Stereo correlation in the core: [30–120 Hz, 120 Hz–8 kHz]. 1 = mono. */
  c: [number, number]
  /** Integrated LUFS, loudest 3 s LUFS, true peak dBTP. */
  i: number
  st: number
  tp: number
  /** Share of the song that is rhythm section, 0–1. */
  rf: number
}

export type MixSection = {
  start: number
  end: number
  kind: 'rhythm' | 'break'
  /** K-weighted loudness, and raw dBFS levels of the two low bands. */
  lufs: number
  sub: number
  punch: number
  /** Stereo correlation 30–120 Hz. */
  lowCorr: number
}

export type MixDetail = {
  /** Sixth-octave spectrum (SIXTH_OCTAVE_HZ), dBFS at MATCH_LUFS: core + whole song. */
  core: number[]
  full: number[]
  /** Per-second lines, one value a second, raw dBFS (not loudness-matched). */
  timeline: { lufs: number[]; sub: number[]; punch: number[]; lowCorr: number[]; wideCorr: number[]; rhythm: number[] }
  sections: MixSection[]
  /** Narrow peaks standing out of the core spectrum between 1.5 and 10 kHz. */
  resonances: { hz: number; db: number }[]
  /** Runs of three or more samples at full scale: how many, and where the first few are. */
  clips: { runs: number; at: number[] }
  /** Sudden holes in the audio (seconds), and whether the file ends mid-sound. */
  dropouts: number[]
  cutOff: boolean
  /** Level difference left minus right (dB) and DC offset per channel (dBFS). */
  balanceDb: number
  dcDb: [number, number]
  samplePeakDb: number
  /** False when no rhythm section was found and the core is just the loudest part. */
  hasRhythm: boolean
}

export type MixMeasurement = { algo: string; summary: MixSummary; detail: MixDetail }

// ── Band grids ───────────────────────────────────────────────────────────────

const T12_LO = -67 // 1000·2^(-67/12) ≈ 20.9 Hz
const T12_HI = 51  // ≈ 19.0 kHz
const N12 = T12_HI - T12_LO + 1
const centre12 = (i: number) => 1000 * Math.pow(2, (i + T12_LO) / 12)

/** Centres of the sixth-octave spectrum in MixDetail. */
export const SIXTH_OCTAVE_HZ: number[] = (() => {
  const out: number[] = []
  for (let k = -33; k <= 25; k++) out.push(1000 * Math.pow(2, k / 6))
  return out
})()

/** Centres of the third-octave spectrum in MixSummary (25 Hz – 16 kHz). */
export const THIRD_OCTAVE_HZ: number[] = (() => {
  const out: number[] = []
  for (let m = -16; m <= 12; m++) out.push(1000 * Math.pow(2, m / 3))
  return out
})()

const db10 = (x: number) => (x > 1e-20 ? 10 * Math.log10(x) : -200)
const round1 = (x: number) => Math.round(x * 10) / 10
const clampDb = (x: number) => (x < -120 ? -120 : round1(x))

// ── FFT (radix-2, in place) ──────────────────────────────────────────────────

export function makeFft(n: number) {
  const bits = Math.log2(n)
  const rev = new Uint32Array(n)
  for (let i = 0; i < n; i++) {
    let r = 0
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
    rev[i] = r
  }
  const cos = new Float64Array(n / 2)
  const sin = new Float64Array(n / 2)
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n)
    sin[i] = -Math.sin((2 * Math.PI * i) / n)
  }
  return (re: Float64Array, im: Float64Array) => {
    for (let i = 0; i < n; i++) {
      const j = rev[i]
      if (j > i) {
        const tr = re[i]; re[i] = re[j]; re[j] = tr
        const ti = im[i]; im[i] = im[j]; im[j] = ti
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1
      const step = n / size
      for (let start = 0; start < n; start += size) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const wr = cos[t], wi = sin[t]
          const a = start + k, b = a + half
          const xr = re[b] * wr - im[b] * wi
          const xi = re[b] * wi + im[b] * wr
          re[b] = re[a] - xr; im[b] = im[a] - xi
          re[a] += xr; im[a] += xi
        }
      }
    }
  }
}

function biquadGain(c: Biquad, f: number, sr: number): number {
  const w = (2 * Math.PI * f) / sr
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w)
  const nr = c.b0 + c.b1 * c1 + c.b2 * c2, ni = -(c.b1 * s1 + c.b2 * s2)
  const dr = 1 + c.a1 * c1 + c.a2 * c2, di = -(c.a1 * s1 + c.a2 * s2)
  return (nr * nr + ni * ni) / (dr * dr + di * di)
}

// ── The analyser ─────────────────────────────────────────────────────────────

export type MixAnalyzer = {
  /** Feed the next stretch of audio. Both arrays the same length, samples in [-1, 1]. */
  push(left: Float32Array, right: Float32Array): void
  /** Everything measured so far, as a finished measurement. */
  finish(source?: 'full' | 'preview'): MixMeasurement
}

export function createMixAnalyzer(sampleRate: number = ANALYSIS_RATE): MixAnalyzer {
  if (!Number.isFinite(sampleRate) || sampleRate < 22050) throw new Error(`Unsupported sample rate: ${sampleRate}`)
  const sr = sampleRate
  const fft = makeFft(NFFT)
  const win = new Float64Array(NFFT)
  let winSq = 0
  for (let i = 0; i < NFFT; i++) {
    win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / NFFT)
    winSq += win[i] * win[i]
  }
  const powerScale = 2 / (NFFT * winSq) // one-sided |X|² → mean square
  const bins = NFFT / 2
  const df = sr / NFFT

  // Each FFT bin is spread over the twelfth-octave bands it overlaps, so a band
  // narrower than one bin (everything under ~45 Hz) still gets its fair share.
  const binBand: Int32Array[] = []
  const binWeight: Float32Array[] = []
  for (let k = 1; k < bins; k++) {
    const lo = (k - 0.5) * df, hi = (k + 0.5) * df
    const bands: number[] = [], weights: number[] = []
    const first = Math.max(0, Math.floor(12 * Math.log2(lo / 1000) + 0.5) - T12_LO)
    for (let i = first; i < N12; i++) {
      const bl = centre12(i) * Math.pow(2, -1 / 24), bh = centre12(i) * Math.pow(2, 1 / 24)
      if (bl >= hi) break
      const overlap = Math.min(hi, bh) - Math.max(lo, bl)
      if (overlap > 0) { bands.push(i); weights.push(overlap / df) }
    }
    binBand.push(Int32Array.from(bands))
    binWeight.push(Float32Array.from(weights))
  }
  const kw = kWeighting(sr)
  const kGain = new Float64Array(bins)
  for (let k = 1; k < bins; k++) kGain[k] = biquadGain(kw.shelf, k * df, sr) * biquadGain(kw.highpass, k * df, sr)

  // Frame buffers.
  const bufL = new Float32Array(NFFT), bufR = new Float32Array(NFFT)
  let fill = 0
  const reL = new Float64Array(NFFT), imL = new Float64Array(NFFT)
  const reR = new Float64Array(NFFT), imR = new Float64Array(NFFT)
  const frameT: Float32Array[] = []   // per frame: band power, mean of both channels
  const frameC: Float32Array[] = []   // per frame: band cross power (mid − side)
  const frameK: number[] = []         // per frame: K-weighted power, channels summed

  // Per-sample running state.
  let total = 0
  let peak = 0, truePeak = 0
  let sumL = 0, sumR = 0, sqL = 0, sqR = 0
  let clipRun = 0, clipRuns = 0
  const clipAt: number[] = []
  const envN = Math.max(1, Math.round(ENV_SEC * sr))
  let envCount = 0, envLow = 0, envFull = 0
  const lowEnv: number[] = [], fullEnv: number[] = []
  const lp = Math.exp((-2 * Math.PI * 150) / sr)
  let lp1 = 0, lp2 = 0
  // The low band itself, every 16th sample (~2.8 kHz): what a kick's body looks
  // like, kept so hits can be compared with one another. ~3 MB for ten minutes.
  const LOW_STEP = 16
  const lowRate = sr / LOW_STEP
  let lowChunk = new Float32Array(1 << 16), lowFill = 0
  const lowChunks: Float32Array[] = []
  const blockN = Math.max(1, Math.round(BLOCK_SEC * sr))
  let blockCount = 0, blockSum = 0
  const blocks: number[] = []
  const ks = [0, 0, 0, 0, 0, 0, 0, 0] // shelf x1 x2 y1 y2, highpass x1 x2 y1 y2 — left
  const kr = [0, 0, 0, 0, 0, 0, 0, 0] // …right
  const { shelf, highpass } = kw
  // Four-times oversampling for the true peak, only near loud samples: three
  // points between each pair, from a 12-tap windowed sinc.
  const TAPS = 12
  const phases: Float64Array[] = [0.25, 0.5, 0.75].map(frac => {
    const h = new Float64Array(TAPS)
    let sum = 0
    for (let t = 0; t < TAPS; t++) {
      const x = t - (TAPS / 2 - 1) - frac
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
      const w = 0.5 + 0.5 * Math.cos((Math.PI * x) / (TAPS / 2))
      h[t] = sinc * w
      sum += h[t]
    }
    for (let t = 0; t < TAPS; t++) h[t] /= sum
    return h
  })
  const histL = new Float32Array(TAPS), histR = new Float32Array(TAPS)

  function kFilter(x: number, s: number[]): number {
    const y = shelf.b0 * x + shelf.b1 * s[0] + shelf.b2 * s[1] - shelf.a1 * s[2] - shelf.a2 * s[3]
    s[1] = s[0]; s[0] = x; s[3] = s[2]; s[2] = y
    const z = highpass.b0 * y + highpass.b1 * s[4] + highpass.b2 * s[5] - highpass.a1 * s[6] - highpass.a2 * s[7]
    s[5] = s[4]; s[4] = y; s[7] = s[6]; s[6] = z
    return z
  }

  function analyseFrame() {
    for (let i = 0; i < NFFT; i++) {
      reL[i] = bufL[i] * win[i]; imL[i] = 0
      reR[i] = bufR[i] * win[i]; imR[i] = 0
    }
    fft(reL, imL)
    fft(reR, imR)
    const t = new Float32Array(N12), c = new Float32Array(N12)
    let k = 0
    for (let b = 1; b < bins; b++) {
      const pl = reL[b] * reL[b] + imL[b] * imL[b]
      const pr = reR[b] * reR[b] + imR[b] * imR[b]
      const cross = reL[b] * reR[b] + imL[b] * imR[b]
      const both = (pl + pr) * powerScale
      k += both * kGain[b]
      const mean = both / 2, x = cross * powerScale
      const bands = binBand[b - 1], weights = binWeight[b - 1]
      for (let j = 0; j < bands.length; j++) {
        t[bands[j]] += mean * weights[j]
        c[bands[j]] += x * weights[j]
      }
    }
    frameT.push(t); frameC.push(c); frameK.push(k)
  }

  function push(left: Float32Array, right: Float32Array) {
    const n = Math.min(left.length, right.length)
    for (let i = 0; i < n; i++) {
      const l = left[i], r = right[i]
      const al = l < 0 ? -l : l, ar = r < 0 ? -r : r
      const a = al > ar ? al : ar
      if (a > peak) peak = a
      sumL += l; sumR += r; sqL += l * l; sqR += r * r

      if (a >= CLIP_LEVEL) {
        clipRun++
        if (clipRun === 3) {
          clipRuns++
          if (clipAt.length < 8) clipAt.push(total / sr)
        }
      } else clipRun = 0

      // True peak: slide the history, interpolate only where it could matter.
      histL.copyWithin(0, 1); histL[TAPS - 1] = l
      histR.copyWithin(0, 1); histR[TAPS - 1] = r
      if (a > truePeak) truePeak = a
      if (a >= 0.5) {
        for (const h of phases) {
          let yl = 0, yr = 0
          for (let t = 0; t < TAPS; t++) { yl += h[t] * histL[t]; yr += h[t] * histR[t] }
          const m = Math.max(Math.abs(yl), Math.abs(yr))
          if (m > truePeak) truePeak = m
        }
      }

      // Envelopes: the low band (two cascaded one-poles at 150 Hz) and everything.
      const mono = (l + r) / 2
      lp1 = lp * lp1 + (1 - lp) * mono
      lp2 = lp * lp2 + (1 - lp) * lp1
      if (total % LOW_STEP === 0) {
        lowChunk[lowFill++] = lp2
        if (lowFill === lowChunk.length) { lowChunks.push(lowChunk); lowChunk = new Float32Array(1 << 16); lowFill = 0 }
      }
      envLow += lp2 * lp2
      envFull += mono * mono
      if (++envCount === envN) {
        lowEnv.push(envLow / envN); fullEnv.push(envFull / envN)
        envCount = 0; envLow = 0; envFull = 0
      }

      // BS.1770 loudness sub-blocks.
      const kl = kFilter(l, ks), krr = kFilter(r, kr)
      blockSum += kl * kl + krr * krr
      if (++blockCount === blockN) {
        blocks.push(blockSum / blockN)
        blockCount = 0; blockSum = 0
      }

      bufL[fill] = l; bufR[fill] = r
      if (++fill === NFFT) {
        analyseFrame()
        bufL.copyWithin(0, HOP); bufR.copyWithin(0, HOP)
        fill = NFFT - HOP
      }
      total++
    }
  }

  function finish(source: 'full' | 'preview' = 'full'): MixMeasurement {
    const duration = total / sr
    const frames = frameT.length
    const frameTime = (i: number) => (i * HOP + NFFT / 2) / sr
    const frameLufs = frameK.map(k => -0.691 + db10(k))

    // ── Loudness (400 ms blocks at 100 ms hop, both gates) ──────────────────
    const blocks400: number[] = []
    for (let i = 0; i + 4 <= blocks.length; i++) blocks400.push((blocks[i] + blocks[i + 1] + blocks[i + 2] + blocks[i + 3]) / 4)
    if (!blocks400.length && blocks.length) blocks400.push(blocks.reduce((a, b) => a + b, 0) / blocks.length)
    const lufsOf = (ms: number) => -0.691 + db10(ms)
    let integrated = -Infinity
    const abs = blocks400.filter(ms => lufsOf(ms) > -70)
    if (abs.length) {
      const gate = lufsOf(abs.reduce((a, b) => a + b, 0) / abs.length) - 10
      const rel = abs.filter(ms => lufsOf(ms) > gate)
      if (rel.length) integrated = lufsOf(rel.reduce((a, b) => a + b, 0) / rel.length)
    }
    let shortMax = -Infinity
    for (let i = 0; i + 30 <= blocks.length; i += 5) {
      let s = 0
      for (let j = 0; j < 30; j++) s += blocks[i + j]
      shortMax = Math.max(shortMax, lufsOf(s / 30))
    }
    if (!Number.isFinite(shortMax) && blocks.length) shortMax = lufsOf(blocks.reduce((a, b) => a + b, 0) / blocks.length)

    // ── Rhythm sections: where the song's kick is playing ───────────────────
    // Candidates are the fast rises of the low band. But a bass note, a pad
    // swelling, or two detuned subs beating against each other rise too, so a
    // candidate only counts when it LOOKS like the song's kick: the strongest
    // hits are lined up and averaged into a template, and every candidate is
    // then matched against it (shape and size). Nothing is fitted to a tempo,
    // so broken beats section as readily as four-on-the-floor.
    const m = lowEnv.length
    const flux = new Float32Array(m)
    {
      let prev = Math.sqrt(lowEnv[0] ?? 0)
      for (let i = 1; i < m; i++) { const a = Math.sqrt(lowEnv[i]); flux[i] = Math.max(0, a - prev); prev = a }
    }
    const candAt: number[] = [], candVal: number[] = []
    for (let i = 1; i < m - 1; i++) {
      const v = flux[i]
      if (v <= 0) continue
      let top = true
      for (let j = Math.max(0, i - 8); j <= Math.min(m - 1, i + 8) && top; j++) if (flux[j] > v) top = false
      if (top) { candAt.push(i); candVal.push(v) }
    }
    const low = new Float32Array(lowChunks.length * (1 << 16) + lowFill)
    lowChunks.forEach((c, i) => low.set(c, i * (1 << 16)))
    low.set(lowChunk.subarray(0, lowFill), lowChunks.length * (1 << 16))
    const PRE = Math.round(0.03 * lowRate), POST = Math.round(0.11 * lowRate), SEARCH = Math.round(0.025 * lowRate)
    const LEN = PRE + POST
    const centreOf = (envIndex: number) => Math.round(((envIndex + 0.5) * ENV_SEC) * lowRate)
    const usable = (c: number) => c - PRE - SEARCH >= 0 && c + POST + SEARCH < low.length
    // Best normalised match of `tmpl` inside the candidate's search window.
    const match = (c: number, tmpl: Float32Array, tmplNorm: number) => {
      let best = -2, bestLag = 0, bestDot = 0
      for (let lag = -SEARCH; lag <= SEARCH; lag++) {
        let dot = 0, sq = 0
        const o = c + lag - PRE
        for (let i = 0; i < LEN; i++) { const v = low[o + i]; dot += v * tmpl[i]; sq += v * v }
        const r = sq > 1e-20 ? dot / (Math.sqrt(sq) * tmplNorm) : 0
        if (r > best) { best = r; bestLag = lag; bestDot = dot }
      }
      return { corr: best, lag: bestLag, gain: bestDot / (tmplNorm * tmplNorm) }
    }
    const onsetSec = new Float32Array(Math.ceil(duration) + 1)
    {
      const order = candAt.map((_, i) => i).filter(i => usable(centreOf(candAt[i]))).sort((a, b) => candVal[b] - candVal[a])
      const strong = order.slice(0, Math.max(12, Math.floor(order.length * 0.15)))
      if (strong.length >= 8) {
        const seg = (c: number) => low.slice(c - PRE, c + POST)
        const norm = (v: Float32Array) => { let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i]; return Math.sqrt(s) + 1e-12 }
        // Seed: the hit the most other hits resemble. Not the strongest — a
        // sub note coming in out of silence rises harder than any kick — but
        // the most REPEATED: a kick is the same sample hundreds of times.
        const gate = candVal[strong[strong.length - 1]] * 0.3
        const loud = order.filter(i => candVal[i] >= gate).sort((x, y) => candAt[x] - candAt[y])
        const pick = Math.min(60, loud.length)
        const seeds: number[] = []
        for (let k = 0; k < pick; k++) seeds.push(centreOf(candAt[loud[Math.floor((k + 0.5) * loud.length / pick)]]))
        let seed = seg(seeds[0]), seedScore = -1
        for (const a of seeds) {
          const t = seg(a), tn = norm(t)
          let alike = 0
          for (const b of seeds) if (match(b, t, tn).corr >= 0.6) alike++
          if (alike > seedScore) { seedScore = alike; seed = t }
        }
        let tmpl = seed
        for (let pass = 0; pass < 2; pass++) {
          const tn = norm(tmpl)
          const aligned: Float32Array[] = []
          for (const i of loud) {
            if (aligned.length >= 200) break
            const c = centreOf(candAt[i])
            const r = match(c, tmpl, tn)
            if (r.corr > 0.6) aligned.push(seg(c + r.lag))
          }
          if (aligned.length < 6) break
          const next = new Float32Array(LEN)
          const column = new Float32Array(aligned.length)
          for (let i = 0; i < LEN; i++) {
            for (let j = 0; j < aligned.length; j++) column[j] = aligned[j][i]
            column.sort()
            next[i] = column[Math.floor(aligned.length / 2)]
          }
          tmpl = next
        }
        const tn = norm(tmpl)
        for (const i of order) {
          const r = match(centreOf(candAt[i]), tmpl, tn)
          if (r.corr >= 0.7 && r.gain >= 0.35) onsetSec[Math.min(onsetSec.length - 1, Math.floor(candAt[i] * ENV_SEC))]++
        }
      }
    }
    const seconds = Math.max(1, Math.floor(duration))
    const rhythmSec = new Uint8Array(seconds)
    for (let s = 0; s < seconds; s++) {
      let count = 0, span = 0
      for (let j = s - 2; j <= s + 1; j++) if (j >= 0 && j < seconds) { count += onsetSec[j]; span++ }
      rhythmSec[s] = span > 0 && count / span >= 0.8 ? 1 : 0
    }
    smoothMask(rhythmSec, 3, 8)

    // ── Masks over frames ───────────────────────────────────────────────────
    const active = frameLufs.map(l => l > ACTIVE_FLOOR_LUFS)
    const rhythmFrame = frameLufs.map((_, i) => rhythmSec[Math.min(seconds - 1, Math.floor(frameTime(i)))] === 1)
    const smooth = frameLufs.map((_, i) => {
      let s = 0, c = 0
      for (let j = Math.max(0, i - 8); j <= Math.min(frames - 1, i + 8); j++) { s += frameK[j]; c++ }
      return -0.691 + db10(s / Math.max(1, c))
    })
    const rhythmSeconds = rhythmSec.reduce((a, b) => a + b, 0)
    const hasRhythm = rhythmSeconds >= 12
    const pool = (i: number) => active[i] && (!hasRhythm || rhythmFrame[i])
    // The core: the pool's fuller part. Measured from its upper quartile down,
    // not from its single loudest moment, so one loud fill cannot move it — a
    // kick-and-hats intro falls out, every full section stays in.
    const levels: number[] = []
    for (let i = 0; i < frames; i++) if (pool(i)) levels.push(smooth[i])
    levels.sort((a, b) => a - b)
    const upper = levels.length ? levels[Math.floor(levels.length * 0.75)] : -Infinity
    const core = frameLufs.map((_, i) => pool(i) && smooth[i] >= upper - CORE_WINDOW_LU)

    const meanOver = (mask: boolean[]) => {
      const t = new Float64Array(N12), c = new Float64Array(N12)
      let k = 0, count = 0
      for (let i = 0; i < frames; i++) {
        if (!mask[i]) continue
        const ft = frameT[i], fc = frameC[i]
        for (let b = 0; b < N12; b++) { t[b] += ft[b]; c[b] += fc[b] }
        k += frameK[i]; count++
      }
      if (count) { for (let b = 0; b < N12; b++) { t[b] /= count; c[b] /= count } k /= count }
      return { t, c, gain: count ? MATCH_LUFS - (-0.691 + db10(k)) : 0, count }
    }
    const coreMean = meanOver(core)
    const fullMean = meanOver(active)

    const bandSum = (v: Float64Array | Float32Array, lo: number, hi: number) => {
      let s = 0
      for (let b = 0; b < N12; b++) { const f = centre12(b); if (f >= lo && f < hi) s += v[b] }
      return s
    }
    const corrOf = (mean: { t: Float64Array; c: Float64Array }, lo: number, hi: number) => {
      const t = bandSum(mean.t, lo, hi)
      return t > 1e-18 ? Math.max(-1, Math.min(1, bandSum(mean.c, lo, hi) / t)) : 1
    }
    const sixth = (mean: { t: Float64Array; gain: number }) => SIXTH_OCTAVE_HZ.map((_, i) => {
      // sixth-octave band i sits on twelfth-octave index 2i+1 (k = -33 → 12ths -66), half of each neighbour
      const c = 2 * (i - 33) - T12_LO
      const s = (mean.t[c - 1] ?? 0) * 0.5 + (mean.t[c] ?? 0) + (mean.t[c + 1] ?? 0) * 0.5
      return clampDb(db10(s) + mean.gain)
    })
    const third = (mean: { t: Float64Array; gain: number }) => THIRD_OCTAVE_HZ.map((_, i) => {
      const c = 4 * (i - 16) - T12_LO
      const s = (mean.t[c - 2] ?? 0) * 0.5 + (mean.t[c - 1] ?? 0) + (mean.t[c] ?? 0) + (mean.t[c + 1] ?? 0) + (mean.t[c + 2] ?? 0) * 0.5
      return clampDb(db10(s) + mean.gain)
    })

    // ── Per-second lines and sections ───────────────────────────────────────
    const line = (fn: (t: Float64Array, c: Float64Array) => number) => {
      const out: number[] = []
      for (let s = 0; s < seconds; s++) {
        const t = new Float64Array(N12), c = new Float64Array(N12)
        let count = 0
        for (let i = 0; i < frames; i++) {
          const ft = frameTime(i)
          if (ft < s || ft >= s + 1) continue
          for (let b = 0; b < N12; b++) { t[b] += frameT[i][b]; c[b] += frameC[i][b] }
          count++
        }
        if (count) for (let b = 0; b < N12; b++) { t[b] /= count; c[b] /= count }
        out.push(count ? fn(t, c) : -120)
      }
      return out
    }
    const ratio = (c: Float64Array, t: Float64Array, lo: number, hi: number) => {
      const tt = bandSum(t, lo, hi)
      return tt > 1e-14 ? Math.round(Math.max(-1, Math.min(1, bandSum(c, lo, hi) / tt)) * 100) / 100 : 1
    }
    const lufsLine: number[] = []
    for (let s = 0; s < seconds; s++) {
      let k = 0, count = 0
      for (let i = 0; i < frames; i++) { const ft = frameTime(i); if (ft >= s && ft < s + 1) { k += frameK[i]; count++ } }
      lufsLine.push(count ? clampDb(-0.691 + db10(k / count)) : -120)
    }
    const subLine = line(t => clampDb(db10(bandSum(t, 30, 65))))
    const punchLine = line(t => clampDb(db10(bandSum(t, 65, 120))))
    const lowCorrLine = line((t, c) => ratio(c, t, 30, 120))
    const lowPower = line(t => bandSum(t, 30, 120)), lowCross = line((_, c) => bandSum(c, 30, 120))
    const wideCorrLine = line((t, c) => ratio(c, t, 120, 8000))

    const sections: MixSection[] = []
    const powMean = (v: number[], a: number, b: number) => {
      let s = 0, n = 0
      for (let i = a; i < b; i++) if (v[i] > -119) { s += Math.pow(10, v[i] / 10); n++ }
      return n ? clampDb(db10(s / n)) : -120
    }
    for (let s = 0; s < seconds;) {
      let e = s
      while (e < seconds && rhythmSec[e] === rhythmSec[s]) e++
      // Weighted by power, so the seconds that carry the low end decide it.
      let lt = 0, lx = 0
      for (let i = s; i < e; i++) if (lowPower[i] > 0) { lt += lowPower[i]; lx += lowCross[i] }
      sections.push({
        start: s, end: e, kind: rhythmSec[s] ? 'rhythm' : 'break',
        lufs: powMean(lufsLine, s, e), sub: powMean(subLine, s, e), punch: powMean(punchLine, s, e),
        lowCorr: lt > 1e-14 ? Math.round(Math.max(-1, Math.min(1, lx / lt)) * 100) / 100 : 1,
      })
      s = e
    }

    // ── Narrow peaks in the upper mids ──────────────────────────────────────
    const resonances: { hz: number; db: number }[] = []
    const coreDb = Array.from(coreMean.t, db10)
    for (let b = 5; b < N12 - 5; b++) {
      const f = centre12(b)
      if (f < 1500 || f > 10000) continue
      const around = (coreDb[b - 5] + coreDb[b - 4] + coreDb[b - 3] + coreDb[b + 3] + coreDb[b + 4] + coreDb[b + 5]) / 6
      const rise = coreDb[b] - around
      if (rise >= 6 && coreDb[b] >= coreDb[b - 1] && coreDb[b] >= coreDb[b + 1]) resonances.push({ hz: Math.round(f), db: round1(rise) })
    }

    // ── Holes and a cut-off ending ──────────────────────────────────────────
    const dropouts: number[] = []
    const fullDb = fullEnv.map(db10)
    for (let i = 20; i < fullDb.length - 20; i++) {
      if (fullDb[i] > -70 || fullDb[i - 1] <= -70) continue
      let end = i
      while (end < fullDb.length && fullDb[end] <= -70) end++
      const len = end - i
      if (len >= 2 && len <= 40 && end + 10 < fullDb.length) {
        const before = Math.max(...fullDb.slice(Math.max(0, i - 10), i))
        const after = Math.max(...fullDb.slice(end, end + 10))
        if (before > -30 && after > -30 && dropouts.length < 8) dropouts.push(round1(i * ENV_SEC))
      }
      i = end
    }
    const tail = fullDb.slice(-3)
    const cutOff = source === 'full' && tail.length === 3 && Math.max(...tail) > -45

    const rms = (sq: number) => (total ? 10 * Math.log10(Math.max(sq / total, 1e-20)) : -200)
    const dc = (sum: number) => (total ? 20 * Math.log10(Math.max(Math.abs(sum / total), 1e-10)) : -200)
    const toDb = (x: number) => (x > 0 ? round1(20 * Math.log10(x)) : -120)

    const summary: MixSummary = {
      src: source,
      dur: Math.round(duration),
      b: MIX_BANDS.map(band => clampDb(db10(bandSum(coreMean.t, band.lo, band.hi)) + coreMean.gain)),
      s3: third(coreMean),
      c: [Math.round(corrOf(coreMean, 30, 120) * 100) / 100, Math.round(corrOf(coreMean, 120, 8000) * 100) / 100],
      i: Number.isFinite(integrated) ? round1(integrated) : -120,
      st: Number.isFinite(shortMax) ? round1(shortMax) : -120,
      tp: toDb(truePeak),
      rf: Math.round((rhythmSeconds / seconds) * 100) / 100,
    }
    const detail: MixDetail = {
      core: sixth(coreMean),
      full: sixth(fullMean),
      timeline: { lufs: lufsLine, sub: subLine, punch: punchLine, lowCorr: lowCorrLine, wideCorr: wideCorrLine, rhythm: Array.from(rhythmSec) },
      sections,
      resonances: resonances.sort((a, b) => b.db - a.db).slice(0, 4),
      clips: { runs: clipRuns, at: clipAt.map(round1) },
      dropouts,
      cutOff,
      balanceDb: round1(rms(sqL) - rms(sqR)),
      dcDb: [round1(dc(sumL)), round1(dc(sumR))],
      samplePeakDb: toDb(peak),
      hasRhythm,
    }
    return { algo: MIX_CHECK_ALGO, summary, detail }
  }

  return { push, finish }
}

/** Close gaps shorter than `gap` seconds, then drop runs shorter than `minRun`. */
function smoothMask(mask: Uint8Array, gap: number, minRun: number) {
  const n = mask.length
  for (const [value, limit] of [[0, gap], [1, minRun]] as const) {
    for (let i = 0; i < n;) {
      if (mask[i] !== value) { i++; continue }
      let e = i
      while (e < n && mask[e] === value) e++
      // A gap is only closed between two runs; a run is dropped wherever it is.
      const inside = value === 1 || (i > 0 && e < n)
      if (inside && e - i < limit) for (let j = i; j < e; j++) mask[j] = value ? 0 : 1
      i = e
    }
  }
}

/**
 * The three numbers Master Check shows (integrated loudness, loudest 3 s,
 * sample peak), out of a mix measurement — so one check of a mix gives both.
 * In the shape POST /api/versions/<id>/loudness takes; a level that was not
 * measurable (silence) is null, as it is there.
 *
 * Measured from the 44.1 kHz stereo decode, so on a 48 kHz file the sample
 * peak can sit a tenth or two from the browser's reading of the same file.
 */
export function loudnessOf(m: { summary: MixSummary; detail: Pick<MixDetail, 'samplePeakDb'> }) {
  const level = (x: number) => (typeof x === 'number' && Number.isFinite(x) && x > -120 ? x : null)
  return {
    integratedLufs: level(m.summary.i),
    shortTermMaxLufs: level(m.summary.st),
    samplePeakDb: level(m.detail.samplePeakDb),
    gatedBlockCount: null,
  }
}

/** True for a value that has the shape of a stored MixSummary. */
export function isMixSummary(v: unknown): v is MixSummary {
  if (!v || typeof v !== 'object') return false
  const s = v as Record<string, unknown>
  return Array.isArray(s.b) && s.b.length === MIX_BANDS.length && s.b.every(x => typeof x === 'number')
    && Array.isArray(s.s3) && s.s3.length === THIRD_OCTAVE_HZ.length
    && Array.isArray(s.c) && s.c.length === 2
    && typeof s.i === 'number' && typeof s.tp === 'number'
    && (s.src === 'full' || s.src === 'preview')
}
