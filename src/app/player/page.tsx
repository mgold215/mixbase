'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { Play, Pause, SkipBack, SkipForward, Shuffle, Volume2, Music } from 'lucide-react'
import type { Track } from '../api/tracks/route'
import { formatDuration } from '@/lib/supabase'

type SortKey = 'title' | 'date'

export default function PlayerPage() {
  const [tracks, setTracks] = useState<Track[]>([])
  const [filtered, setFiltered] = useState<Track[]>([])
  const [loading, setLoading] = useState(true)
  const [currentIdx, setCurrentIdx] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(1)
  const [shuffle, setShuffle] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('date')
  // Two background slots for crossfade
  const [bgSlot, setBgSlot] = useState<0 | 1>(0)
  const [bgUrls, setBgUrls] = useState<[string | null, string | null]>([null, null])

  const audioRef = useRef<HTMLAudioElement>(null)

  const current = filtered[currentIdx] ?? null

  // Fetch tracks
  useEffect(() => {
    fetch('/api/tracks')
      .then((r) => r.json())
      .then((data: Track[]) => {
        setTracks(data)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  // Sort tracks
  useEffect(() => {
    const sorted = [...tracks].sort((a, b) =>
      sortKey === 'title'
        ? a.title.localeCompare(b.title)
        : b.uploaded_at - a.uploaded_at
    )
    setFiltered(sorted)
    setCurrentIdx(0)
  }, [tracks, sortKey])

  // Load new track into audio element
  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !current) return
    audio.src = current.audio_url
    audio.volume = volume
    setCurrentTime(0)
    setDuration(0)
    if (isPlaying) {
      audio.play().catch(() => setIsPlaying(false))
    }
    // Crossfade background
    const nextSlot: 0 | 1 = bgSlot === 0 ? 1 : 0
    setBgUrls((prev) => {
      const next = [...prev] as [string | null, string | null]
      next[nextSlot] = current.artwork_url
      return next
    })
    setBgSlot(nextSlot)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIdx, filtered])

  // Volume sync
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume
  }, [volume])

  const play = useCallback(() => {
    audioRef.current?.play().then(() => setIsPlaying(true)).catch(() => {})
  }, [])

  const pause = useCallback(() => {
    audioRef.current?.pause()
    setIsPlaying(false)
  }, [])

  const togglePlay = useCallback(() => {
    isPlaying ? pause() : play()
  }, [isPlaying, play, pause])

  const goTo = useCallback((idx: number) => {
    setCurrentIdx(idx)
    setIsPlaying(true)
  }, [])

  const prev = useCallback(() => {
    if (currentTime > 3 && audioRef.current) {
      audioRef.current.currentTime = 0
      return
    }
    goTo((currentIdx - 1 + filtered.length) % filtered.length)
  }, [currentIdx, currentTime, filtered.length, goTo])

  const next = useCallback(() => {
    if (shuffle) {
      goTo(Math.floor(Math.random() * filtered.length))
    } else {
      goTo((currentIdx + 1) % filtered.length)
    }
  }, [currentIdx, filtered.length, shuffle, goTo])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.code === 'Space') { e.preventDefault(); togglePlay() }
      if (e.code === 'ArrowLeft') { e.preventDefault(); prev() }
      if (e.code === 'ArrowRight') { e.preventDefault(); next() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [togglePlay, prev, next])

  // Audio event handlers
  const onTimeUpdate = () => setCurrentTime(audioRef.current?.currentTime ?? 0)
  const onDurationChange = () => setDuration(audioRef.current?.duration ?? 0)
  const onEnded = () => next()
  const onPlay = () => setIsPlaying(true)
  const onPause = () => setIsPlaying(false)

  const seek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const t = parseFloat(e.target.value)
    if (audioRef.current) audioRef.current.currentTime = t
    setCurrentTime(t)
  }

  const pct = duration > 0 ? (currentTime / duration) * 100 : 0

  // Empty state
  if (!loading && tracks.length === 0) {
    return (
      <div className="fixed inset-0 bg-[#0a0a0a] flex flex-col items-center justify-center gap-4">
        <Music size={48} className="text-[#333]" />
        <p className="text-[#666] text-lg">No tracks yet.</p>
        <Link href="/dashboard" className="px-4 py-2 rounded-lg bg-[#a78bfa]/20 text-[#a78bfa] text-sm hover:bg-[#a78bfa]/30 transition-colors">
          Go generate some
        </Link>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 bg-[#0a0a0a] flex flex-col overflow-hidden">
      {/* Hidden audio element */}
      <audio
        ref={audioRef}
        onTimeUpdate={onTimeUpdate}
        onDurationChange={onDurationChange}
        onEnded={onEnded}
        onPlay={onPlay}
        onPause={onPause}
      />

      {/* Animated blurred background — two slots for crossfade */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        {([0, 1] as const).map((slot) => (
          <div
            key={slot}
            className="absolute inset-0 transition-opacity duration-700"
            style={{ opacity: bgUrls[slot] ? (bgSlot === slot ? 1 : 0) : 0 }}
          >
            {bgUrls[slot] && (
              <Image
                src={bgUrls[slot]!}
                alt=""
                fill
                className="object-cover"
                style={{ filter: 'blur(90px) saturate(1.5) brightness(0.25)' }}
                unoptimized
              />
            )}
          </div>
        ))}
      </div>

      {/* Main layout: sidebar + center stage */}
      <div className="relative flex flex-1 overflow-hidden pb-24">
        {/* Sidebar */}
        <aside className="w-[280px] flex-shrink-0 flex flex-col border-r border-[#1a1a1a] bg-[#080808]/70 backdrop-blur-sm">
          {/* Sort controls */}
          <div className="flex items-center gap-2 px-4 py-3 border-b border-[#1a1a1a]">
            <span className="text-xs text-[#555] uppercase tracking-wider mr-auto">Tracks</span>
            {(['title', 'date'] as SortKey[]).map((k) => (
              <button
                key={k}
                onClick={() => setSortKey(k)}
                className={`text-xs px-2 py-1 rounded transition-colors ${
                  sortKey === k ? 'text-white bg-[#1a1a1a]' : 'text-[#555] hover:text-white'
                }`}
              >
                {k === 'title' ? 'Title' : 'Date'}
              </button>
            ))}
          </div>

          {/* Track list */}
          <div className="flex-1 overflow-y-auto">
            {loading
              ? Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-2">
                    <div className="w-[42px] h-[42px] rounded bg-[#1a1a1a] animate-pulse flex-shrink-0" />
                    <div className="flex-1 space-y-1.5">
                      <div className="h-3 bg-[#1a1a1a] rounded animate-pulse w-3/4" />
                      <div className="h-2.5 bg-[#151515] rounded animate-pulse w-1/2" />
                    </div>
                  </div>
                ))
              : filtered.map((t, i) => {
                  const active = i === currentIdx
                  return (
                    <button
                      key={t.id}
                      onClick={() => goTo(i)}
                      className={`w-full flex items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-[#111] ${
                        active ? 'bg-[#a78bfa]/10 border-l-2 border-[#a78bfa]' : 'border-l-2 border-transparent'
                      }`}
                    >
                      <div className="w-[42px] h-[42px] rounded overflow-hidden flex-shrink-0 bg-[#1a1a1a]">
                        {t.artwork_url ? (
                          <Image
                            src={t.artwork_url}
                            alt={t.title}
                            width={42}
                            height={42}
                            className="object-cover w-full h-full"
                            unoptimized
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <Music size={16} className="text-[#333]" />
                          </div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm truncate ${active ? 'text-[#a78bfa]' : 'text-[#ccc]'}`}>{t.title}</p>
                        <p className="text-xs text-[#555] truncate">{t.artist}</p>
                      </div>
                    </button>
                  )
                })}
          </div>
        </aside>

        {/* Center stage */}
        <main className="flex-1 flex flex-col items-center justify-center gap-6 relative">
          {current && (
            <>
              {/* Artwork */}
              <div
                className="relative rounded-[14px] overflow-hidden transition-transform duration-300"
                style={{
                  width: 460,
                  height: 460,
                  boxShadow: isPlaying
                    ? '0 0 60px 20px rgba(167,139,250,0.35), 0 0 120px 40px rgba(167,139,250,0.15)'
                    : '0 8px 40px rgba(0,0,0,0.6)',
                  transform: isPlaying ? 'scale(1.02)' : 'scale(1)',
                  animation: isPlaying ? 'glowPulse 2.4s ease-in-out infinite' : 'none',
                }}
              >
                {current.artwork_url ? (
                  <Image
                    src={current.artwork_url}
                    alt={current.title}
                    fill
                    className="object-cover"
                    unoptimized
                  />
                ) : (
                  <div className="w-full h-full bg-[#111] flex items-center justify-center">
                    <Music size={80} className="text-[#333]" />
                  </div>
                )}
              </div>

              {/* Track info */}
              <div className="text-center">
                <h1 className="text-xl font-semibold text-white">{current.title}</h1>
                <p className="text-sm text-[#888] mt-1">{current.artist}</p>
              </div>
            </>
          )}
        </main>
      </div>

      {/* Bottom controls bar */}
      <div
        className="fixed bottom-0 left-0 right-0 h-24 border-t border-[#1a1a1a] flex flex-col justify-center px-6 gap-2"
        style={{ backdropFilter: 'blur(24px)', background: 'rgba(10,10,10,0.8)' }}
      >
        {/* Progress bar */}
        <div className="flex items-center gap-3">
          <span className="text-xs text-[#555] w-10 text-right tabular-nums">{formatDuration(Math.floor(currentTime))}</span>
          <div className="relative flex-1 h-1 bg-[#222] rounded-full">
            <div
              className="absolute left-0 top-0 h-full bg-[#a78bfa] rounded-full pointer-events-none"
              style={{ width: `${pct}%` }}
            />
            <input
              type="range"
              min={0}
              max={duration || 0}
              step={0.1}
              value={currentTime}
              onChange={seek}
              className="absolute inset-0 w-full opacity-0 cursor-pointer"
            />
          </div>
          <span className="text-xs text-[#555] w-10 tabular-nums">{formatDuration(Math.floor(duration))}</span>
        </div>

        {/* Buttons + volume */}
        <div className="flex items-center justify-center gap-4 relative">
          {/* Shuffle */}
          <button
            onClick={() => setShuffle((s) => !s)}
            className={`p-1.5 rounded transition-colors ${shuffle ? 'text-[#a78bfa]' : 'text-[#555] hover:text-white'}`}
            title="Shuffle"
          >
            <Shuffle size={16} />
          </button>

          {/* Prev */}
          <button
            onClick={prev}
            className="p-2 rounded-full text-[#999] hover:text-white transition-colors"
            title="Previous (←)"
          >
            <SkipBack size={20} />
          </button>

          {/* Play/Pause */}
          <button
            onClick={togglePlay}
            className="w-12 h-12 rounded-full bg-[#a78bfa] hover:bg-[#c4b5fd] transition-colors flex items-center justify-center text-[#0a0a0a]"
            title="Play/Pause (Space)"
          >
            {isPlaying ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" className="ml-0.5" />}
          </button>

          {/* Next */}
          <button
            onClick={next}
            className="p-2 rounded-full text-[#999] hover:text-white transition-colors"
            title="Next (→)"
          >
            <SkipForward size={20} />
          </button>

          {/* Volume */}
          <div className="absolute right-0 flex items-center gap-2">
            <Volume2 size={15} className="text-[#555]" />
            <div className="relative w-24 h-1 bg-[#222] rounded-full">
              <div
                className="absolute left-0 top-0 h-full bg-[#444] rounded-full pointer-events-none"
                style={{ width: `${volume * 100}%` }}
              />
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={volume}
                onChange={(e) => setVolume(parseFloat(e.target.value))}
                className="absolute inset-0 w-full opacity-0 cursor-pointer"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Glow pulse keyframe */}
      <style>{`
        @keyframes glowPulse {
          0%, 100% { box-shadow: 0 0 60px 20px rgba(167,139,250,0.35), 0 0 120px 40px rgba(167,139,250,0.15); }
          50%       { box-shadow: 0 0 80px 30px rgba(167,139,250,0.5),  0 0 160px 60px rgba(167,139,250,0.22); }
        }
      `}</style>
    </div>
  )
}
