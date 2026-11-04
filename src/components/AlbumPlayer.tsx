'use client'

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useParams } from 'next/navigation'
import Image from 'next/image'
import { Play, Pause, SkipBack, SkipForward, Download, MessageSquare, ChevronDown, PenLine, RotateCcw } from 'lucide-react'
import CassetteIcon from '@/components/CassetteIcon'
import { audioProxyUrl, formatDuration } from '@/lib/supabase'
import { audioDownloadFileName } from '@/lib/download'
import { extractDominantColor } from '@/lib/audio-analysis'
import { applyMediaSession } from '@/lib/media-session'
import { announcePlay, announceStop, onOtherSourcePlay, claimMediaSession, ownsMediaSession, releaseMediaSession } from '@/lib/audio-coordinator'
import ShareWaveform from '@/components/ShareWaveform'
import FeedbackForm from '@/components/FeedbackForm'
import { fetchPeaks, useAudioEnergy, useParallax, usePortrait } from '@/lib/share-fx'

// Full-album player used by both the public /album/<artist>/<title>/<token>
// page and the logged-in collection view: the current track's visualizer loop
// (or its art, drifting) fills the screen, an accent theme follows the art,
// transport with auto-advance, and a tracklist with per-track artwork. Tracks
// without an uploaded mix (audioUrl null) are listed but muted — playback and
// auto-advance skip over them.
//
// On the PUBLIC page (an album token in the URL) the listener also gets the
// real waveform of each track, "Note at 1:32", a per-track feedback drawer and
// one-tap reactions when the album ends. The signed-in view has none of those:
// it is the artist's own page.

export type AlbumPlayerTrack = {
  id: string
  title: string
  genre: string | null
  artworkUrl: string | null
  visualizerUrl: string | null
  /** The 16:9 loop, for a laptop; optional, the 9:16 one stands in. */
  visualizerWideUrl?: string | null
  audioUrl: string | null
  duration: number | null
  /** Artist ticked "Allow download" on this mix — row shows a download link
   *  for the full-quality original. Optional: the signed-in collection view
   *  doesn't pass it, and absent means no link (same gate as /share/[token]). */
  allowDownload?: boolean
}

type Props = {
  title: string
  typeLabel: string
  coverUrl: string | null
  artistName: string
  tracks: AlbumPlayerTrack[]
  /** audio-coordinator source id — unique per mount site */
  sourceId?: string
  /** small line under the tracklist, e.g. "Shared privately via mixBASE" */
  footnote?: string | null
}

// One-tap reactions offered when the album ends (public page only). Ordinary
// feedback rows on the track that just finished, so they land in the artist's
// feedback list next to written notes.
const REACTIONS = [
  { emoji: '🔥', label: 'Fire' },
  { emoji: '❤️', label: 'Love it' },
  { emoji: '🔁', label: 'On repeat' },
] as const

