// Waveform peaks — the pure math behind GET /api/share/<token>/peaks.
//
// Deliberately import-free so scripts/waveform-peaks-test.mjs can load the
// real module under Node's type stripping (relative, extension-full import).
//
// The server decodes a mix to mono 16-bit PCM at a low sample rate (ffmpeg,
// see the route) and folds it into BARS buckets. Each bucket keeps the loudest
// sample it saw (what a waveform is expected to look like: transients stand
// up), then the whole set is normalised so the loudest bar is 1. Values ship
// as integers 0–100 — a 200-bar waveform is ~800 bytes of JSON, small enough
// to live on the version row and to inline into any page.

export const BARS = 200
export const PEAK_SCALE = 100

/** Fold raw 16-bit little-endian PCM into BARS integer peaks (0–PEAK_SCALE). */
export function peaksFromPcm16(pcm: Uint8Array, bars: number = BARS): number[] {
  const samples = Math.floor(pcm.length / 2)
  if (samples === 0 || bars <= 0) return []
  const view = new DataView(pcm.buffer, pcm.byteOffset, samples * 2)
  const out = new Array<number>(bars).fill(0)
  // Bucket boundaries in samples. A bar is never empty: with fewer samples
  // than bars, the trailing bars simply stay at 0.
  const per = samples / bars
  let bucket = 0
  let max = 0
  let next = per
  for (let i = 0; i < samples; i++) {
    const v = Math.abs(view.getInt16(i * 2, true))
    if (v > max) max = v
    if (i + 1 >= next || i === samples - 1) {
      out[bucket] = max
      bucket++
      max = 0
      next = per * (bucket + 1)
      if (bucket >= bars) break
    }
  }
  return normalisePeaks(out)
}

/** Scale so the loudest bar is PEAK_SCALE; a silent file is all zeros. */
export function normalisePeaks(raw: number[]): number[] {
  let top = 0
  for (const v of raw) if (v > top) top = v
  if (top <= 0) return raw.map(() => 0)
  return raw.map(v => Math.round((v / top) * PEAK_SCALE))
}

/** True for a value the column may hold: an array of 1–BARS*2 integers 0–PEAK_SCALE. */
export function isPeakList(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= BARS * 2
    && value.every(v => Number.isInteger(v) && v >= 0 && v <= PEAK_SCALE)
}

/** Resample a peak list to `count` bars for drawing at a different width —
 *  each output bar is the max of the input bars it covers. */
export function resamplePeaks(peaks: number[], count: number): number[] {
  if (count <= 0 || peaks.length === 0) return []
  if (peaks.length === count) return peaks.slice()
  const out = new Array<number>(count).fill(0)
  for (let i = 0; i < count; i++) {
    const from = Math.floor((i / count) * peaks.length)
    const to = Math.max(from + 1, Math.floor(((i + 1) / count) * peaks.length))
    let m = 0
    for (let j = from; j < to && j < peaks.length; j++) if (peaks[j] > m) m = peaks[j]
    out[i] = m
  }
  return out
}
