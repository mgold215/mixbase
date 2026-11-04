'use client'

import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useParams } from 'next/navigation'
import Image from 'next/image'
import { Play, Pause, MessageSquare, ChevronDown, Download, PenLine, RotateCcw } from 'lucide-react'
import CassetteIcon from '@/components/CassetteIcon'
import { versionDisplayLabel } from '@/lib/mix-status'
import { audioProxyUrl, displayArtworkUrl, formatDuration } from '@/lib/supabase'
import { extractDominantColor } from '@/lib/audio-analysis'
import { applyMediaSession } from '@/lib/media-session'
import { announcePlay, announceStop, onOtherSourcePlay } from '@/lib/audio-coordinator'
import { audioDownloadFileName } from '@/lib/download'
import FeedbackForm from '@/components/FeedbackForm'
import ShareWaveform from '@/components/ShareWaveform'
import { fetchPeaks, useAudioEnergy, useParallax, usePortrait } from '@/lib/share-fx'

// The public share page renders ONLY these version fields. The loader
// (src/lib/track-share.ts) selects exactly this set and deliberately omits
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
  // The song title in the artist's own handwriting (Cassette Studio lettering,
  // white ink on transparency). Only the platform owner has one; null = type.
  letteringUrl: string | null
}

// One-tap reactions offered when the song ends. They are ordinary feedback
// rows (POST /api/feedback, comment = the label) so they land in the artist's
// feedback list next to written notes — nothing new to store.
const REACTIONS = [
  { emoji: '🔥', label: 'Fire' },
  { emoji: '❤️', label: 'Love it' },
  { emoji: '🔁', label: 'On repeat' },
] as const

// Download naming lives in src/lib/download.ts (audioDownloadFileName) — the
// album share player names its per-track downloads the same way.

