'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { MonitorPlay, Smartphone, Download, Clapperboard, RefreshCw } from 'lucide-react'
import { TEXT_COLORS } from '@/lib/text-colors'
import { saveMedia } from '@/lib/download'

// ── Video finalizer — the "assemble the finished product" tab ────────────────
// Renders the upload-ready full-length video (16:9, horizontal) and vertical
// Short (9:16) for a song by combining a pinned visualizer (looped
// seamlessly), the current mix audio, and the artwork text lockup flashing
// through the track. Each format renders from the pin in its own orientation
// — the horizontal pin feeds Finalize Full-Length, the vertical pin feeds
// Finalize Short — falling back to the other pin (center-cropped) when only
// one is set. Renders take minutes server-side, so POST starts a job and this
// component polls.

type VideoFormat = 'youtube' | 'shorts'

type SavedVideo = { id: string; video_url: string; title: string | null; created_at: string } | null

type JobState = {
  jobId: string
  status: 'rendering' | 'uploading' | 'done' | 'error'
  progress: number
  stage: string
  error?: string
}

type Props = {
  projectId: string
  /** Vertical pin (mb_projects.visualizer_url) — source for the Short. */
  visualizerUrl: string | null
  /** Horizontal pin (visualizer_wide_url) — source for the full-length video. */
  wideVisualizerUrl: string | null
  hasAudio: boolean
  /** Song length in seconds when known — drives the Short start-point options. */
  audioDurationSec: number | null
  onSwitchToVisualizer: () => void
}

const SHORT_LENGTHS = [15, 30, 60] as const

