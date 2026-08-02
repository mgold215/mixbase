'use client'

import { useEffect, useState } from 'react'
import { Gauge, AlertCircle, AlertTriangle, Check } from 'lucide-react'
import { measureLoudness, masterVerdict, dspDeltas, formatLufs, type LoudnessMeasurement } from '@/lib/loudness'

// ─── Master check — measured loudness on the current mix ─────────────────────
// Turns "mastering done?" from a self-reported checkbox into a fact: BS.1770-4
// integrated loudness + sample peak, measured in the browser from the same
// audio the platforms will get, with per-DSP normalization deltas ("Spotify
// will turn this down 2.3 dB") and a triaged verdict. Runs on demand — a full
// decode is seconds of CPU and tens of MB of memory, not something to do on
// every page view — and caches per version in localStorage, so each mix is
// measured once and the number is there instantly on every later visit.

type Props = {
  /** Cache key — measurements are immutable per version upload. */
  versionId: string
  /** Proxied audio URL (audioProxyUrl-wrapped, same-origin). */
  audioUrl: string
  fileSizeBytes: number | null
}

// A decoded 16-bit stereo WAV doubles in memory as Float32 and the K-filter
// pass adds a similar working set again. Past this upload size, a phone tab is
// likely to be killed mid-decode — be honest about the limit instead of
// crashing. (Server-side measurement is the follow-on for these.)
const MAX_DECODE_BYTES = 150 * 1024 * 1024

const CACHE_PREFIX = 'mb-loudness-v1:'

function readCache(versionId: string): LoudnessMeasurement | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + versionId)
    if (!raw) return null
    const p = JSON.parse(raw)
    // -Infinity survives JSON as null — restore it so the verdict logic holds.
    return {
      integratedLufs: p.integratedLufs ?? -Infinity,
      shortTermMaxLufs: p.shortTermMaxLufs ?? -Infinity,
      samplePeakDb: p.samplePeakDb ?? -Infinity,
      gatedBlockCount: p.gatedBlockCount ?? 0,
    }
  } catch {
    return null
  }
}

function writeCache(versionId: string, m: LoudnessMeasurement) {
  try {
    localStorage.setItem(CACHE_PREFIX + versionId, JSON.stringify(m))
  } catch { /* storage full or unavailable — measuring again later is fine */ }
}

export default function MasterCheck({ versionId, audioUrl, fileSizeBytes }: Props) {
  const [measurement, setMeasurement] = useState<LoudnessMeasurement | null>(null)
  const [measuring, setMeasuring] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Show a previously measured result instantly on mount / version switch.
  useEffect(() => {
    setMeasurement(readCache(versionId))
    setError(null)
    setMeasuring(false)
  }, [versionId])

  const tooLarge = fileSizeBytes != null && fileSizeBytes > MAX_DECODE_BYTES

  const measure = async () => {
    setMeasuring(true)
    setError(null)
    let ctx: AudioContext | null = null
    try {
      const res = await fetch(audioUrl)
      if (!res.ok) throw new Error(`Could not fetch the audio (${res.status})`)
      const bytes = await res.arrayBuffer()
      ctx = new AudioContext()
      const decoded = await ctx.decodeAudioData(bytes)
      const channels: Float32Array[] = []
      for (let c = 0; c < decoded.numberOfChannels; c++) channels.push(decoded.getChannelData(c))
      const m = measureLoudness(channels, decoded.sampleRate)
      writeCache(versionId, m)
      setMeasurement(m)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not measure this file')
    } finally {
      // Free the decoder — a lingering context competes with playback.
      void ctx?.close().catch(() => {})
      setMeasuring(false)
    }
  }

  const issueIcon = (level: 'error' | 'warning' | 'info') =>
    level === 'error' ? <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
    : level === 'warning' ? <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
    : <Check size={12} className="mt-0.5 flex-shrink-0" />
  const issueTone = (level: 'error' | 'warning' | 'info') =>
    level === 'error' ? 'text-red-400' : level === 'warning' ? 'text-amber-400' : 'text-emerald-400'

  return (
    <div className="rounded-xl p-3 space-y-2.5" style={{ backgroundColor: 'var(--surface-2)' }}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-[11px] text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-1.5">
          <Gauge size={12} />
          Master check
        </p>
        {measurement ? (
          <button
            onClick={measure}
            disabled={measuring || tooLarge}
            className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text)] disabled:opacity-40 transition-colors"
          >
            {measuring ? 'Measuring…' : 'Re-measure'}
          </button>
        ) : tooLarge ? (
          <span className="text-[11px] text-[var(--text-muted)]">File too large to measure in the browser</span>
        ) : (
          <button
            onClick={measure}
            disabled={measuring}
            className="text-[11px] font-semibold text-[#2dd4bf] hover:text-[#14b8a6] disabled:opacity-40 transition-colors"
          >
            {measuring ? 'Measuring…' : 'Measure loudness'}
          </button>
        )}
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {measurement && (
        <>
          <div className="flex items-baseline gap-4 flex-wrap">
            <span className="text-lg font-semibold text-[var(--text)]">{formatLufs(measurement.integratedLufs)}</span>
            <span className="text-xs text-[var(--text-muted)]">integrated</span>
            <span className="text-xs text-[var(--text-muted)]">
              peak {Number.isFinite(measurement.samplePeakDb) ? `${measurement.samplePeakDb.toFixed(1)} dBFS` : '−∞'}
              <span className="opacity-60"> (sample)</span>
            </span>
            <span className="text-xs text-[var(--text-muted)]">
              loudest 3s {formatLufs(measurement.shortTermMaxLufs)}
            </span>
          </div>

          {/* What each platform's normalizer will do with this master. */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-1.5">
            {dspDeltas(measurement).map(d => (
              <div key={d.name} className="rounded-lg px-2 py-1.5 text-[11px]" style={{ border: '1px solid var(--border)' }}>
                <span className="text-[var(--text-muted)]">{d.name}</span>
                <div className="text-[var(--text)]">
                  {Number.isNaN(d.deltaDb) ? '—'
                    : d.deltaDb > 0.2 ? `−${d.deltaDb.toFixed(1)} dB by normalization`
                    : d.deltaDb < -0.2 ? `${Math.abs(d.deltaDb).toFixed(1)} dB under target`
                    : 'at target'}
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-1">
            {masterVerdict(measurement).map((iss, i) => (
              <div key={i} className={`flex items-start gap-2 text-xs ${issueTone(iss.level)}`}>
                {issueIcon(iss.level)}
                <span>{iss.message}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
