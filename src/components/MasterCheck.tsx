'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Gauge, AlertCircle, AlertTriangle, Check, GitCompareArrows, SlidersHorizontal } from 'lucide-react'
import { measureLoudness, masterVerdict, dspDeltas, formatLufs, canMeasureInBrowser, type LoudnessMeasurement } from '@/lib/loudness'
import { compareLoudness, sanitizeLoudness, toMeasurement, type LoudnessInput, type VersionLoudnessRow } from '@/lib/loudness-compare'
import { masterRecommendations } from '@/lib/master-recommendations'

// ─── Master check — measured loudness on one mix ─────────────────────────────
// Turns "mastering done?" from a self-reported checkbox into a fact: BS.1770-4
// integrated loudness + sample peak, measured in the browser from the same
// audio the platforms will get, with per-DSP normalization deltas ("Spotify
// will turn this down 2.3 dB") and a triaged verdict. Runs on demand — a full
// decode is seconds of CPU and tens of MB of memory, not something to do on
// every page view.
//
// Since migration 032 the number is also PERSISTED per version, which is what
// makes the block below the readout possible: the delta against the previous
// measured mix, separating "you moved the fader" from "you spent the dynamics".
// One tap on a button that already existed now compounds across the version
// history instead of dying in this device's localStorage.
//
// localStorage is kept as a second-line cache (it still answers instantly while
// the row loads, and it covers a failed POST), and on mount a reading that
// exists locally but NOT in the database is silently pushed up — that backfills
// every measurement taken before persistence shipped, with zero user action.

type Props = {
  /** Cache key — measurements are immutable per version upload. */
  versionId: string
  /** Proxied audio URL (audioProxyUrl-wrapped, same-origin). */
  audioUrl: string
  fileSizeBytes: number | null
  /** The stored measurement for THIS version, read off the mb_versions row. */
  initial?: LoudnessInput | null
  /** The stored measurement for the nearest older mix that has one. */
  previous?: LoudnessInput | null
  /** What to call that older mix in the heading ("Mix 6"). */
  previousLabel?: string | null
  /** Fired with the saved columns so the page can update its version state
   *  without a refetch. */
  onMeasured?: (row: VersionLoudnessRow) => void
}

// Guard on the DOWNLOAD only. This is deliberately not the memory gate — the
// real limit is decided after decode by canMeasureInBrowser(), which knows the
// exact sample count and channel layout. This one just avoids pulling half a
// gigabyte over cellular before discovering we can't measure it.
const MAX_FETCH_BYTES = 400 * 1024 * 1024

const CACHE_PREFIX = 'mb-loudness-v1:'

function readCache(versionId: string): LoudnessMeasurement | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + versionId)
    if (!raw) return null
    const clean = sanitizeLoudness(JSON.parse(raw))
    // -Infinity survives JSON as null — toMeasurement restores it so the verdict
    // logic holds. (This used to be four hand-written `?? -Infinity` lines here;
    // it now shares the API's validator, so a corrupt cache entry can't feed a
    // nonsense delta either.)
    return clean ? toMeasurement(clean) : null
  } catch {
    return null
  }
}

/**
 * Exported because the upload path measures too (ProjectClient auto-measures a
 * fresh mix from the local File, skipping the re-download this component would
 * otherwise pay). Both writers must use the SAME key and shape or the reading
 * this component shows and the one the backfill pushes up would drift apart.
 */
export function writeLoudnessCache(versionId: string, m: LoudnessMeasurement) {
  try {
    localStorage.setItem(CACHE_PREFIX + versionId, JSON.stringify(m))
  } catch { /* storage full or unavailable — measuring again later is fine */ }
}

