'use client'

import { useState, useRef, useEffect, useCallback, type ChangeEvent } from 'react'
import Image from 'next/image'
import { Play, Pause, Music, MessageSquare, ChevronDown } from 'lucide-react'
import { audioProxyUrl, formatDuration } from '@/lib/supabase'
import { extractDominantColor } from '@/lib/audio-analysis'
import FeedbackForm from '@/components/FeedbackForm'
import type { Version } from '@/lib/supabase'

type Props = {
  // mb_projects is the full joined project row
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  version: Version & { mb_projects: any }
}

export default function ShareClient({ version }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [accent, setAccent] = useState<[number, number, number]>([139, 92, 246])
  const [showFeedback, setShowFeedback] = useState(false)

  const project = version.mb_projects
  const artworkUrl: string | null = project?.artwork_url ?? null
  const title: string = project?.title ?? 'Untitled'
  const audioUrl = audioProxyUrl(version.audio_url)
  const accentCss = `rgb(${accent[0]},${accent[1]},${accent[2]})`

  // Extract accent colour from artwork
  useEffect(() => {
    if (artworkUrl) {
      extractDominantColor(artworkUrl).then(setAccent).catch(() => {})
    }
  }, [artworkUrl])

  // Wire audio events
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const onTime = () => setCurrentTime(audio.currentTime)
    const onDuration = () => setDuration(isNaN(audio.duration) ? 0 : audio.duration)
    const onPlay = () => setIsPlaying(true)
    const onPause = () => setIsPlaying(false)
    const onEnded = () => setIsPlaying(false)
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('durationchange', onDuration)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('ended', onEnded)
    return () => {
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('durationchange', onDuration)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('ended', onEnded)
    }
  }, [])

  const togglePlay = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    if (isPlaying) audio.pause()
    else audio.play().catch(() => {})
  }, [isPlaying])

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
              <Music size={64} className="text-[#333]" />
            </div>
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
            <FeedbackForm versionId={version.id} />
          </div>
        )}
      </div>
    </div>
  )
}
