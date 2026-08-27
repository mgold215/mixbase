'use client'

import { useState, useRef, useEffect, useCallback, type ChangeEvent } from 'react'
import { useParams } from 'next/navigation'
import Image from 'next/image'
import { Play, Pause, MessageSquare, ChevronDown, Download } from 'lucide-react'
import CassetteIcon from '@/components/CassetteIcon'
import { audioProxyUrl, displayArtworkUrl, formatDuration } from '@/lib/supabase'
import { extractDominantColor } from '@/lib/audio-analysis'
import { applyMediaSession } from '@/lib/media-session'
import { announcePlay, announceStop, onOtherSourcePlay } from '@/lib/audio-coordinator'
import FeedbackForm from '@/components/FeedbackForm'

// The public share page renders ONLY these version fields. The loader
// (share/[token]/page.tsx) selects exactly this set and deliberately omits
// owner-private columns (private_notes, mb_feedback, share_token, …), so the
// type mirrors the minimized public payload — reading an omitted field here
// would fail the build, preventing an accidental re-leak.
type Props = {
  version: {
    id: string
    audio_url: string
    label: string | null
    version_number: number
    status: string | null
    public_notes: string | null
    allow_download: boolean
    // to-one project embed; supabase-js types embeds loosely
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mb_projects: any
  }
  // Public artist name (already shown in the page header) — feeds the Media
  // Session artist slot so lock screens / car displays don't say "mixBase".
  artistName: string
}

// The share page never receives mb_versions.audio_filename (the artist's own
// upload name can carry private context — "clientX-rough-DONTSEND.wav"), so the
// saved file is named after the public track title, taking its extension from
// the storage path so the bytes land as the format that was actually uploaded.
function downloadFileName(audioUrl: string, title: string): string {
  const ext = audioUrl.split('?')[0].split('.').pop()
  const safeExt = ext && /^[a-z0-9]{1,5}$/i.test(ext) ? ext.toLowerCase() : 'wav'
  const safeTitle = title.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'mix'
  return `${safeTitle}.${safeExt}`
}

