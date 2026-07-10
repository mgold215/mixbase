'use client'

import { useState, useRef, useEffect, useCallback, useMemo, type ChangeEvent } from 'react'
import Image from 'next/image'
import { Play, Pause, Music, SkipBack, SkipForward } from 'lucide-react'
import { audioProxyUrl, formatDuration } from '@/lib/supabase'
import { extractDominantColor } from '@/lib/audio-analysis'
import { applyMediaSession } from '@/lib/media-session'
import { announcePlay, onOtherSourcePlay } from '@/lib/audio-coordinator'

export type ShareTrack = {
  id: string
  title: string
  genre: string | null
  artworkUrl: string | null
  visualizerUrl: string | null
  audioUrl: string
  duration: number | null
}

type Props = {
  title: string
  typeLabel: string
  coverUrl: string | null
  artistName: string
  tracks: ShareTrack[]
}

export default function AlbumShareClient({ title, typeLabel, coverUrl, artistName, tracks }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const vizVideoRef = useRef<HTMLVideoElement | null>(null)
  const [index, setIndex] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [accent, setAccent] = useState<[number, number, number]>([139, 92, 246])
  // Set when a track change should start playback once the new src is committed
  // (row click, next/prev, auto-advance) — a plain src swap alone stays paused.
  const pendingPlay = useRef(false)

  const current: ShareTrack | undefined = tracks[index]
  const displayArt = current?.artworkUrl ?? coverUrl
  const accentCss = `rgb(${accent[0]},${accent[1]},${accent[2]})`

  // Total runtime for the header — only shown when every track reported one,
  // so a missing duration can't display as a too-short total.
  const totalDuration = useMemo(() => {
    if (tracks.length === 0 || tracks.some(t => t.duration == null)) return null
    return tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0)
  }, [tracks])

  // Keep the muted visualizer loop in step with the audio — same as ShareClient.
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

  // Wire audio events. Depends on `index` so onEnded always advances from the
  // track that actually finished (re-binding on change is cheap).
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const onTime = () => setCurrentTime(audio.currentTime)
    const onDuration = () => setDuration(isNaN(audio.duration) ? 0 : audio.duration)
    const onPlay = () => { setIsPlaying(true); announcePlay('album-share-player') }
    const onPause = () => setIsPlaying(false)
    const onEnded = () => {
      if (index < tracks.length - 1) {
        pendingPlay.current = true
        setIndex(index + 1)
      } else {
        setIsPlaying(false)
      }
    }
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('durationchange', onDuration)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('ended', onEnded)
    // Pause when another source (the app's shared player) starts playing.
    const unsubscribe = onOtherSourcePlay('album-share-player', () => audio.pause())
    return () => {
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('durationchange', onDuration)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('ended', onEnded)
      unsubscribe()
    }
  }, [index, tracks.length])

  // After a track change commits (new src is on the element), start playback
  // if the change came from an explicit play intent.
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    setCurrentTime(0)
    setDuration(tracks[index]?.duration ?? 0)
    if (pendingPlay.current) {
      pendingPlay.current = false
      audio.play().catch(() => {})
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index])

  const playTrackAt = useCallback((i: number) => {
    const track = tracks[i]
    if (!track) return
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
    if (tracks.length < 2) return
    playTrackAt((index + 1) % tracks.length)
  }, [tracks.length, index, playTrackAt])

  const prevTrack = useCallback(() => {
    const audio = audioRef.current
    // Standard player behavior: restart the current track unless we're at the top of it.
    if (audio && audio.currentTime > 3) {
      audio.currentTime = 0
      return
    }
    if (tracks.length < 2) {
      if (audio) audio.currentTime = 0
      return
    }
    playTrackAt((index - 1 + tracks.length) % tracks.length)
  }, [tracks.length, index, playTrackAt])

  const seek = (e: ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = parseFloat(e.target.value)
  }

  const pct = duration > 0 ? (currentTime / duration) * 100 : 0

  // ── Empty state: collection exists but no track has an uploaded mix yet ──
  if (!current) {
    return (
      <div className="relative flex-1 flex flex-col items-center justify-center gap-6 px-6 py-16">
        <div className="relative w-48 h-48 rounded-2xl overflow-hidden" style={{ backgroundColor: '#141414' }}>
          {coverUrl ? (
            <Image src={coverUrl} alt={title} fill className="object-cover" unoptimized />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center">
              <Music size={56} className="text-[#333]" />
            </div>
          )}
        </div>
        <div className="text-center">
          <p className="text-[11px] uppercase tracking-[0.2em] text-white/35 mb-2">{typeLabel} · {artistName}</p>
          <h1 className="text-2xl font-bold text-white">{title}</h1>
          <p className="text-sm text-white/40 mt-3">No playable tracks yet — check back soon.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex-1 flex flex-col overflow-hidden">
      <audio
        ref={audioRef}
        src={audioProxyUrl(current.audioUrl)}
        playsInline
        preload="auto"
        style={{ position: 'fixed', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }}
      />

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
                <Music size={64} className="text-[#333]" />
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
              {typeLabel} · {artistName}
            </p>
            <h1 className="text-xl sm:text-2xl font-bold text-white leading-tight truncate">{current.title}</h1>
            <p className="text-sm text-white/40 mt-1 truncate">{title}</p>
          </div>

          {/* Progress + transport */}
          <div className="w-full max-w-xs space-y-5">
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
                className="w-16 h-16 sm:w-[4.5rem] sm:h-[4.5rem] rounded-full flex items-center justify-center transition-all hover:scale-105 active:scale-95"
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
                    <Music size={20} className="text-[#333]" />
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
                return (
                  <button
                    key={track.id}
                    onClick={() => playTrackAt(i)}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-white/[0.06] group"
                    style={active ? { background: `rgba(${accent[0]},${accent[1]},${accent[2]},0.12)` } : undefined}
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
                            className="text-xs font-mono tabular-nums group-hover:hidden"
                            style={{ color: active ? accentCss : 'rgba(255,255,255,0.35)' }}
                          >
                            {i + 1}
                          </span>
                          <Play size={12} fill="currentColor" className="hidden group-hover:block text-white" />
                        </>
                      )}
                    </span>

                    {/* Per-track artwork */}
                    <span className="relative w-10 h-10 rounded-md overflow-hidden flex-shrink-0 block" style={{ backgroundColor: '#181818' }}>
                      {track.artworkUrl ? (
                        <Image src={track.artworkUrl} alt="" fill className="object-cover" unoptimized />
                      ) : (
                        <span className="absolute inset-0 flex items-center justify-center">
                          <Music size={14} className="text-[#333]" />
                        </span>
                      )}
                    </span>

                    <span className="flex-1 min-w-0 block">
                      <span
                        className="block text-sm font-medium truncate"
                        style={{ color: active ? accentCss : 'rgba(255,255,255,0.92)' }}
                      >
                        {track.title}
                      </span>
                      {track.genre && (
                        <span className="block text-[11px] text-white/35 truncate">{track.genre}</span>
                      )}
                    </span>

                    <span className="text-[11px] font-mono tabular-nums text-white/35 flex-shrink-0">
                      {track.duration != null ? formatDuration(track.duration) : ''}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          <p className="text-center text-[11px] text-white/25 mt-4">
            Shared privately via <span className="text-white/40">mixBASE</span>
          </p>
        </div>
      </div>
    </div>
  )
}
