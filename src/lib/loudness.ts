// ─── Loudness / master-readiness measurement (ITU-R BS.1770-4) ───────────────
// mixBASE is a mix-versioning app, and until this module it had never measured
// a mix: `mastering_done` was a self-reported checkbox, and the two questions a
// self-releasing musician actually asks before a drop — "will Spotify turn this
// down?" and "is v4 better or just louder?" — had no answer in the app.
//
// This is a faithful implementation of the integrated-loudness algorithm every
// DSP's normalizer is based on: K-weighting (a high-shelf then a high-pass
// biquad), 400 ms blocks at 75 % overlap, an absolute −70 LUFS gate, then a
// relative −10 LU gate. Deliberately pure and dependency-free — it takes plain
// channel arrays, so the browser feeds it AudioBuffer.getChannelData() and the
// node test feeds it ffmpeg-decoded PCM, and `scripts/loudness-test.mjs`
// cross-checks it against ffmpeg's own `ebur128` filter as an independent
// oracle.
//
// v1 scope, on purpose: sample peak (labelled honestly — NOT oversampled true
// peak) and no loudness range. Those are follow-ons; the value here is the
// integrated number attached to the version history and the release gate.

export type LoudnessMeasurement = {
  /** Gated integrated loudness (LUFS). -Infinity when nothing survives the gates. */
  integratedLufs: number
  /** Loudest 3-second window (LUFS, ungated) — how hot the hottest section runs. */
  shortTermMaxLufs: number
  /** Max |sample| in dBFS. Sample peak, not oversampled true peak. */
  samplePeakDb: number
  /** 400 ms blocks that survived both gates — a sanity signal for the caller. */
  gatedBlockCount: number
}

export type LoudnessIssue = { level: 'error' | 'warning' | 'info'; message: string }

/** What the major DSPs normalize playback to. The deltas against these answer
 *  "what will happen to my track on each platform". */
export const DSP_TARGETS: ReadonlyArray<{ name: string; lufs: number }> = [
  { name: 'Spotify', lufs: -14 },
  { name: 'YouTube', lufs: -14 },
  { name: 'Tidal', lufs: -14 },
  { name: 'Apple Music', lufs: -16 },
]

const ABSOLUTE_GATE_LUFS = -70
const RELATIVE_GATE_LU = -10
// The −0.691 offset calibrates a 997 Hz full-scale sine per the spec.
const LOUDNESS_OFFSET = -0.691
const BLOCK_SEC = 0.4
const BLOCK_HOP_SEC = 0.1 // 75 % overlap
const SHORT_TERM_SEC = 3
const SHORT_TERM_HOP_SEC = 1

type Biquad = { b0: number; b1: number; b2: number; a1: number; a2: number }

// K-weighting filter stages. BS.1770 only tabulates coefficients for 48 kHz;
// this is the exact per-sample-rate design libebur128 (the reference
// implementation) uses — bilinear transform with K = tan(π·f0/fs) prewarping
// and the reverse-engineered analog parameters. Verified to reproduce the
// spec's published 48 kHz table to 11 decimal places, so 44.1 kHz uploads get
// the correct curve instead of a mis-tuned copy of the 48 k table.
function kWeighting(sampleRate: number): { shelf: Biquad; highpass: Biquad } {
  // Stage 1: high-shelf (+~4 dB above ~1.5 kHz — head-related energy boost).
  const shelf = (() => {
    const f0 = 1681.974450955533
    const gainDb = 3.999843853973347
    const q = 0.7071752369554196
    const k = Math.tan((Math.PI * f0) / sampleRate)
    const vh = Math.pow(10, gainDb / 20)
    const vb = Math.pow(vh, 0.4996667741545416)
    const a0 = 1 + k / q + k * k
    return {
      b0: (vh + (vb * k) / q + k * k) / a0,
      b1: (2 * (k * k - vh)) / a0,
      b2: (vh - (vb * k) / q + k * k) / a0,
      a1: (2 * (k * k - 1)) / a0,
      a2: (1 - k / q + k * k) / a0,
    }
  })()
  // Stage 2: high-pass (~38 Hz — the RLB weighting curve). The spec's own
  // table keeps the numerator unnormalized at [1, −2, 1]; so do we.
  const highpass = (() => {
    const f0 = 38.13547087602444
    const q = 0.5003270373238773
    const k = Math.tan((Math.PI * f0) / sampleRate)
    const a0 = 1 + k / q + k * k
    return {
      b0: 1,
      b1: -2,
      b2: 1,
      a1: (2 * (k * k - 1)) / a0,
      a2: (1 - k / q + k * k) / a0,
    }
  })()
  return { shelf, highpass }
}