export default function ShareClient({ version, artistName }: Props) {
  // The share token this page was addressed by. Read from the route rather than
  // taken as a prop: page.tsx deliberately hands this component the MINIMISED
  // public projection of the row (see the Props note above), and the token is
  // not part of it — it is in the URL the visitor already has.
  const params = useParams<{ token?: string }>()
  const shareToken = typeof params?.token === 'string' ? params.token : null

  const audioRef = useRef<HTMLAudioElement>(null)
  const vizVideoRef = useRef<HTMLVideoElement | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [accent, setAccent] = useState<[number, number, number]>([139, 92, 246])
  const [showFeedback, setShowFeedback] = useState(false)

  const project = version.mb_projects
  const artworkUrl: string | null = displayArtworkUrl(project ?? {})
  // Project visualizer (Spotify-Canvas style) — ?? null because rows can
  // predate the 015 migration until the column self-heals.
  const visualizerUrl: string | null = project?.visualizer_url ?? null
  const title: string = project?.title ?? 'Untitled'
  const audioUrl = audioProxyUrl(version.audio_url)
  const accentCss = `rgb(${accent[0]},${accent[1]},${accent[2]})`
  // Original-quality download, when the artist enabled it on this mix. The
  // audio proxy is same-origin, so the `download` attribute is honoured and
  // ?download=1 makes it a streamed attachment — a 2 GB WAV never buffers.
  const downloadName = downloadFileName(version.audio_url, title)
  const downloadHref = `${audioUrl}?download=1&filename=${encodeURIComponent(downloadName)}`
  const downloadLabel = downloadName.split('.').pop()!.toUpperCase()

  // Keep the muted visualizer loop in step with the audio: runs while the
  // track plays, freezes on pause — same behavior as the app's full player.
  // play() can reject (autoplay policy); the video just sits on its first frame.
  useEffect(() => {
    const v = vizVideoRef.current
    if (!v) return
    if (isPlaying) v.play().catch(() => {})
    else v.pause()
  }, [isPlaying, visualizerUrl])

  // Extract accent colour from artwork
  useEffect(() => {
    if (artworkUrl) {
      extractDominantColor(artworkUrl).then(setAccent).catch(() => {})
    }
  }, [artworkUrl])

  // ── Self-healing duration backfill (public half) ───────────────────────────
  // 145 of 364 mb_versions rows have duration_seconds NULL. The signed-in
  // surfaces heal themselves through PlayerContext → PATCH /api/versions/[id],
  // but that route is owner-only and this page has no session at all: its
  // listener is whoever the artist sent the link to. Nothing here could reach
  // it, so before this the share player — one of the places an un-healed back
  // catalogue actually gets played — measured the true length on every play and
  // threw it away.
  //
  // POST /api/share/<token>/duration takes that reading under the authority of
  // the token already in the address bar. Fire-and-forget by construction:
  // nothing awaits it, nothing surfaces on failure, and it runs from a media
  // event handler that returns immediately, so playback never waits on it.
  const healAttemptedRef = useRef(false)
  const healDuration = useCallback((audio: HTMLAudioElement) => {
    if (healAttemptedRef.current || !shareToken) return

    const seconds = audio.duration
    // THE guard, and the reason this is a function and not one line at the call
    // site. `duration` is NaN until metadata is parsed and Infinity for a stream
    // whose length the browser cannot determine — and audio here is *streamed*
    // through /api/audio, which only forwards Content-Length when Supabase sends
    // one. The server refuses both independently, but a non-finite reading must
    // never leave this client in the first place: persisting one would replace
    // "we don't know" with a permanent lie that the write-once rule could never
    // let anyone correct. Bailing out is free — a later 'durationchange' with a
    // real value still heals, because nothing is marked attempted here.
    if (!Number.isFinite(seconds) || seconds <= 0) return

    // Marked BEFORE the request so the second metadata event of the same load
    // cannot double-send, and so a row that cannot be healed is tried once per
    // page view rather than once per event.
    healAttemptedRef.current = true
    void fetch(`/api/share/${encodeURIComponent(shareToken)}/duration`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // versionId can only NARROW what the token resolves to server-side — it
      // is a cross-check, never the thing that authorises the write.
      body: JSON.stringify({ versionId: version.id, duration_seconds: Math.round(seconds) }),
    }).catch(() => { /* offline / navigating away — the next visitor tries again */ })
  }, [shareToken, version.id])

  // Wire audio events
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const onTime = () => setCurrentTime(audio.currentTime)
    const onDuration = () => {
      // Number.isFinite, not isNaN: isNaN(Infinity) is false, so the old test
      // let a non-finite reading through into the time readout.
      setDuration(Number.isFinite(audio.duration) ? audio.duration : 0)
      healDuration(audio)
    }
    const onPlay = () => { setIsPlaying(true); announcePlay('share-player') }
    const onPause = () => { setIsPlaying(false); announceStop('share-player') }
    const onEnded = () => { setIsPlaying(false); announceStop('share-player') }
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('durationchange', onDuration)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('ended', onEnded)
    // Pause when another source (the app's shared player) starts playing.
    const unsubscribe = onOtherSourcePlay('share-player', () => audio.pause())
    // Metadata can already be parsed by the time these listeners attach (a warm
    // cache, or a fast 206 from /api/audio), and no further 'durationchange' is
    // coming for that load. Heal from what the element already knows; the guard
    // inside makes this a no-op when it knows nothing yet.
    healDuration(audio)
    return () => {
      // Unmount kills this player's audio without a 'pause' event.
      announceStop('share-player')
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('durationchange', onDuration)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('ended', onEnded)
      unsubscribe()
    }
    // healDuration is a useCallback over (shareToken, version.id) — both fixed
    // for the life of this page — so this effect still mounts exactly once.
  }, [healDuration])

  const togglePlay = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    if (isPlaying) {
      audio.pause()
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'
    } else {
      applyMediaSession(title, artworkUrl, true, artistName)
      audio.play().catch(() => {})
    }
  }, [isPlaying, title, artworkUrl, artistName])

  const seek = (e: ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = parseFloat(e.target.value)
  }

  const pct = duration > 0 ? (currentTime / duration) * 100 : 0

  return (
    <div className="relative flex-1 flex flex-col overflow-hidden">
      <audio
        ref={audioRef}
        src={audioUrl}
        playsInline
        preload="auto"
        style={{ position: 'fixed', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }}
      />

      {/* ── Blurred artwork backdrop ── */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        {artworkUrl ? (
          <Image
            src={artworkUrl} alt="" fill unoptimized
            className="object-cover"
            style={{ filter: 'blur(16px) saturate(1.6) brightness(0.5)' }}
          />
        ) : (
          <div
            className="absolute inset-0"
            style={{ background: accentCss, filter: 'blur(60px) brightness(0.25)' }}
          />
        )}
        {/* Vignette */}
        <div className="absolute inset-0" style={{
          background: `
            radial-gradient(ellipse 90% 80% at 50% 45%, transparent 0%, rgba(0,0,0,0.45) 60%, rgba(0,0,0,0.85) 100%),
            radial-gradient(ellipse 80% 60% at 50% 50%, rgba(${accent[0]},${accent[1]},${accent[2]},0.15) 0%, transparent 70%)
          `,
        }} />
      </div>

      {/* ── Main player ── */}
      <div className="relative z-10 flex-1 flex flex-col items-center justify-center px-6 py-12 gap-8">

        {/* Artwork */}
        <div
          className="relative w-56 h-56 sm:w-72 sm:h-72 rounded-2xl overflow-hidden flex-shrink-0"
          style={{ boxShadow: `0 32px 80px rgba(${accent[0]},${accent[1]},${accent[2]},0.45), 0 8px 32px rgba(0,0,0,0.7)` }}
        >
          {artworkUrl ? (
            <Image src={artworkUrl} alt={title} fill className="object-cover" unoptimized />
          ) : (
            <div className="absolute inset-0 bg-[#1a1a1a] flex items-center justify-center">
              <CassetteIcon size={64} className="text-[#333]" />
            </div>
          )}
          {/* Project visualizer — loops over the artwork while the track plays
              (artwork stays underneath as the instant frame while the video loads) */}
          {visualizerUrl && (
            <video
              ref={vizVideoRef}
              src={visualizerUrl}
              loop
              muted
              playsInline
              preload="auto"
              className="absolute inset-0 w-full h-full object-cover"
            />
          )}
        </div>

        {/* Title + meta */}
        <div className="text-center">
          <h1 className="text-2xl sm:text-3xl font-bold text-white leading-tight">{title}</h1>
          <p className="text-sm text-white/40 mt-1.5">
            {version.label || `Version ${version.version_number}`}
            {version.status && (
              <span className="ml-2 text-white/25">· {version.status}</span>
            )}
          </p>
        </div>

        {/* Controls */}
        <div className="w-full max-w-xs space-y-5">
          {/* Progress bar */}
          <div className="flex items-center gap-3">
            <span className="text-[11px] font-mono text-white/50 tabular-nums w-10 text-right shrink-0">
              {formatDuration(Math.floor(currentTime))}
            </span>
            <div className="flex-1 relative h-1.5 rounded-full bg-white/15 overflow-hidden">
              <div
                className="absolute inset-y-0 left-0 rounded-full"
                style={{ width: `${pct}%`, background: accentCss }}
              />
              <input
                type="range" min={0} max={duration || 0} step={0.1} value={currentTime}
                onChange={seek}
                className="absolute inset-0 w-full opacity-0 cursor-pointer"
              />
            </div>
            <span className="text-[11px] font-mono text-white/30 tabular-nums w-10 shrink-0">
              {duration > 0 ? `−${formatDuration(Math.max(0, Math.floor(duration - currentTime)))}` : '--:--'}
            </span>
          </div>

          {/* Play / Pause */}
          <div className="flex justify-center">
            <button
              onClick={togglePlay}
              className="w-20 h-20 rounded-full flex items-center justify-center transition-all hover:scale-105 active:scale-95"
              style={{
                background: `linear-gradient(180deg, ${accentCss}, rgba(${accent[0]},${accent[1]},${accent[2]},0.7))`,
                boxShadow: `0 0 40px rgba(${accent[0]},${accent[1]},${accent[2]},0.55), inset 0 1px 0 rgba(255,255,255,0.2)`,
              }}
            >
              {isPlaying
                ? <Pause size={32} fill="#000" className="text-black" />
                : <Play size={32} fill="#000" className="text-black ml-1" />}
            </button>
          </div>

          {/* Download the full-quality original — only when the artist ticked
              "Allow download" on this mix. */}
          {version.allow_download && (
            <div className="flex justify-center">
              <a
                href={downloadHref}
                download={downloadName}
                className="flex items-center gap-1.5 rounded-full border border-white/15 px-4 py-2 text-xs text-white/55 hover:text-white hover:border-white/35 transition-colors"
                title={`Download the full-quality file (${downloadName})`}
              >
                <Download size={13} />
                Download {downloadLabel}
              </a>
            </div>
          )}
        </div>

        {/* Public notes from artist */}
        {version.public_notes && (
          <div
            className="w-full max-w-xs rounded-2xl p-5 border border-white/10"
            style={{ background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(12px)' }}
          >
            <p className="text-[10px] text-white/35 uppercase tracking-wider mb-2">From the artist</p>
            <p className="text-sm text-white/65 leading-relaxed">{version.public_notes}</p>
          </div>
        )}
      </div>

      {/* ── Feedback drawer ── */}
      <div
        className="relative z-10 flex-shrink-0 border-t border-white/10"
        style={{ background: 'rgba(6,4,16,0.88)', backdropFilter: 'blur(24px)' }}
      >
        <button
          onClick={() => setShowFeedback(v => !v)}
          className="w-full flex items-center justify-center gap-2 py-4 text-sm text-white/35 hover:text-white/60 transition-colors"
        >
          <MessageSquare size={14} />
          Leave feedback
          <ChevronDown
            size={14}
            className="transition-transform duration-200"
            style={{ transform: showFeedback ? 'rotate(180deg)' : 'rotate(0deg)' }}
          />
        </button>
        {showFeedback && (
          <div className="px-6 pb-8 max-w-lg mx-auto w-full">
            <FeedbackForm versionId={version.id} currentTime={currentTime} />
          </div>
        )}
      </div>
    </div>
  )
}
