// Audio analysis utilities — BPM detection, key detection, dominant color extraction.
// All browser-side, no external dependencies. Uses Web Audio API.

// ─── BPM Detection ─────────────────────────────────────────────────────────────
// Onset-flux autocorrelation over up to 30 seconds of audio.
export function detectBPM(audioBuffer: AudioBuffer): number {
  const data = audioBuffer.getChannelData(0)
  const sr = audioBuffer.sampleRate
  const windowSize = Math.floor(sr * 0.01) // 10ms windows
  const maxFrames = Math.min(Math.floor(data.length / windowSize), 3000)

  const energy = new Float32Array(maxFrames)
  for (let i = 0; i < maxFrames; i++) {
    const s = i * windowSize
    let sum = 0
    for (let j = 0; j < windowSize; j++) { const v = data[s + j] ?? 0; sum += v * v }
    energy[i] = sum / windowSize
  }

  const flux = new Float32Array(maxFrames)
  for (let i = 1; i < maxFrames; i++) flux[i] = Math.max(0, energy[i] - energy[i - 1])

  // Autocorrelation — at 100fps, lag 30=200BPM, lag 100=60BPM
  let bestLag = 50, bestCorr = -1
  for (let lag = 30; lag <= 100; lag++) {
    let c = 0
    for (let i = 0; i < maxFrames - lag; i++) c += flux[i] * flux[i + lag]
    if (c > bestCorr) { bestCorr = c; bestLag = lag }
  }
  return Math.round(60_000 / (bestLag * 10))
}

// ─── Key Detection ─────────────────────────────────────────────────────────────
// Goertzel algorithm + Krumhansl-Kessler profiles. Analyzes up to 15s of audio.
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

export function detectKey(audioBuffer: AudioBuffer): string {
  const data = audioBuffer.getChannelData(0)
  const sr = audioBuffer.sampleRate
  // Downsample to ~4 kHz (covers musical content to 2 kHz)
  const factor = Math.max(1, Math.floor(sr / 4000))
  const dsr = sr / factor
  const dLen = Math.floor(Math.min(data.length, sr * 15) / factor)
  const down = new Float32Array(dLen)
  for (let i = 0; i < dLen; i++) down[i] = data[i * factor]

  const chroma = new Float32Array(12)
  for (let pc = 0; pc < 12; pc++) {
    let power = 0
    for (let oct = 2; oct <= 5; oct++) {
      const freq = 440 * Math.pow(2, (pc - 9 + (oct - 4) * 12) / 12)
      if (freq > dsr / 2) continue
      const omega = (2 * Math.PI * freq) / dsr
      const coeff = 2 * Math.cos(omega)
      let s1 = 0, s2 = 0
      for (let i = 0; i < dLen; i++) { const s = down[i] + coeff * s1 - s2; s2 = s1; s1 = s }
      power += s1 * s1 + s2 * s2 - s1 * s2 * coeff
    }
    chroma[pc] = power
  }

  const maxC = Math.max(...chroma)
  if (maxC > 0) for (let i = 0; i < 12; i++) chroma[i] /= maxC

  let bestKey = 'C maj', bestScore = -Infinity
  for (let root = 0; root < 12; root++) {
    let maj = 0, min = 0
    for (let i = 0; i < 12; i++) {
      maj += chroma[(i + root) % 12] * MAJOR[i]
      min += chroma[(i + root) % 12] * MINOR[i]
    }
    if (maj > bestScore) { bestScore = maj; bestKey = NOTES[root] + ' maj' }
    if (min > bestScore) { bestScore = min; bestKey = NOTES[root] + ' min' }
  }
  return bestKey
}

// ─── Dominant Color ─────────────────────────────────────────────────────────────
export function extractDominantColor(imgUrl: string): Promise<[number, number, number]> {
  const fallback: [number, number, number] = [167, 139, 250]
  return new Promise((resolve) => {
    const img = new window.Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      try {
        const c = document.createElement('canvas'); c.width = c.height = 8
        const ctx = c.getContext('2d')
        if (!ctx) return resolve(fallback)
        ctx.drawImage(img, 0, 0, 8, 8)
        const d = ctx.getImageData(0, 0, 8, 8).data
        let r = 0, g = 0, b = 0
        for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2] }
        const n = d.length / 4
        // Boost saturation so dim artwork still produces vivid accents
        resolve([Math.min(255, Math.round(r / n * 1.6)), Math.min(255, Math.round(g / n * 1.4)), Math.min(255, Math.round(b / n * 1.5))])
      } catch { resolve(fallback) }
    }
    img.onerror = () => resolve(fallback)
    img.src = imgUrl
  })
}

// ─── Analyze audio URL (fetch first 4 MB and decode) ───────────────────────────
export async function analyzeAudioUrl(url: string): Promise<{ bpm: number; key: string } | null> {
  try {
    const resp = await fetch(url, { headers: { Range: 'bytes=0-4000000' } })
    const buf = await resp.arrayBuffer()
    const ctx = new AudioContext()
    const ab = await ctx.decodeAudioData(buf)
    await ctx.close()
    return { bpm: detectBPM(ab), key: detectKey(ab) }
  } catch { return null }
}

// ─── Analyze a local File (before upload) ──────────────────────────────────────
export async function analyzeFile(file: File): Promise<{ bpm: number; key: string } | null> {
  try {
    const buf = await file.slice(0, 4_000_000).arrayBuffer()
    const ctx = new AudioContext()
    const ab = await ctx.decodeAudioData(buf)
    await ctx.close()
    return { bpm: detectBPM(ab), key: detectKey(ab) }
  } catch { return null }
}