export default function AlbumPlayer({ title, typeLabel, coverUrl, artistName, tracks, sourceId = 'album-player', footnote }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const drawerRef = useRef<HTMLDivElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const vizVideoRef = useRef<HTMLVideoElement | null>(null)
  const [index, setIndex] = useState(() => {
    const first = tracks.findIndex(t => t.audioUrl)
    return first === -1 ? 0 : first
  })
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [accent, setAccent] = useState<[number, number, number]>([139, 92, 246])
  // Set when a track change should start playback once the new src is committed
  // (row click, next/prev, auto-advance) — a plain src swap alone stays paused.
  const pendingPlay = useRef(false)
  // Latest transport callbacks for the media-session handlers, which are
  // registered once per 'play' event and must not go stale between renders.
  const controlsRef = useRef({ next: () => {}, prev: () => {}, toggle: () => {} })
  // Public-page extras.
  const [peaks, setPeaks] = useState<number[] | null>(null)
  const peaksCache = useRef<Map<string, number[]>>(new Map())
  const [notePrompt, setNotePrompt] = useState<number | null>(null)
  const [noteAt, setNoteAt] = useState<number | null>(null)
  const [showFeedback, setShowFeedback] = useState(false)
  const [formKey, setFormKey] = useState(0)
  const [albumEnded, setAlbumEnded] = useState(false)
  const [reactionSent, setReactionSent] = useState<string | null>(null)
  const [reactionBusy, setReactionBusy] = useState(false)
  const portrait = usePortrait()

  const current: AlbumPlayerTrack | undefined = tracks[index]
  const displayArt = current?.artworkUrl ?? coverUrl
  const accentCss = `rgb(${accent[0]},${accent[1]},${accent[2]})`
  const accentA = (a: number) => `rgba(${accent[0]},${accent[1]},${accent[2]},${a})`
  // The current track's loop fills the page: the 9:16 one on a phone, the
  // 16:9 one on a laptop, either standing in for a missing other.
  const loopUrl = current
    ? (portrait ? (current.visualizerUrl ?? current.visualizerWideUrl ?? null) : (current.visualizerWideUrl ?? current.visualizerUrl ?? null))
    : null
  const hasLoop = !!loopUrl

  // Total runtime for the header — only shown when every playable track
  // reported one, so a missing duration can't display as a too-short total.
  const totalDuration = useMemo(() => {
    const playable = tracks.filter(t => t.audioUrl)
    if (playable.length === 0 || playable.some(t => t.duration == null)) return null
    return playable.reduce((sum, t) => sum + (t.duration ?? 0), 0)
  }, [tracks])

  // Nearest playable track index from `from` in `dir`, or -1. wrap=false stops
  // at the list edge (used by auto-advance so the album ends after the last song).
  const findPlayable = useCallback((from: number, dir: 1 | -1, wrap: boolean): number => {
    for (let step = 1; step <= tracks.length; step++) {
      const i = from + dir * step
      if (!wrap && (i < 0 || i >= tracks.length)) return -1
      const wrapped = ((i % tracks.length) + tracks.length) % tracks.length
      if (tracks[wrapped]?.audioUrl) return wrapped
    }
    return -1
  }, [tracks])

  // The muted loop is ambient: it runs from the moment the page opens (muted
  // autoplay is allowed with playsInline) and is nudged again whenever a track
  // starts, for browsers that blocked the autoplay. play() can reject; the
  // poster (the art) just stays.
  useEffect(() => {
    const v = vizVideoRef.current
    if (!v) return
    v.play().catch(() => {})
  }, [isPlaying, index, loopUrl])

  // Accent colour follows the current track's artwork.
  useEffect(() => {
    if (displayArt) {
      extractDominantColor(displayArt).then(setAccent).catch(() => {})
    }
  }, [displayArt])

  // Claim the lock-screen / headphone transport for THIS player: without this,
  // "next" from the lock screen drives PlayerContext's app-wide queue instead
  // of the album. Called on every 'play' event; PlayerContext takes the
  // handlers back the moment its own audio plays.
  const claimTransport = useCallback(() => {
    claimMediaSession(sourceId)
    if (!('mediaSession' in navigator)) return
    const set = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try { navigator.mediaSession.setActionHandler(action, handler) } catch { /* unsupported */ }
    }
    set('play',          () => { audioRef.current?.play().catch(() => {}) })
    set('pause',         () => { audioRef.current?.pause() })
    set('previoustrack', () => controlsRef.current.prev())
    set('nexttrack',     () => controlsRef.current.next())
    set('seekto',        d => { if (d.seekTime != null && audioRef.current) audioRef.current.currentTime = d.seekTime })
    // No seekforward/seekbackward: registering them makes iOS show ±10s skip
    // buttons instead of next/previous-track (same gotcha as PlayerContext).
    set('seekforward',   null)
    set('seekbackward',  null)
  }, [sourceId])

  // On unmount, hand the transport back if we still hold it — otherwise the
  // lock screen keeps controls wired to a player that no longer exists.
  // PlayerContext re-registers on its next 'play' (or effect re-run).
  useEffect(() => () => {
    // Navigating away kills this player's audio without a 'pause' event —
    // announce the stop so the mini player can reappear.
    announceStop(sourceId)
    if (!ownsMediaSession(sourceId)) return
    releaseMediaSession(sourceId)
    if (!('mediaSession' in navigator)) return
    ;(['play', 'pause', 'previoustrack', 'nexttrack', 'seekto'] as MediaSessionAction[]).forEach(a => {
      try { navigator.mediaSession.setActionHandler(a, null) } catch { /* unsupported */ }
    })
  }, [sourceId])

  // ── Self-healing duration backfill (public half) ───────────────────────────
  // 145 of 364 mb_versions rows have duration_seconds NULL, and this player
  // shows the damage plainly: `totalDuration` above refuses to display an album
  // runtime at all if ANY track's duration is missing, and those rows render a
  // blank cell in the tracklist. The signed-in surfaces heal through
  // PlayerContext → PATCH /api/versions/[id], but the public album page has no
  // session, so it could never reach that route.
  //
  // POST /api/share/<token>/duration accepts the reading under the authority of
  // the album token in the address bar. Two properties of this component shape
  // the call:
  //
  //  · A track here is identified by its PROJECT id — `AlbumPlayerTrack.id` is
  //    `mb_collection_items.project_id` (see src/lib/album-share.ts); the album
  //    payload carries no version ids at all. So the request names the project
  //    and the SERVER resolves the version, exactly as the album loader does
  //    (newest mix of that project). The client never gets to name a row.
  //  · Only tracks whose stored `duration` is null are ever posted. A healed
  //    catalogue makes no requests.
  const params = useParams<{ token?: string }>()
  // Present only on the public /album/<artist>/<title>/<token> route. The other
  // mount site (/collections/<id>, signed in) has no token param, so it simply
  // never heals through the public door — which is correct: that page is the
  // artist's own, and its healing belongs to the authenticated path.
  const albumToken = typeof params?.token === 'string' ? params.token : null
  const healAttemptedRef = useRef<Set<string>>(new Set())
  const healDuration = useCallback((audio: HTMLAudioElement, track: AlbumPlayerTrack | undefined) => {
    if (!albumToken || !track) return
    // Nothing to heal — the row already has a length.
    if (track.duration != null) return
    if (healAttemptedRef.current.has(track.id)) return

    const seconds = audio.duration
    // THE guard. `duration` is NaN until metadata is parsed and Infinity for a
    // stream whose length the browser cannot determine — and every mix here is
    // *streamed* through /api/audio, which only forwards Content-Length when
    // Supabase sends one. The server refuses both independently; this stops one
    // ever leaving the client, because the write is once-only and a stored lie
    // could never afterwards be corrected. Not marking `attempted` here is
    // deliberate: a later 'durationchange' carrying a real value still heals.
    if (!Number.isFinite(seconds) || seconds <= 0) return

    // Marked BEFORE the request: auto-advance and the metadata events of one
    // load would otherwise fire this several times for the same track.
    healAttemptedRef.current.add(track.id)
    void fetch(`/api/share/${encodeURIComponent(albumToken)}/duration`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: track.id, duration_seconds: Math.round(seconds) }),
    }).catch(() => { /* offline / navigating away — the next listener tries again */ })
  }, [albumToken])

  // ── Waveform of the current track (public page only) ──────────────────────
  // GET /api/share/<token>/peaks?project=<id> — the server resolves the track's
  // newest mix, decodes it once and keeps the peaks. Cached per track for the
  // life of the page so going back to a song is instant. Without a token
  // (the signed-in view) the scrubber draws plain bars.
  useEffect(() => {
    const track = tracks[index]
    if (!albumToken || !track?.audioUrl) { setPeaks([]); return }
    const cached = peaksCache.current.get(track.id)
    if (cached) { setPeaks(cached); return }
    setPeaks(null)
    const controller = new AbortController()
    fetchPeaks(`/api/share/${encodeURIComponent(albumToken)}/peaks?project=${encodeURIComponent(track.id)}`, controller.signal)
      .then(p => {
        if (controller.signal.aborted) return
        if (p.length > 0) peaksCache.current.set(track.id, p)
        setPeaks(p)
      })
    return () => controller.abort()
  }, [albumToken, index, tracks])

  // ── Alive: glow with the music, backdrop follows the mouse ─────────────────
  const pct = duration > 0 ? currentTime / duration : 0
  const { ensureAnalyser } = useAudioEnergy({ audioRef, rootRef, isPlaying, peaks, progress: pct })
  useParallax(rootRef, backdropRef)

  // Wire audio events. Depends on `index` so onEnded always advances from the
  // track that actually finished (re-binding on change is cheap).
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const track = tracks[index]
    const onTime = () => {
      setCurrentTime(audio.currentTime)
      // Keep the lock-screen scrubber honest while we hold the transport.
      if (ownsMediaSession(sourceId) && 'mediaSession' in navigator) {
        const d = audio.duration
        if (Number.isFinite(d) && d > 0) {
          try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(audio.currentTime, d), playbackRate: 1 }) } catch { /* position race */ }
        }
      }
    }
    const onDuration = () => {
      // Number.isFinite, not isNaN: isNaN(Infinity) is false, so the old test
      // let a non-finite reading through into the time readout and the scrubber.
      setDuration(Number.isFinite(audio.duration) ? audio.duration : 0)
      healDuration(audio, track)
    }
    const onPlay = () => {
      setIsPlaying(true)
      setAlbumEnded(false)
      announcePlay(sourceId)
      claimTransport()
      // Re-apply metadata on every play so auto-advance updates the lock
      // screen too (playTrackAt only covers explicit taps).
      if (track) applyMediaSession(track.title, track.artworkUrl ?? coverUrl, true, artistName)
    }
    const onPause = () => {
      setIsPlaying(false)
      announceStop(sourceId)
      if (ownsMediaSession(sourceId) && 'mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'
    }
    const onEnded = () => {
      const next = findPlayable(index, 1, false)
      if (next !== -1) {
        pendingPlay.current = true
        setIndex(next)
      } else {
        setIsPlaying(false)
        setAlbumEnded(true)
        announceStop(sourceId)
      }
    }
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('durationchange', onDuration)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('ended', onEnded)
    // Pause when another source (the app's shared player) starts playing.
    const unsubscribe = onOtherSourcePlay(sourceId, () => audio.pause())
    // This effect re-binds on every track change, and metadata for the new src
    // can already be parsed by the time it does (warm cache, fast 206) — no
    // further 'durationchange' is coming for that load. Heal from what the
    // element already knows; the guard inside no-ops when it knows nothing yet.
    healDuration(audio, track)
    return () => {
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('durationchange', onDuration)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('ended', onEnded)
      unsubscribe()
    }
  }, [index, tracks, findPlayable, sourceId, claimTransport, coverUrl, artistName, healDuration])

  // After a track change commits (new src is on the element), start playback
  // if the change came from an explicit play intent.
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    setCurrentTime(0)
    setNotePrompt(null)
    // Prefer the element's real duration when metadata already loaded (its
    // durationchange can fire before our listeners attach); fall back to the
    // stored value so the time readout isn't blank while the file loads.
    const loaded = audio.duration
    setDuration(Number.isFinite(loaded) && loaded > 0 ? loaded : tracks[index]?.duration ?? 0)
    if (pendingPlay.current) {
      pendingPlay.current = false
      audio.play().catch(() => {})
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index])

  const playTrackAt = useCallback((i: number) => {
    const track = tracks[i]
    if (!track?.audioUrl) return
    if (i === index) {
      const audio = audioRef.current
      if (!audio) return
      if (isPlaying) {
        audio.pause()
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'
      } else {
        // Must run synchronously before play() so iOS registers the metadata
        // inside the user-gesture context.
        ensureAnalyser()
        applyMediaSession(track.title, track.artworkUrl ?? coverUrl, true, artistName)
        audio.play().catch(() => {})
      }
      return
    }
    ensureAnalyser()
    applyMediaSession(track.title, track.artworkUrl ?? coverUrl, true, artistName)
    pendingPlay.current = true
    setIndex(i)
  }, [tracks, index, isPlaying, coverUrl, artistName, ensureAnalyser])

  const togglePlay = useCallback(() => playTrackAt(index), [playTrackAt, index])

  const nextTrack = useCallback(() => {
    const next = findPlayable(index, 1, true)
    if (next !== -1 && next !== index) playTrackAt(next)
  }, [findPlayable, index, playTrackAt])

  const prevTrack = useCallback(() => {
    const audio = audioRef.current
    // Standard player behavior: restart the current track unless we're at the top of it.
    if (audio && audio.currentTime > 3) {
      audio.currentTime = 0
      return
    }
    const prev = findPlayable(index, -1, true)
    if (prev !== -1 && prev !== index) playTrackAt(prev)
    else if (audio) audio.currentTime = 0
  }, [findPlayable, index, playTrackAt])

  // Keep the media-session handlers pointed at fresh callbacks — they're
  // registered once per 'play' event, not per render.
  useEffect(() => {
    controlsRef.current = { next: nextTrack, prev: prevTrack, toggle: togglePlay }
  }, [nextTrack, prevTrack, togglePlay])

  const seekTo = useCallback((fraction: number) => {
    const audio = audioRef.current
    if (!audio || !(duration > 0)) return
    const t = fraction * duration
    audio.currentTime = t
    setCurrentTime(t)
  }, [duration])

  // Landing somewhere on the waveform is the moment to offer a pinned note
  // (public page only — the signed-in view has no listener to ask).
  const noteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const offerNote = useCallback((fraction: number) => {
    if (!albumToken || !(duration > 0)) return
    const at = Math.floor(fraction * duration)
    if (at < 1) { setNotePrompt(null); return }
    setNotePrompt(at)
    clearTimeout(noteTimer.current)
    noteTimer.current = setTimeout(() => setNotePrompt(null), 7000)
  }, [albumToken, duration])

  const openNote = useCallback((at: number | null) => {
    setNoteAt(at)
    setFormKey(k => k + 1)
    setShowFeedback(true)
    setNotePrompt(null)
    setTimeout(() => drawerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }), 50)
  }, [])

  const playAgain = useCallback(() => {
    setAlbumEnded(false)
    const first = tracks.findIndex(t => t.audioUrl)
    if (first === -1) return
    if (first === index) {
      const audio = audioRef.current
      if (!audio) return
      audio.currentTime = 0
      audio.play().catch(() => {})
    } else {
      playTrackAt(first)
    }
  }, [tracks, index, playTrackAt])

  const sendReaction = useCallback(async (reaction: (typeof REACTIONS)[number]) => {
    const track = tracks[index]
    if (!albumToken || !track || reactionBusy || reactionSent) return
    setReactionBusy(true)
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          share_token: albumToken,
          project_id: track.id,
          reviewer_name: 'Anonymous',
          comment: `${reaction.emoji} ${reaction.label} — the whole ${typeLabel.toLowerCase()} "${title}"`,
        }),
      })
      if (res.ok) setReactionSent(reaction.label)
    } catch { /* nothing to show — the buttons simply stay */ }
    setReactionBusy(false)
  }, [albumToken, tracks, index, reactionBusy, reactionSent, typeLabel, title])

  const currentPlayable = !!current?.audioUrl

  // ── Empty state: no tracks at all ──
  if (!current) {
    return (
      <div className="relative flex-1 flex flex-col items-center justify-center gap-6 px-6 py-16">
        <div className="relative w-48 h-48 rounded-2xl overflow-hidden" style={{ backgroundColor: '#141414' }}>
          {coverUrl ? (
            <Image src={coverUrl} alt={title} fill className="object-cover" unoptimized />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center">
              <CassetteIcon size={56} className="text-[#333]" />
            </div>
          )}
        </div>
        <div className="text-center">
          <p className="text-[11px] uppercase tracking-[0.2em] text-white/35 mb-2">{typeLabel}</p>
          <h1 className="text-2xl font-bold text-white">{title}</h1>
          <p className="text-sm text-white/40 mt-1">{artistName}</p>
          <p className="text-sm text-white/40 mt-3">No playable tracks yet — check back soon.</p>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      className="relative flex-1 flex flex-col overflow-hidden"
      style={{ '--energy': 0 } as React.CSSProperties}
    >
      {currentPlayable && (
        <audio
          ref={audioRef}
          src={audioProxyUrl(current.audioUrl!)}
          playsInline
          preload="auto"
          style={{ position: 'fixed', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }}
        />
      )}

      {/* Equalizer bars for the playing row */}
      <style>{`@keyframes mb-eq { 0%, 100% { height: 30%; } 50% { height: 100%; } }`}</style>

      {/* ── Backdrop: the current track's loop full-screen, else its art, drifting ── */}
      <div ref={backdropRef} className="absolute inset-0 pointer-events-none overflow-hidden" style={{ transition: 'transform 0.6s ease-out' }}>
        {hasLoop ? (
          <video
            ref={vizVideoRef}
            key={loopUrl}
            src={loopUrl!}
            poster={displayArt ?? undefined}
            autoPlay
            loop
            muted
            playsInline
            preload="auto"
            className="absolute inset-0 w-full h-full object-cover"
            style={{ transform: 'scale(1.04)' }}
          />
        ) : displayArt ? (
          <Image
            key={displayArt}
            src={displayArt} alt="" fill unoptimized
            className="object-cover share-drift transition-opacity duration-700"
            style={{ filter: 'blur(18px) saturate(1.6) brightness(0.45)' }}
          />
        ) : (
          <div
            className="absolute inset-0 share-drift"
            style={{ background: accentCss, filter: 'blur(60px) brightness(0.25)' }}
          />
        )}
        <div className="absolute inset-0" style={{
          background: `
            radial-gradient(ellipse 90% 80% at 50% 45%, transparent 0%, rgba(0,0,0,${hasLoop ? 0.4 : 0.5}) 60%, rgba(0,0,0,${hasLoop ? 0.82 : 0.88}) 100%),
            radial-gradient(ellipse 80% 60% at 50% 50%, ${accentA(0.14)} 0%, transparent 70%)
          `,
        }} />
        {/* An accent wash that brightens with the music */}
        <div className="absolute inset-0" style={{
          background: `radial-gradient(ellipse 60% 50% at 35% 55%, ${accentA(0.32)} 0%, transparent 70%)`,
          opacity: 'calc(var(--energy) * 0.9)',
        }} />
      </div>

      {/* ── Content ── */}
      <div className="relative z-10 flex-1 w-full max-w-6xl mx-auto px-5 sm:px-8 py-8 sm:py-10 flex flex-col lg:flex-row lg:items-center gap-8 lg:gap-14">

        {/* Now playing */}
        <div className="flex flex-col items-center gap-6 lg:flex-1 lg:min-w-0">
          <div
            className={`share-in relative ${hasLoop ? 'w-44 h-44 sm:w-56 sm:h-56 xl:w-72 xl:h-72' : 'w-52 h-52 sm:w-64 sm:h-64 xl:w-80 xl:h-80'} rounded-2xl overflow-hidden flex-shrink-0`}
            style={{ animationDelay: '80ms', boxShadow: `0 32px 80px ${accentA(0.4)}, 0 8px 32px rgba(0,0,0,0.7)` }}
          >
            <div
              className="absolute inset-0"
              style={{ transform: 'scale(calc(1 + var(--energy) * 0.035))', transition: 'transform 90ms linear' }}
            >
              {current.artworkUrl ?? coverUrl ? (
                <Image
                  key={displayArt ?? current.id}
                  src={(current.artworkUrl ?? coverUrl)!}
                  alt={current.title} fill className="object-cover" unoptimized
                />
              ) : (
                <div className="absolute inset-0 bg-[#1a1a1a] flex items-center justify-center">
                  <CassetteIcon size={64} className="text-[#333]" />
                </div>
              )}
            </div>
          </div>

          <div className="share-in text-center max-w-sm" style={{ animationDelay: '260ms' }}>
            <p className="text-[11px] uppercase tracking-[0.2em] text-white/35 mb-1.5">
              {typeLabel} · {title}
            </p>
            <h1 className="text-xl sm:text-2xl font-bold text-white leading-tight truncate" style={{ textShadow: '0 2px 18px rgba(0,0,0,0.6)' }}>{current.title}</h1>
            {/* Artist stays in its natural case — no uppercase transform here */}
            <p className="text-sm text-white/40 mt-1 truncate">{artistName}</p>
          </div>

          {/* Waveform + transport */}
          <div className="share-in w-full max-w-sm space-y-5" style={{ animationDelay: '420ms' }}>
            <div className="relative">
              <div className="flex items-center gap-3">
                <span className="text-[11px] font-mono text-white/50 tabular-nums w-10 text-right shrink-0">
                  {/* formatDuration renders 0 as "--:--"; before playback starts 0:00 is correct */}
                  {currentTime >= 1 ? formatDuration(Math.floor(currentTime)) : '0:00'}
                </span>
                <div className="flex-1 h-12">
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

            <div className="flex items-center justify-center gap-6 pt-1">
              <button
                onClick={prevTrack}
                className="p-2 text-white/70 hover:text-white transition-colors"
                title="Previous"
              >
                <SkipBack size={24} fill="currentColor" />
              </button>
              <button
                onClick={togglePlay}
                className="w-16 h-16 sm:w-[4.5rem] sm:h-[4.5rem] rounded-full flex items-center justify-center transition-transform hover:scale-105 active:scale-95 disabled:opacity-40"
                disabled={!currentPlayable}
                style={{
                  background: `linear-gradient(180deg, ${accentCss}, ${accentA(0.7)})`,
                  boxShadow: `0 0 calc(40px + var(--energy) * 50px) ${accentA(0.5)}, 0 0 calc(var(--energy) * 120px) ${accentA(0.35)}, inset 0 1px 0 rgba(255,255,255,0.2)`,
                }}
                title={isPlaying ? 'Pause' : 'Play'}
              >
                {isPlaying
                  ? <Pause size={28} fill="#000" className="text-black" />
                  : <Play size={28} fill="#000" className="text-black ml-1" />}
              </button>
              <button
                onClick={nextTrack}
                className="p-2 text-white/70 hover:text-white transition-colors"
                title="Next"
              >
                <SkipForward size={24} fill="currentColor" />
              </button>
            </div>
          </div>

          {/* When the album ends (public page): one tap says what you thought */}
          {albumToken && albumEnded && (
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
        </div>

        {/* Tracklist */}
        <div className="share-in w-full lg:w-[24rem] xl:w-[27rem] flex-shrink-0" style={{ animationDelay: '560ms' }}>
          <div
            className="rounded-2xl border border-white/10 overflow-hidden"
            style={{ background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(16px)' }}
          >
            {/* Album header */}
            <div className="flex items-center gap-3.5 px-4 py-4 border-b border-white/10">
              <div className="relative w-14 h-14 rounded-lg overflow-hidden flex-shrink-0" style={{ backgroundColor: '#181818' }}>
                {coverUrl ? (
                  <Image src={coverUrl} alt={title} fill className="object-cover" unoptimized />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <CassetteIcon size={20} className="text-[#333]" />
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">{typeLabel}</p>
                <p className="text-base font-bold text-white truncate leading-tight">{title}</p>
                <p className="text-xs text-white/40 mt-0.5 truncate">
                  {artistName} · {tracks.length} {tracks.length === 1 ? 'track' : 'tracks'}
                  {totalDuration != null && ` · ${formatDuration(totalDuration)}`}
                </p>
              </div>
            </div>

            {/* Rows */}
            <div className="py-1.5 lg:max-h-[58vh] lg:overflow-y-auto">
              {tracks.map((track, i) => {
                const active = i === index
                const playable = !!track.audioUrl
                // Full-quality original, gated per mix on the artist's "Allow
                // download" toggle. Same-origin proxy + ?download=1 → streamed
                // attachment, so even a 2 GB WAV never buffers (see /api/audio).
                const downloadName = playable && track.allowDownload
                  ? audioDownloadFileName(track.audioUrl!, track.title)
                  : null
                return (
                  <div
                    key={track.id}
                    className={`w-full flex items-center transition-colors group ${playable ? 'hover:bg-white/[0.06]' : ''}`}
                    style={active ? { background: accentA(0.12) } : undefined}
                  >
                  {/* An <a> can't nest inside a <button>, so the row is a flex
                      wrapper: play button fills it, download link sits beside. */}
                  <button
                    onClick={() => playTrackAt(i)}
                    className={`flex-1 min-w-0 flex items-center gap-3 pl-4 py-2.5 text-left ${downloadName ? 'pr-1' : 'pr-4'} ${playable ? '' : 'cursor-default'}`}
                    title={playable ? undefined : 'No mix uploaded yet'}
                  >
                    {/* Index / equalizer / hover play */}
                    <span className="w-5 flex items-center justify-center flex-shrink-0">
                      {active && isPlaying ? (
                        <span className="flex items-end gap-[2.5px] h-3.5">
                          {[0, 1, 2].map(bar => (
                            <span
                              key={bar}
                              className="w-[3px] rounded-sm"
                              style={{
                                background: accentCss,
                                animation: `mb-eq 1s ease-in-out ${bar * 0.18}s infinite`,
                                height: '60%',
                              }}
                            />
                          ))}
                        </span>
                      ) : (
                        <>
                          <span
                            className={`text-xs font-mono tabular-nums ${playable ? 'group-hover:hidden' : ''}`}
                            style={{ color: active ? accentCss : 'rgba(255,255,255,0.35)' }}
                          >
                            {i + 1}
                          </span>
                          {playable && (
                            <Play size={12} fill="currentColor" className="hidden group-hover:block text-white" />
                          )}
                        </>
                      )}
                    </span>

                    {/* Per-track artwork */}
                    <span className={`relative w-10 h-10 rounded-md overflow-hidden flex-shrink-0 block ${playable ? '' : 'opacity-50'}`} style={{ backgroundColor: '#181818' }}>
                      {track.artworkUrl ? (
                        <Image src={track.artworkUrl} alt="" fill className="object-cover" unoptimized />
                      ) : (
                        <span className="absolute inset-0 flex items-center justify-center">
                          <CassetteIcon size={14} className="text-[#333]" />
                        </span>
                      )}
                    </span>

                    <span className="flex-1 min-w-0 block">
                      <span
                        className="block text-sm font-medium truncate"
                        style={{ color: active ? accentCss : playable ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.45)' }}
                      >
                        {track.title}
                      </span>
                      {track.genre && (
                        <span className="block text-[11px] text-white/35 truncate">{track.genre}</span>
                      )}
                    </span>

                    <span className="text-[11px] font-mono tabular-nums text-white/35 flex-shrink-0">
                      {playable && track.duration != null ? formatDuration(track.duration) : ''}
                    </span>
                  </button>

                  {downloadName && (
                    <a
                      href={`${audioProxyUrl(track.audioUrl!)}?download=1&filename=${encodeURIComponent(downloadName)}`}
                      download={downloadName}
                      className="p-2.5 mr-1.5 flex-shrink-0 text-white/35 hover:text-white transition-colors"
                      title={`Download the full-quality file (${downloadName})`}
                      aria-label={`Download ${track.title}`}
                    >
                      <Download size={15} />
                    </a>
                  )}
                  </div>
                )
              })}
            </div>

            {/* Feedback on the current track (public page only) */}
            {albumToken && (
              <div ref={drawerRef} className="border-t border-white/10">
                <button
                  onClick={() => setShowFeedback(v => !v)}
                  className="w-full flex items-center justify-center gap-2 py-3.5 text-sm text-white/35 hover:text-white/60 transition-colors"
                >
                  <MessageSquare size={14} />
                  <span className="truncate">Leave a note on {current.title}</span>
                  <ChevronDown
                    size={14}
                    className="transition-transform duration-200 flex-shrink-0"
                    style={{ transform: showFeedback ? 'rotate(180deg)' : 'rotate(0deg)' }}
                  />
                </button>
                {showFeedback && (
                  <div className="px-4 pb-5">
                    <FeedbackForm
                      key={`${current.id}-${formKey}`}
                      shareToken={albumToken}
                      projectId={current.id}
                      currentTime={currentTime}
                      initialPinnedAt={noteAt ?? undefined}
                    />
                  </div>
                )}
              </div>
            )}
          </div>

          {footnote && (
            <p className="text-center text-[11px] text-white/25 mt-4">{footnote}</p>
          )}
        </div>
      </div>
    </div>
  )
}