export default function VideoFinalizer({
  projectId, visualizerUrl, wideVisualizerUrl, hasAudio, audioDurationSec, onSwitchToVisualizer,
}: Props) {
  const [saved, setSaved] = useState<Record<VideoFormat, SavedVideo>>({ youtube: null, shorts: null })
  const [jobs, setJobs] = useState<Partial<Record<VideoFormat, JobState>>>({})
  const [errors, setErrors] = useState<Partial<Record<VideoFormat, string>>>({})
  const [color, setColor] = useState('#FFFFFF')
  const [shortLen, setShortLen] = useState<15 | 30 | 60>(30)
  const [shortStart, setShortStart] = useState<'start' | 'hook' | 'middle'>('hook')
  const pollTimers = useRef<Partial<Record<VideoFormat, ReturnType<typeof setInterval>>>>({})

  // Latest saved renders so returning to the tab shows the finished videos.
  useEffect(() => {
    let cancelled = false
    fetch(`/api/finalize-video?project_id=${projectId}`)
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (!cancelled && data) setSaved({ youtube: data.youtube ?? null, shorts: data.shorts ?? null })
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [projectId])

  const stopPolling = useCallback((format: VideoFormat) => {
    const t = pollTimers.current[format]
    if (t) clearInterval(t)
    delete pollTimers.current[format]
  }, [])

  // Clear all pollers on unmount.
  useEffect(() => {
    const timers = pollTimers.current
    return () => { for (const t of Object.values(timers)) if (t) clearInterval(t) }
  }, [])

  const pollJob = useCallback((format: VideoFormat, jobId: string) => {
    stopPolling(format)
    pollTimers.current[format] = setInterval(async () => {
      try {
        const res = await fetch(`/api/finalize-video?job=${jobId}`)
        const data = await res.json().catch(() => null)
        if (!res.ok || !data) {
          stopPolling(format)
          setJobs(j => ({ ...j, [format]: undefined }))
          setErrors(e => ({ ...e, [format]: data?.error ?? 'Render was interrupted — try again.' }))
          return
        }
        if (data.status === 'done' && data.video_url) {
          stopPolling(format)
          setJobs(j => ({ ...j, [format]: undefined }))
          setSaved(s => ({ ...s, [format]: { id: data.job_id, video_url: data.video_url, title: null, created_at: new Date().toISOString() } }))
        } else if (data.status === 'error') {
          stopPolling(format)
          setJobs(j => ({ ...j, [format]: undefined }))
          setErrors(e => ({ ...e, [format]: data.error ?? 'Render failed. Try again.' }))
        } else {
          setJobs(j => ({ ...j, [format]: { jobId, status: data.status, progress: data.progress, stage: data.stage } }))
        }
      } catch {
        // transient network blip — keep polling
      }
    }, 2500)
  }, [stopPolling])

  async function startRender(format: VideoFormat) {
    setErrors(e => ({ ...e, [format]: undefined }))
    const startSec = format === 'shorts' && audioDurationSec
      ? (shortStart === 'hook' ? Math.round(audioDurationSec * 0.3) : shortStart === 'middle' ? Math.round(audioDurationSec * 0.5) : 0)
      : 0
    try {
      const res = await fetch('/api/finalize-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          format,
          color,
          ...(format === 'shorts' ? { clip_seconds: shortLen, start_sec: startSec } : {}),
        }),
      })
      const data = await res.json().catch(() => null)
      if (res.ok && data?.job_id) {
        setJobs(j => ({ ...j, [format]: { jobId: data.job_id, status: 'rendering', progress: 0, stage: 'Starting' } }))
        pollJob(format, data.job_id)
      } else if (res.status === 409 && data?.job_id) {
        // A render is already going (e.g. tab reopened) — reattach to it.
        pollJob(format, data.job_id)
      } else {
        setErrors(e => ({ ...e, [format]: data?.error ?? 'Could not start the render.' }))
      }
    } catch {
      // The POST never reached the server (offline, DNS blip, connection reset).
      // Without this the async click handler's rejection is swallowed and the
      // button silently does nothing — surface it so the user can retry.
      setErrors(e => ({ ...e, [format]: 'Could not reach the server. Check your connection and try again.' }))
    }
  }

  // ── Gating: audio + at least one pinned visualizer before anything renders ─
  const anyViz = visualizerUrl || wideVisualizerUrl
  if (!anyViz || !hasAudio) {
    return (
      <div className="max-w-2xl">
        <div className="rounded-2xl p-8 text-center" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}>
          <Clapperboard size={28} className="mx-auto mb-3 text-[#2dd4bf]" />
          <h3 className="text-sm font-semibold text-[var(--text)] mb-2">Finish the pieces first</h3>
          <p className="text-xs text-[var(--text-muted)] mb-4 leading-relaxed">
            The video finalizer combines your pinned visualizers, the current mix, and your title text
            into an upload-ready full-length video (horizontal) and Short (vertical).
          </p>
          <ul className="text-xs text-[var(--text-secondary)] space-y-1.5 mb-5 inline-block text-left">
            <li className={hasAudio ? 'line-through text-[var(--text-muted)]' : ''}>1. Upload a mix (Song Info tab)</li>
            <li className={anyViz ? 'line-through text-[var(--text-muted)]' : ''}>2. Generate &amp; pin a visualizer</li>
          </ul>
          <div>
            {!anyViz && (
              <button
                onClick={onSwitchToVisualizer}
                className="px-4 py-2 text-xs font-semibold bg-[#2dd4bf] text-[#0a0a0a] rounded-xl hover:bg-[#14b8a6] transition-colors"
              >
                Go to Visualizer
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-2xl space-y-5">
      <p className="text-xs text-[var(--text-muted)] leading-relaxed">
        Loops a pinned visualizer seamlessly for the length of the song, flashes the artist name and
        title (styled like your artwork) through the track, and muxes in the current mix — rendered
        server-side into an upload-ready MP4. The full-length video renders from your horizontal pin,
        the Short from your vertical pin.
      </p>

      {/* Shared text color */}
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wider text-[#777] mb-1.5">Text color</p>
        <div className="flex items-center gap-1.5 flex-wrap">
          {TEXT_COLORS.map(c => (
            <button
              key={c.value}
              onClick={() => setColor(c.value)}
              title={c.label}
              aria-label={`Text color ${c.label}`}
              className={`w-7 h-7 rounded-full border-2 transition-all ${
                color === c.value ? 'border-[#2dd4bf] scale-110' : 'border-[#333] hover:border-[#555]'
              }`}
              style={{ backgroundColor: c.value }}
            />
          ))}
        </div>
      </div>

      <FormatCard
        icon={<MonitorPlay size={15} />}
        title="Full-length video"
        subtitle="1920×1080 · horizontal · full song"
        aspect="16/9"
        renderLabel="Finalize Full-Length"
        sourceNote={!wideVisualizerUrl
          ? 'No horizontal visualizer pinned — this will center-crop your vertical pin. Pin a 16:9 loop in the Visualizer tab for a full-frame render.'
          : undefined}
        saved={saved.youtube}
        job={jobs.youtube}
        error={errors.youtube}
        onRender={() => startRender('youtube')}
      />

      <FormatCard
        icon={<Smartphone size={15} />}
        title="Short / vertical ad"
        subtitle="1080×1920 · vertical · clip of the song"
        aspect="9/16"
        renderLabel="Finalize Short"
        sourceNote={!visualizerUrl
          ? 'No vertical visualizer pinned — this will center-crop your horizontal pin. Pin a 9:16 loop in the Visualizer tab for a full-frame render.'
          : undefined}
        saved={saved.shorts}
        job={jobs.shorts}
        error={errors.shorts}
        onRender={() => startRender('shorts')}
        controls={
          <div className="flex flex-wrap gap-3">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-[#777] mb-1">Length</p>
              <div className="flex gap-1 p-0.5 bg-[#0f0f0f] border border-[#222] rounded-xl">
                {SHORT_LENGTHS.map(len => (
                  <button
                    key={len}
                    onClick={() => setShortLen(len)}
                    className={`px-3 py-1.5 text-[10px] font-medium rounded-lg transition-colors ${
                      shortLen === len ? 'bg-[#2dd4bf]/20 text-[#2dd4bf]' : 'text-[#555] hover:text-[#888]'
                    }`}
                  >
                    {len}s
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-[#777] mb-1">Starts at</p>
              <div className="flex gap-1 p-0.5 bg-[#0f0f0f] border border-[#222] rounded-xl">
                {([['start', 'Intro'], ['hook', 'Hook'], ['middle', 'Middle']] as const).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setShortStart(key)}
                    disabled={key !== 'start' && !audioDurationSec}
                    className={`px-3 py-1.5 text-[10px] font-medium rounded-lg transition-colors disabled:opacity-40 ${
                      shortStart === key ? 'bg-[#2dd4bf]/20 text-[#2dd4bf]' : 'text-[#555] hover:text-[#888]'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        }
      />
    </div>
  )
}

function FormatCard({
  icon, title, subtitle, aspect, renderLabel, sourceNote, saved, job, error, onRender, controls,
}: {
  icon: React.ReactNode
  title: string
  subtitle: string
  aspect: '16/9' | '9/16'
  renderLabel: string
  /** Warning shown when this format has to fall back to the other orientation's pin. */
  sourceNote?: string
  saved: SavedVideo
  job?: JobState
  error?: string
  onRender: () => void
  controls?: React.ReactNode
}) {
  const rendering = !!job
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Share-sheet on phones (so "Save Video" → Photos), true attachment download
  // on desktop — never a bare cross-origin link that just opens and plays.
  async function save() {
    if (!saved || saving) return
    setSaving(true)
    setSaveError(null)
    try {
      await saveMedia(saved.video_url, saved.title || title, 'mp4')
    } catch {
      setSaveError('Could not save the video — check your connection and try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rounded-2xl p-5 space-y-3" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}>
      <div className="flex items-center gap-2">
        <span className="text-[#2dd4bf]">{icon}</span>
        <h3 className="text-sm font-semibold text-[var(--text)]">{title}</h3>
        <span className="text-[10px] text-[var(--text-muted)]">{subtitle}</span>
      </div>

      {controls}

      {sourceNote && !rendering && (
        <p className="text-[11px] leading-relaxed text-amber-400/90">{sourceNote}</p>
      )}

      {saved && !rendering && (
        <video
          key={saved.video_url}
          src={saved.video_url}
          controls
          playsInline
          preload="metadata"
          className={`w-full rounded-xl bg-black ${aspect === '9/16' ? 'max-w-[240px]' : ''}`}
          style={{ aspectRatio: aspect.replace('/', ' / ') }}
        />
      )}

      {rendering && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11px] text-[var(--text-secondary)]">
            <span>{job.stage}</span>
            <span>{job.progress}%</span>
          </div>
          <div className="w-full h-1.5 bg-[var(--surface-2)] rounded-full overflow-hidden">
            <div className="h-full rounded-full bg-[#2dd4bf] transition-all duration-500" style={{ width: `${Math.max(2, job.progress)}%` }} />
          </div>
          <p className="text-[10px] text-[var(--text-muted)]">Takes a few minutes — you can leave this tab and come back.</p>
        </div>
      )}

      {(error || saveError) && <p className="text-red-400 text-xs">{error || saveError}</p>}

      <div className="flex gap-2">
        <button
          onClick={onRender}
          disabled={rendering}
          className="flex-1 flex items-center justify-center gap-2 py-2.5 text-xs font-semibold bg-[#0f0f0f] border border-[#2dd4bf]/40 text-[#2dd4bf] rounded-xl hover:bg-[#2dd4bf]/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {rendering ? (
            <>
              <span className="w-3 h-3 border border-[#2dd4bf]/30 border-t-[#2dd4bf] rounded-full animate-spin" />
              Rendering…
            </>
          ) : (
            <>
              {saved ? <RefreshCw size={13} /> : <Clapperboard size={13} />}
              {renderLabel}
            </>
          )}
        </button>
        {saved && !rendering && (
          <button
            onClick={save}
            disabled={saving}
            className="flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-medium bg-[#1e1e1e] border border-[#333] text-white rounded-xl hover:bg-[#2a2a2a] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? (
              <>
                <span className="w-3 h-3 border border-white/30 border-t-white rounded-full animate-spin" />
                Saving…
              </>
            ) : (
              <>
                <Download size={13} />
                Save
              </>
            )}
          </button>
        )}
      </div>
    </div>
  )
}