// Direct Form I, zero initial state — the standard assumes silence before t=0.
//
// `out` may alias `input`: x0 is read out of the input BEFORE the store, and the
// recurrence only ever consults x1/x2/y1/y2, which are already-saved scalars —
// never a re-read of a neighbouring cell. That lets the caller filter in place
// and reuse one scratch buffer for the whole K-weighting chain instead of
// allocating a fresh Float64Array per stage per channel. On a 10-minute stereo
// mix that is ~200 MB less peak memory, with bit-identical output.
function applyBiquad(c: Biquad, input: ArrayLike<number>, out: Float64Array): Float64Array {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i]
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2
    out[i] = y0
    x2 = x1; x1 = x0
    y2 = y1; y1 = y0
  }
  return out
}

/**
 * Peak heap the measurement will need, in bytes, for an already-decoded signal.
 *
 * Derived from what `measureLoudness` actually holds live at its worst moment
 * (the last channel): one retained `prefix` Float64Array per channel already
 * processed, plus the shared scratch buffer, plus the prefix being built, plus
 * the decoded Float32 audio the caller is still holding.
 *
 *   bytes ≈ n × (8 × channels  [prefixes]
 *              + 8             [shared filter scratch]
 *              + 4 × channels) [decoded Float32 the caller holds]
 *
 * This is the number the UI gate must use. The gate it replaced guessed from the
 * *upload size* on the assumption that decoding costs ~4× the file — the real
 * figure is ~10×, and it scales with duration × sample rate, not file bytes, so
 * a small lossy file was just as dangerous as a big WAV. Measured on a 10-minute
 * 44.1 kHz stereo mix: ~1.0 GB peak against a 101 MB source.
 */
export function estimateMeasurePeakBytes(samplesPerChannel: number, channelCount: number): number {
  return samplesPerChannel * (8 * channelCount + 8 + 4 * channelCount)
}

/**
 * Budget for an in-browser measurement. Mobile Safari terminates a tab well
 * before a desktop browser would blink, and this runs on phones — so the cap is
 * set for the phone, not the laptop. ~600 MB allows roughly 7 minutes of 44.1 kHz
 * stereo; longer mixes get an honest refusal instead of a killed tab.
 */
export const MAX_MEASURE_PEAK_BYTES = 600 * 1024 * 1024

/**
 * Can this decoded signal be measured in the browser without risking the tab?
 *
 * Takes the DECODED shape, so it is exact rather than estimated — which also
 * means it works for versions with no stored duration or file size at all (every
 * mix uploaded from the native iOS app, which writes neither). The gate this
 * replaced read `fileSizeBytes != null && …`, so unknown size fell OPEN: the
 * riskiest uploads were precisely the ones that skipped the check.
 */
export function canMeasureInBrowser(samplesPerChannel: number, channelCount: number): boolean {
  if (!Number.isFinite(samplesPerChannel) || !Number.isFinite(channelCount)) return false
  if (samplesPerChannel <= 0 || channelCount <= 0) return false
  return estimateMeasurePeakBytes(samplesPerChannel, channelCount) <= MAX_MEASURE_PEAK_BYTES
}

const toLufs = (meanSquare: number): number =>
  meanSquare > 0 ? LOUDNESS_OFFSET + 10 * Math.log10(meanSquare) : -Infinity