export default function MasterCheck({
  versionId, audioUrl, fileSizeBytes,
  initial = null, previous = null, previousLabel = null, onMeasured,
}: Props) {
  // Measured in THIS session — takes precedence over anything stored.
  const [measured, setMeasured] = useState<LoudnessMeasurement | null>(null)
  const [cached, setCached] = useState<LoudnessMeasurement | null>(null)
  const [measuring, setMeasuring] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The parent re-creates onMeasured on every render, so it is held in a ref
  // rather than a dependency: putting it in the array below would re-fire the
  // backfill effect (and its POST) on every unrelated keystroke on the page.
  const onMeasuredRef = useRef(onMeasured)
  useEffect(() => { onMeasuredRef.current = onMeasured })

  // Reset on version switch. Note `initial` is read during render instead of
  // being copied into state — it arrives with the server-rendered row, so
  // treating it as state would only create a way for the two to disagree.
  useEffect(() => {
    setMeasured(null)
    setCached(readCache(versionId))
    setError(null)
    setMeasuring(false)
  }, [versionId])

  const persist = useCallback(async (m: LoudnessMeasurement) => {
    try {
      const res = await fetch(`/api/versions/${versionId}/loudness`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(m),
      })
      if (!res.ok) return
      const data = await res.json().catch(() => null)
      if (data?.version) onMeasuredRef.current?.(data.version as VersionLoudnessRow)
    } catch {
      // The number is on screen and in localStorage either way. A failed save
      // must never look like a failed measurement — the user did the expensive
      // part, and the next measure (or the backfill on the next visit) retries.
    }
  }, [versionId])

  // Free backfill: this version was measured before persistence existed, so the
  // reading is sitting in localStorage while the row has nothing. Push it up
  // silently. No user action, and it is what gives the cross-version delta a
  // second data point on day one instead of after two more manual measurements.
  const hasStored = initial != null
  useEffect(() => {
    if (hasStored) return
    const local = readCache(versionId)
    if (local) void persist(local)
  }, [versionId, hasStored, persist])

  // Known-huge uploads are refused before we even offer the button. A null size
  // is NOT treated as small — it's simply unknown, and the authoritative check
  // now happens after decode, where the true cost is knowable.
  const tooLarge = fileSizeBytes != null && fileSizeBytes > MAX_FETCH_BYTES

  const TOO_BIG_MESSAGE = 'This mix is too long to measure in the browser — measuring it would use more memory than a phone can spare.'

  const measure = async () => {
    setMeasuring(true)
    setError(null)
    let ctx: AudioContext | null = null
    try {
      const res = await fetch(audioUrl)
      if (!res.ok) throw new Error(`Could not fetch the audio (${res.status})`)
      // Catches the oversized file whose row never recorded a size (every iOS
      // upload) before it costs the user the download.
      const declared = Number(res.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > MAX_FETCH_BYTES) throw new Error(TOO_BIG_MESSAGE)

      const bytes = await res.arrayBuffer()
      ctx = new AudioContext()
      const decoded = await ctx.decodeAudioData(bytes)
      // The real gate: exact sample count and channel layout in hand, refuse
      // before allocating the filter working set rather than during it.
      if (!canMeasureInBrowser(decoded.length, decoded.numberOfChannels)) {
        throw new Error(TOO_BIG_MESSAGE)
      }
      const channels: Float32Array[] = []
      for (let c = 0; c < decoded.numberOfChannels; c++) channels.push(decoded.getChannelData(c))
      const m = measureLoudness(channels, decoded.sampleRate)
      writeLoudnessCache(versionId, m)
      setMeasured(m)
      void persist(m)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not measure this file')
    } finally {
      // Free the decoder — a lingering context competes with playback.
      void ctx?.close().catch(() => {})
      setMeasuring(false)
    }
  }

  // Display precedence: this session's measurement, then the stored row, then
  // this device's cache.
  const measurement = measured ?? (initial ? toMeasurement(initial) : cached)
  // compareLoudness returns null unless both sides are fully measured, so this
  // whole block simply doesn't render until there is something real to say.
  const comparison = compareLoudness(previous, sanitizeLoudness(measurement))

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

          {/* The comparison no DAW can make: what changed since the last mix,
              and how much of it was level versus limiting. */}
          {comparison && (
            <div className="rounded-lg px-2.5 py-2 space-y-1" style={{ border: '1px solid var(--border)' }}>
              <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] flex items-center gap-1.5">
                <GitCompareArrows size={11} />
                vs {previousLabel ?? 'the previous mix'}
              </p>
              {comparison.lines.map((line, i) => (
                <div key={i} className={`flex items-start gap-2 text-xs ${issueTone(line.level)}`}>
                  {issueIcon(line.level)}
                  <span>{line.message}</span>
                </div>
              ))}
            </div>
          )}

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

          {/* Limiter & chain settings the numbers imply — universal advice
              first, the same move in Pro-L 2 / Ozone 11 terms underneath. */}
          {(() => {
            const recs = masterRecommendations(measurement)
            if (recs.length === 0) return null
            return (
              <div className="rounded-lg px-2.5 py-2 space-y-2" style={{ border: '1px solid var(--border)' }}>
                <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] flex items-center gap-1.5">
                  <SlidersHorizontal size={11} />
                  Limiter &amp; chain recommendations
                </p>
                {recs.map((r, i) => (
                  <div key={i} className="text-xs space-y-0.5">
                    <p className="text-[var(--text-secondary)]">
                      <span className="font-semibold text-[#2dd4bf]">{r.area}.</span> {r.advice}
                    </p>
                    {r.plugins && (
                      <p className="text-[11px] text-[var(--text-muted)]">{r.plugins}</p>
                    )}
                  </div>
                ))}
              </div>
            )
          })()}
        </>
      )}
    </div>
  )
}