export default function ShareClient({ version, artistName, letteringUrl }: Props) {
  // The share token this page was addressed by. Read from the route rather than
  // taken as a prop: the loader deliberately hands this component the MINIMISED
  // public projection of the row (see the Props note above), and the token is
  // not part of it — it is in the URL the visitor already has.
  const params = useParams<{ token?: string }>()
  const shareToken = typeof params?.token === 'string' ? params.token : null

  const rootRef = useRef<HTMLDivElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const drawerRef = useRef<HTMLDivElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const vizVideoRef = useRef<HTMLVideoElement | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [accent, setAccent] = useState<[number, number, number]>([139, 92, 246])
  const [showFeedback, setShowFeedback] = useState(false)
  const [ended, setEnded] = useState(false)
  const [reactionSent, setReactionSent] = useState<string | null>(null)
  const [reactionBusy, setReactionBusy] = useState(false)
  // Waveform: null = loading, [] = unavailable (plain bars), else the peaks.
  // Without a token there is nothing to fetch, so it starts as plain bars.
  const [peaks, setPeaks] = useState<number[] | null>(() => (shareToken ? null : []))
  // "Note at 1:32" — offered after a seek; the time the note would pin to.
  const [notePrompt, setNotePrompt] = useState<number | null>(null)
  const [noteAt, setNoteAt] = useState<number | null>(null)
  const [formKey, setFormKey] = useState(0)
  const portrait = usePortrait()

  const project = version.mb_projects
  const artworkUrl: string | null = displayArtworkUrl(project ?? {})
  // Project visualizers — the 9:16 Canvas loop and the 16:9 one. ?? null
  // because rows can predate the 015/020 migrations until the columns self-heal.
  const loopPortrait: string | null = project?.visualizer_url ?? null
  const loopWide: string | null = project?.visualizer_wide_url ?? null
  // Phones get the vertical loop, laptops the wide one; either stands in for
  // a missing other. The backdrop fills the whole page, Spotify-Canvas style.
  const loopUrl = portrait ? (loopPortrait ?? loopWide) : (loopWide ?? loopPortrait)
  const title: string = project?.title ?? 'Untitled'
  const audioUrl = audioProxyUrl(version.audio_url)
  const accentCss = `rgb(${accent[0]},${accent[1]},${accent[2]})`
  const accentA = (a: number) => `rgba(${accent[0]},${accent[1]},${accent[2]},${a})`
  // Original-quality download, when the artist enabled it on this mix. The
  // audio proxy is same-origin, so the `download` attribute is honoured and
  // ?download=1 makes it a streamed attachment — a 2 GB WAV never buffers.
  const downloadName = audioDownloadFileName(version.audio_url, title)
  const downloadHref = `${audioUrl}?download=1&filename=${encodeURIComponent(downloadName)}`
  const downloadLabel = downloadName.split('.').pop()!.toUpperCase()

  // The muted loop is ambient: it runs from the moment the page opens (muted
  // autoplay is allowed with playsInline) and is nudged again whenever the
  // track starts, for browsers that blocked the autoplay. play() can reject;
  // the poster (the artwork) just stays.
  useEffect(() => {
    const v = vizVideoRef.current
    if (!v) return
    v.play().catch(() => {})
  }, [isPlaying, loopUrl])

  // Extract accent colour from artwork
  useEffect(() => {
    if (artworkUrl) {
      extractDominantColor(artworkUrl).then(setAccent).catch(() => {})
    }
  }, [artworkUrl])

  // ── Waveform peaks ─────────────────────────────────────────────────────────
  // The server decodes the mix once and keeps the peaks on the row; a long mix
  // answers 202 while it is still decoding and fetchPeaks polls for it.
  useEffect(() => {
    if (!shareToken) return
    const controller = new AbortController()
    fetchPeaks(`/api/share/${encodeURIComponent(shareToken)}/peaks`, controller.signal)
      .then(p => { if (!controller.signal.aborted) setPeaks(p) })
    return () => controller.abort()
  }, [shareToken])

  // ── Alive: glow with the music, backdrop follows the mouse ─────────────────
  // Shared with the album player (src/lib/share-fx.ts). pct is computed below;
  // the hook reads it through a ref so the order here does not matter.
  const pct = duration > 0 ? currentTime / duration : 0
  const { ensureAnalyser } = useAudioEnergy({ audioRef, rootRef, isPlaying, peaks, progress: pct })
  useParallax(rootRef, backdropRef)

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
    const onPlay = () => {
      setIsPlaying(true)
      setEnded(false)
      announcePlay('share-player')
    }
    const onPause = () => { setIsPlaying(false); announceStop('share-player') }
    const onEnded = () => { setIsPlaying(false); setEnded(true); announceStop('share-player') }
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
      ensureAnalyser()
      applyMediaSession(title, artworkUrl, true, artistName)
      audio.play().catch(() => {})
    }
  }, [isPlaying, title, artworkUrl, artistName, ensureAnalyser])

  const seekTo = useCallback((fraction: number) => {
    const audio = audioRef.current
    if (!audio || !(duration > 0)) return
    const t = fraction * duration
    audio.currentTime = t
    setCurrentTime(t)
  }, [duration])

  // Landing somewhere on the waveform is the moment to offer a pinned note.
  const noteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const offerNote = useCallback((fraction: number) => {
    if (!(duration > 0)) return
    const at = Math.floor(fraction * duration)
    if (at < 1) { setNotePrompt(null); return }
    setNotePrompt(at)
    clearTimeout(noteTimer.current)
    noteTimer.current = setTimeout(() => setNotePrompt(null), 7000)
  }, [duration])

  const openNote = useCallback((at: number | null) => {
    setNoteAt(at)
    setFormKey(k => k + 1)
    setShowFeedback(true)
    setNotePrompt(null)
    setTimeout(() => drawerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }), 50)
  }, [])

  const playAgain = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = 0
    setEnded(false)
    audio.play().catch(() => {})
  }, [])

  const sendReaction = useCallback(async (reaction: (typeof REACTIONS)[number]) => {
    if (reactionBusy || reactionSent) return
    setReactionBusy(true)
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version_id: version.id, reviewer_name: 'Anonymous', comment: `${reaction.emoji} ${reaction.label}` }),
      })
      if (res.ok) setReactionSent(reaction.label)
    } catch { /* nothing to show — the buttons simply stay */ }
    setReactionBusy(false)
  }, [reactionBusy, reactionSent, version.id])

  const hasLoop = !!loopUrl
  // The cover steps back a little when a loop fills the screen behind it.
  const coverSize = hasLoop ? 'w-44 h-44 sm:w-60 sm:h-60' : 'w-56 h-56 sm:w-72 sm:h-72'

  return (
    <div
      ref={rootRef}
      className="relative flex-1 flex flex-col overflow-hidden"
      style={{ '--energy': 0 } as React.CSSProperties}
    >
      <audio
        ref={audioRef}
        src={audioUrl}
        playsInline
        preload="auto"
        style={{ position: 'fixed', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }}
      />

      {/* ── Backdrop: the visualizer loop full-screen, else the art, drifting ── */}
      <div ref={backdropRef} className="absolute inset-0 pointer-events-none overflow-hidden" style={{ transition: 'transform 0.6s ease-out' }}>
        {hasLoop ? (
          <video
            ref={vizVideoRef}
            key={loopUrl}
            src={loopUrl!}
            poster={artworkUrl ?? undefined}
            autoPlay
            loop
            muted
            playsInline
            preload="auto"
            className="absolute inset-0 w-full h-full object-cover"
            style={{ transform: 'scale(1.04)' }}
          />
        ) : artworkUrl ? (
          <Image
            src={artworkUrl} alt="" fill unoptimized
            className="object-cover share-drift"
            style={{ filter: 'blur(18px) saturate(1.6) brightness(0.5)' }}
          />
        ) : (
          <div
            className="absolute inset-0 share-drift"
            style={{ background: accentCss, filter: 'blur(60px) brightness(0.25)' }}
          />
        )}
        {/* Vignette + an accent wash that brightens with the music */}
        <div className="absolute inset-0" style={{
          background: `
            radial-gradient(ellipse 90% 80% at 50% 45%, transparent 0%, rgba(0,0,0,${hasLoop ? 0.35 : 0.45}) 60%, rgba(0,0,0,${hasLoop ? 0.8 : 0.85}) 100%),
            radial-gradient(ellipse 80% 60% at 50% 50%, ${accentA(0.18)} 0%, transparent 70%)
          `,
        }} />
        <div className="absolute inset-0" style={{
          background: `radial-gradient(ellipse 60% 50% at 50% 55%, ${accentA(0.35)} 0%, transparent 70%)`,
          opacity: 'calc(var(--energy) * 0.9)',
        }} />
      </div>

      {/* ── Main player ── */}
      <div className="relative z-10 flex-1 flex flex-col items-center justify-center px-6 py-10 gap-7">

        {/* Artwork — breathes with the music */}
        <div
          className={`share-in relative ${coverSize} rounded-2xl overflow-hidden flex-shrink-0`}
          style={{
            animationDelay: '80ms',
            boxShadow: `0 32px 80px ${accentA(0.45)}, 0 8px 32px rgba(0,0,0,0.7)`,
          }}
        >
          <div
            className="absolute inset-0"
            style={{ transform: 'scale(calc(1 + var(--energy) * 0.035))', transition: 'transform 90ms linear' }}
          >
            {artworkUrl ? (
              <Image src={artworkUrl} alt={title} fill className="object-cover" unoptimized priority />
            ) : (
              <div className="absolute inset-0 bg-[#1a1a1a] flex items-center justify-center">
                <CassetteIcon size={64} className="text-[#333]" />
              </div>
            )}
          </div>
        </div>

        {/* Title + meta — the artist's own handwriting when there is one */}
        <div className="share-in text-center" style={{ animationDelay: '260ms' }}>
          {letteringUrl ? (
            <>
              <div className="relative mx-auto h-16 sm:h-24 w-[min(84vw,620px)]">
                <Image
                  src={letteringUrl} alt={title} fill unoptimized
                  className="object-contain"
                  style={{ filter: 'drop-shadow(0 2px 12px rgba(0,0,0,0.6))' }}
                />
              </div>
              <h1 className="sr-only">{title}</h1>
            </>
          ) : (
            <h1 className="text-2xl sm:text-3xl font-bold text-white leading-tight" style={{ textShadow: '0 2px 18px rgba(0,0,0,0.6)' }}>{title}</h1>
          )}
          <p className="text-sm text-white/45 mt-2">
            <span className="text-white/70">{artistName}</span>
            <span className="mx-2 text-white/25">·</span>
            {versionDisplayLabel(version)}
            {version.status && (
              <span className="ml-2 text-white/25">· {version.status}</span>
            )}
          </p>
        </div>

        {/* Controls */}
        <div className="share-in w-full max-w-md space-y-5" style={{ animationDelay: '420ms' }}>
          {/* Waveform */}
          <div className="relative">
            <div className="flex items-center gap-3">
              <span className="text-[11px] font-mono text-white/50 tabular-nums w-10 text-right shrink-0">
                {formatDuration(Math.floor(currentTime))}
              </span>
              <div className="flex-1 h-14">
                {peaks === null ? (
                  <div className="h-full flex items-center">
                    <div className="share-shimmer h-1.5 w-full rounded-full" />
                  </div>
                ) : (
                  <ShareWaveform
                    peaks={peaks}
                    progress={pct}
                    accent={accent}
                    onSeek={seekTo}
                    onSeekEnd={offerNote}
                    className="h-full w-full"
                  />
                )}
              </div>
              <span className="text-[11px] font-mono text-white/30 tabular-nums w-10 shrink-0">
                {duration > 0 ? `−${formatDuration(Math.max(0, Math.floor(duration - currentTime)))}` : '--:--'}
              </span>
            </div>
            {/* Offered after a seek: pin a note to that moment */}
            {notePrompt != null && !showFeedback && (
              <div className="absolute left-0 right-0 -bottom-7 flex justify-center">
                <button
                  onClick={() => openNote(notePrompt)}
                  className="share-in inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-medium text-black"
                  style={{ background: accentCss, animationDuration: '0.35s' }}
                >
                  <PenLine size={11} />
                  Note at {formatDuration(notePrompt)}
                </button>
              </div>
            )}
          </div>

          {/* Play / Pause — the glow swells with the music */}
          <div className="flex justify-center pt-2">
            <button
              onClick={togglePlay}
              aria-label={isPlaying ? 'Pause' : 'Play'}
              className="w-20 h-20 rounded-full flex items-center justify-center transition-transform hover:scale-105 active:scale-95"
              style={{
                background: `linear-gradient(180deg, ${accentCss}, ${accentA(0.7)})`,
                boxShadow: `0 0 calc(40px + var(--energy) * 50px) ${accentA(0.55)}, 0 0 calc(var(--energy) * 120px) ${accentA(0.35)}, inset 0 1px 0 rgba(255,255,255,0.2)`,
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

        {/* When the song ends: one tap says what you thought */}
        {ended && (
          <div
            className="share-in w-full max-w-xs rounded-2xl p-5 border border-white/10 text-center"
            style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(16px)', animationDuration: '0.5s' }}
          >
            {reactionSent ? (
              <>
                <p className="text-sm text-white">Sent to {artistName}. Thank you.</p>
                <div className="mt-4 flex items-center justify-center gap-3">
                  <button onClick={() => openNote(null)} className="text-xs text-white/60 hover:text-white underline-offset-4 hover:underline">Add a note</button>
                  <span className="text-white/20">·</span>
                  <button onClick={playAgain} className="inline-flex items-center gap-1 text-xs text-white/60 hover:text-white"><RotateCcw size={12} /> Play again</button>
                </div>
              </>
            ) : (
              <>
                <p className="text-[10px] text-white/40 uppercase tracking-wider">That was {title}</p>
                <p className="text-sm text-white mt-1">What did you think?</p>
                <div className="mt-4 grid grid-cols-3 gap-2">
                  {REACTIONS.map(r => (
                    <button
                      key={r.label}
                      onClick={() => sendReaction(r)}
                      disabled={reactionBusy}
                      className="rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 active:scale-95 transition py-3 flex flex-col items-center gap-1 disabled:opacity-50"
                    >
                      <span className="text-2xl leading-none">{r.emoji}</span>
                      <span className="text-[11px] text-white/70">{r.label}</span>
                    </button>
                  ))}
                </div>
                <div className="mt-3 flex items-center justify-center gap-3">
                  <button onClick={() => openNote(null)} className="text-xs text-white/60 hover:text-white underline-offset-4 hover:underline">Tell them more</button>
                  <span className="text-white/20">·</span>
                  <button onClick={playAgain} className="inline-flex items-center gap-1 text-xs text-white/60 hover:text-white"><RotateCcw size={12} /> Play again</button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Public notes from artist */}
        {version.public_notes && (
          <div
            className="share-in w-full max-w-xs rounded-2xl p-5 border border-white/10"
            style={{ animationDelay: '560ms', background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(12px)' }}
          >
            <p className="text-[10px] text-white/35 uppercase tracking-wider mb-2">From the artist</p>
            <p className="text-sm text-white/65 leading-relaxed">{version.public_notes}</p>
          </div>
        )}
      </div>

      {/* ── Feedback drawer ── */}
      <div
        ref={drawerRef}
        className="share-in relative z-10 flex-shrink-0 border-t border-white/10"
        style={{ animationDelay: '700ms', background: 'rgba(6,4,16,0.88)', backdropFilter: 'blur(24px)' }}
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
            <FeedbackForm key={formKey} versionId={version.id} currentTime={currentTime} initialPinnedAt={noteAt ?? undefined} />
          </div>
        )}
      </div>
    </div>
  )
}