/**
 * Measure a decoded PCM signal per BS.1770-4.
 *
 * `channels` — one Float32Array (or number array) per channel, all the same
 * length, samples in [-1, 1]. Mono and stereo are weighted 1.0 per the spec;
 * additional channels are also weighted 1.0 (music mixes are not 5.1 — the
 * surround weights are deliberately out of scope).
 */
export function measureLoudness(channels: ArrayLike<number>[], sampleRate: number): LoudnessMeasurement {
  if (!channels.length || !channels[0].length) throw new Error('No audio samples to measure')
  if (!Number.isFinite(sampleRate) || sampleRate < 8000) throw new Error(`Unsupported sample rate: ${sampleRate}`)
  const n = channels[0].length
  for (const ch of channels) {
    if (ch.length !== n) throw new Error('Channels must be the same length')
  }

  // Sample peak from the RAW signal — the K-filter would distort it.
  let peak = 0
  for (const ch of channels) {
    for (let i = 0; i < n; i++) {
      const a = Math.abs(ch[i])
      if (a > peak) peak = a
    }
  }

  // K-weight each channel, then build prefix sums of squared samples so any
  // window's mean square is O(1) — the 400 ms gating blocks and the 3 s
  // short-term windows read the same array.
  const { shelf, highpass } = kWeighting(sampleRate)
  // One scratch buffer for the whole run: the shelf stage writes into it, the
  // highpass stage filters it in place (safe — see applyBiquad), and the next
  // channel overwrites it. Previously each stage of each channel allocated its
  // own Float64Array, so two full-length temporaries were live simultaneously.
  const scratch = new Float64Array(n)
  const prefixes: Float64Array[] = channels.map(ch => {
    applyBiquad(shelf, ch, scratch)
    const filtered = applyBiquad(highpass, scratch, scratch)
    const prefix = new Float64Array(n + 1)
    for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + filtered[i] * filtered[i]
    return prefix
  })
  const windowMeanSquare = (start: number, end: number): number => {
    let sum = 0
    for (const p of prefixes) sum += p[end] - p[start]
    return sum / (end - start)
  }

  // 400 ms blocks at 75 % overlap. A signal shorter than one block is measured
  // as a single partial block rather than rejected — a 300 ms bounce is
  // unusual but not an error.
  const blockLen = Math.min(n, Math.round(BLOCK_SEC * sampleRate))
  const hop = Math.max(1, Math.round(BLOCK_HOP_SEC * sampleRate))
  const blockMeanSquares: number[] = []
  for (let start = 0; start + blockLen <= n; start += hop) {
    blockMeanSquares.push(windowMeanSquare(start, start + blockLen))
  }
  if (!blockMeanSquares.length) blockMeanSquares.push(windowMeanSquare(0, n))

  // Gate 1 (absolute −70 LUFS), then gate 2 (−10 LU below the gated mean).
  const absGated = blockMeanSquares.filter(ms => toLufs(ms) > ABSOLUTE_GATE_LUFS)
  let integrated = -Infinity
  let gatedCount = 0
  if (absGated.length) {
    const absMean = absGated.reduce((a, b) => a + b, 0) / absGated.length
    const relThreshold = toLufs(absMean) + RELATIVE_GATE_LU
    const relGated = absGated.filter(ms => toLufs(ms) > relThreshold)
    if (relGated.length) {
      const mean = relGated.reduce((a, b) => a + b, 0) / relGated.length
      integrated = toLufs(mean)
      gatedCount = relGated.length
    }
  }

  // Loudest 3 s window, ungated — 1 s hop, with one final window flush against
  // the end so a hot outro is not missed. Short signals use one full window.
  const stLen = Math.min(n, Math.round(SHORT_TERM_SEC * sampleRate))
  const stHop = Math.max(1, Math.round(SHORT_TERM_HOP_SEC * sampleRate))
  let stMax = -Infinity
  for (let start = 0; ; start += stHop) {
    const end = Math.min(start + stLen, n)
    const lufs = toLufs(windowMeanSquare(end - stLen, end))
    if (lufs > stMax) stMax = lufs
    if (end >= n) break
  }

  return {
    integratedLufs: integrated,
    shortTermMaxLufs: stMax,
    samplePeakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
    gatedBlockCount: gatedCount,
  }
}

