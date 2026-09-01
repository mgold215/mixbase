'use client'

import { useState, useRef, useEffect, useCallback, useMemo, type ChangeEvent } from 'react'
import { useParams } from 'next/navigation'
import Image from 'next/image'
import { Play, Pause, SkipBack, SkipForward, Download } from 'lucide-react'
import CassetteIcon from '@/components/CassetteIcon'
import { audioProxyUrl, formatDuration } from '@/lib/supabase'
import { audioDownloadFileName } from '@/lib/download'
import { extractDominantColor } from '@/lib/audio-analysis'
import { applyMediaSession } from '@/lib/media-session'
import { announcePlay, announceStop, onOtherSourcePlay, claimMediaSession, ownsMediaSession, releaseMediaSession } from '@/lib/audio-coordinator'

// Full-album player used by both the public /share/album/[token] page and the
// logged-in collection view: blurred backdrop + accent theme that follow the
// current track, transport with auto-advance, and a tracklist with per-track
// artwork. Tracks without an uploaded mix (audioUrl null) are listed but
// muted — playback and auto-advance skip over them.

export type AlbumPlayerTrack = {
  id: string
  title: string
  genre: string | null
  artworkUrl: string | null
  visualizerUrl: string | null
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

export default function AlbumPlayer({ title, typeLabel, coverUrl, artistName, tracks, sourceId = 'album-player', footnote }: Props) {
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

  const current: AlbumPlayerTrack | undefined = tracks[index]
  const displayArt = current?.artworkUrl ?? coverUrl
  const accentCss = `rgb(${accent[0]},${accent[1]},${accent[2]})`

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

  // Keep the muted visualizer loop in step with the audio.
  useEffect(() => {
    const v = vizVideoRef.current
    if (!v) return
    if (isPlaying) v.play().catch(() => {})
    else v.pause()
  }, [isPlaying, index, current?.visualizerUrl])

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
        applyMediaSession(track.title, track.artworkUrl ?? coverUrl, true, artistName)
        audio.play().catch(() => {})
      }
      return
    }
    applyMediaSession(track.title, track.artworkUrl ?? coverUrl, true, artistName)
    pendingPlay.current = true
    setIndex(i)
  }, [tracks, index, isPlaying, coverUrl, artistName])

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

  const seek = (e: ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = parseFloat(e.target.value)
  }

  const pct = duration > 0 ? (currentTime / duration) * 100 : 0
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
    <div className="relative flex-1 flex flex-col overflow-hidden">
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

      {/* ── Blurred artwork backdrop (follows the current track) ── */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        {displayArt ? (
          <Image
            key={displayArt}
            src={displayArt} alt="" fill unoptimized
            className="object-cover transition-opacity duration-700"
            style={{ filter: 'blur(18px) saturate(1.6) brightness(0.45)' }}
          />
        ) : (
          <div
            className="absolute inset-0"
            style={{ background: accentCss, filter: 'blur(60px) brightness(0.25)' }}
          />
        )}
        <div className="absolute inset-0" style={{
          background: `
            radial-gradient(ellipse 90% 80% at 50% 45%, transparent 0%, rgba(0,0,0,0.5) 60%, rgba(0,0,0,0.88) 100%),
            radial-gradient(ellipse 80% 60% at 50% 50%, rgba(${accent[0]},${accent[1]},${accent[2]},0.14) 0%, transparent 70%)
          `,
        }} />
      </div>

      {/* ── Content ── */}
      <div className="relative z-10 flex-1 w-full max-w-6xl mx-auto px-5 sm:px-8 py-8 sm:py-10 flex flex-col lg:flex-row lg:items-center gap-8 lg:gap-14">

        {/* Now playing */}
        <div className="flex flex-col items-center gap-6 lg:flex-1 lg:min-w-0">
          <div
            className="relative w-52 h-52 sm:w-64 sm:h-64 xl:w-80 xl:h-80 rounded-2xl overflow-hidden flex-shrink-0"
            style={{ boxShadow: `0 32px 80px rgba(${accent[0]},${accent[1]},${accent[2]},0.4), 0 8px 32px rgba(0,0,0,0.7)` }}
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
            {/* Track visualizer loops over the artwork while playing */}
            {current.visualizerUrl && (
              <video
                key={current.visualizerUrl}
                ref={vizVideoRef}
                src={current.visualizerUrl}
                loop
                muted
                playsInline
                preload="auto"
                className="absolute inset-0 w-full h-full object-cover"
              />
            )}
          </div>

          <div className="text-center max-w-sm">
            <p className="text-[11px] uppercase tracking-[0.2em] text-white/35 mb-1.5">
              {typeLabel} · {title}
            </p>
            <h1 className="text-xl sm:text-2xl font-bold text-white leading-tight truncate">{current.title}</h1>
            {/* Artist stays in its natural case — no uppercase transform here */}
            <p className="text-sm text-white/40 mt-1 truncate">{artistName}</p>
          </div>

          {/* Progress + transport */}
          <div className="w-full max-w-xs space-y-5">
            <div className="flex items-center gap-3">
              <span className="text-[11px] font-mono text-white/50 tabular-nums w-10 text-right shrink-0">
                {/* formatDuration renders 0 as "--:--"; before playback starts 0:00 is correct */}
                {currentTime >= 1 ? formatDuration(Math.floor(currentTime)) : '0:00'}
              </span>
              <div className="flex-1 relative h-1.5 rounded-full bg-white/15 overflow-hidden">
                <div
                  className="absolute inset-y-0 left-0 rounded-full"
                  style={{ width: `${pct}%`, background: accentCss }}
                />
                <input
                  type="range" min={0} max={duration || 0} step={0.1} value={currentTime}
                  onChange={seek}
                  aria-label="Seek"
                  className="absolute inset-0 w-full opacity-0 cursor-pointer"
                />
              </div>
              <span className="text-[11px] font-mono text-white/30 tabular-nums w-10 shrink-0">
                {duration > 0 ? `−${formatDuration(Math.max(0, Math.floor(duration - currentTime)))}` : '--:--'}
              </span>
            </div>

            <div className="flex items-center justify-center gap-6">
              <button
                onClick={prevTrack}
                className="p-2 text-white/70 hover:text-white transition-colors"
                title="Previous"
              >
                <SkipBack size={24} fill="currentColor" />
              </button>
              <button
                onClick={togglePlay}
                className="w-16 h-16 sm:w-[4.5rem] sm:h-[4.5rem] rounded-full flex items-center justify-center transition-all hover:scale-105 active:scale-95 disabled:opacity-40"
                disabled={!currentPlayable}
                style={{
                  background: `linear-gradient(180deg, ${accentCss}, rgba(${accent[0]},${accent[1]},${accent[2]},0.7))`,
                  boxShadow: `0 0 40px rgba(${accent[0]},${accent[1]},${accent[2]},0.5), inset 0 1px 0 rgba(255,255,255,0.2)`,
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
        </div>

        {/* Tracklist */}
        <div className="w-full lg:w-[24rem] xl:w-[27rem] flex-shrink-0">
          <div
            className="rounded-2xl border border-white/10 overflow-hidden"
            style={{ background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(16px)' }}
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
                    style={active ? { background: `rgba(${accent[0]},${accent[1]},${accent[2]},0.12)` } : undefined}
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
          </div>

          {footnote && (
            <p className="text-center text-[11px] text-white/25 mt-4">{footnote}</p>
          )}
        </div>
      </div>
    </div>
  )
}