/** Per-DSP normalization outcome: positive delta = the platform turns it down. */
export function dspDeltas(m: LoudnessMeasurement): { name: string; targetLufs: number; deltaDb: number }[] {
  return DSP_TARGETS.map(t => ({
    name: t.name,
    targetLufs: t.lufs,
    deltaDb: Number.isFinite(m.integratedLufs) ? m.integratedLufs - t.lufs : NaN,
  }))
}

/**
 * Judge a measurement the way a mastering engineer would triage it. Same
 * {level, message} shape as the DistroKid readiness issues so the UI renders
 * both with one component. Always returns at least one row — silence about a
 * healthy master reads as "the check did nothing".
 *
 * Genre calibration matters here: −8 to −5 LUFS is the NORM for club-facing
 * genres (EDM/techno/house), not a mistake — normalized streaming turns it
 * down to target, and un-normalized contexts (DJ sets, CDJs, clubs, Beatport
 * buyers) get the intended level. So a loud master is reported as information
 * with the turn-down number, never scolded; the thing that genuinely bites a
 * loud master is PEAK headroom (Spotify's own guidance: true peak ≤ −2 dB
 * when louder than −14 LUFS), and that keeps its warning.
 */
export function masterVerdict(m: LoudnessMeasurement): LoudnessIssue[] {
  const issues: LoudnessIssue[] = []

  if (!Number.isFinite(m.integratedLufs)) {
    return [{ level: 'error', message: 'Too quiet to measure — the whole mix sits under the −70 LUFS gate. Check the export.' }]
  }
  const lufs = m.integratedLufs

  // Headroom. Lossy encoders (Ogg/AAC) overshoot on transcode, so a sample
  // peak at 0 dBFS clips on the platforms even if the WAV doesn't — and the
  // hotter the master, the stricter the platforms' own recommendation.
  if (m.samplePeakDb > -0.1) {
    issues.push({
      level: 'warning',
      message: `Peaks hit ${formatDb(m.samplePeakDb)} dBFS — lossy transcodes (Spotify/Apple) can clip. ${
        lufs > -14
          ? 'For a master this loud, Spotify recommends keeping true peak under −2 dB.'
          : 'Aim for at least −1 dB of headroom.'
      }`,
    })
  } else if (m.samplePeakDb > -1) {
    issues.push({ level: 'info', message: `Sample peak ${formatDb(m.samplePeakDb)} dBFS — tight headroom; true peaks likely exceed it after encoding.` })
  }

  if (lufs > -5) {
    issues.push({ level: 'warning', message: `Extremely loud master (${formatLufs(lufs)}) — beyond even club norms. Streaming normalization undoes the level; only the limiting stays.` })
  } else if (lufs > -9) {
    issues.push({ level: 'info', message: `Loud, club-level master (${formatLufs(lufs)}) — standard for EDM/techno. Streaming plays it normalized to target; DJ sets and clubs get the full level. Peak headroom is the number to watch.` })
  } else if (lufs < -20) {
    issues.push({ level: 'warning', message: `Quiet master (${formatLufs(lufs)}). Platforms only boost with a limiter (or not at all) — it will play noticeably quieter than other releases.` })
  }

  if (issues.length === 0) {
    issues.push({ level: 'info', message: `${formatLufs(lufs)} integrated, ${formatDb(m.samplePeakDb)} dBFS peak — healthy for streaming.` })
  }
  return issues
}

export function formatLufs(x: number): string {
  return Number.isFinite(x) ? `${x.toFixed(1)} LUFS` : '−∞ LUFS'
}

function formatDb(x: number): string {
  return Number.isFinite(x) ? x.toFixed(1) : '−∞'
}
