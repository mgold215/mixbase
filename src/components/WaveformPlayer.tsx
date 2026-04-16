'use client'

import { useRef, useState, useEffect, useCallback, type ChangeEvent, type KeyboardEvent } from 'react'
import { Play, Pause, Download } from 'lucide-react'
import { formatDuration } from '@/lib/supabase'

type Props = {
  audioUrl: string
  allowDownload?: boolean
  filename?: string
  syncPosition?: number
  onTimeUpdate?: (time: number) => void
  compact?: boolean
}

export default function WaveformPlayer({
  audioUrl,
  allowDownload = false,
  filename,
  syncPosition,
  onTimeUpdate,
  compact = false,
}: Props) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [loading, setLoading] = useState(true)
  const [speed, setSpeed] = useState(1)
  const speeds = [0.5, 0.75, 1, 1.25, 1.5]

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const onLoaded = () => { setDuration(audio.duration || 0); setLoading(false) }
    const onTime = () => { setCurrentTime(audio.currentTime); onTimeUpdate?.(audio.currentTime) }
    const onEnded = () => setIsPlaying(false)
    audio.addEventListener('loadedmetadata', onLoaded)
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('ended', onEnded)
    if (audio.readyState >= 1) onLoaded()
    return () => {
      audio.removeEventListener('loadedmetadata', onLoaded)
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('ended', onEnded)
    }
  }, [audioUrl, onTimeUpdate])

  useEffect(() => {
    const audio = audioRef.current
    if (syncPosition !== undefined && audio && duration > 0) {
      audio.currentTime = Math.min(duration, Math.max(0, syncPosition))
    }
  }, [syncPosition, duration])

  const togglePlay = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    if (isPlaying) { audio.pause(); setIsPlaying(false) }
    else { audio.play().then(() => setIsPlaying(true)).catch(() => {}) }
  }, [isPlaying])

  // ── Media Session API ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    navigator.mediaSession.metadata = new MediaMetadata({
      title: filename ?? 'Track',
      artist: '',
      artwork: [],
    })
    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused'
    const set = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try { navigator.mediaSession.setActionHandler(action, handler) } catch { /* unsupported */ }
    }
    set('play',         () => togglePlay())
    set('pause',        () => togglePlay())
    set('seekbackward', (d) => {
      if (!audioRef.current) return
      audioRef.current.currentTime = Math.max(0, audioRef.current.currentTime - (d.seekOffset ?? 10))
    })
    set('seekforward', (d) => {
      if (!audioRef.current) return
      audioRef.current.currentTime = Math.min(audioRef.current.duration || 0, audioRef.current.currentTime + (d.seekOffset ?? 10))
    })
    set('seekto', (d) => {
      if (d.seekTime == null || !audioRef.current) return
      audioRef.current.currentTime = Math.min(d.seekTime, audioRef.current.duration || 0)
    })
    return () => {
      ;(['play','pause','seekbackward','seekforward','seekto'] as MediaSessionAction[])
        .forEach(a => set(a, null))
    }
  }, [audioUrl, isPlaying, filename, togglePlay])

  function seek(e: ChangeEvent<HTMLInputElement>) {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = Number(e.target.value)
    setCurrentTime(Number(e.target.value))
  }

  function changeSpeed(s: number) {
    setSpeed(s)
    if (audioRef.current) audioRef.current.playbackRate = s
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === ' ') { e.preventDefault(); togglePlay() }
    if (e.key === 'ArrowRight' && audioRef.current) audioRef.current.currentTime += 5
    if (e.key === 'ArrowLeft' && audioRef.current) audioRef.current.currentTime -= 5
  }

  const pct = duration > 0 ? (currentTime / duration) * 100 : 0

  return (
    <div className="w-full focus:outline-none" tabIndex={0} onKeyDown={handleKeyDown}>
      <audio ref={audioRef} src={audioUrl} preload="metadata" />

      {/* Progress bar / scrubber */}
      <div className={`relative w-full ${compact ? 'h-10' : 'h-14'} rounded-lg overflow-hidden mb-2`} style={{ backgroundColor: 'var(--input-bg)' }}>
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-4 h-4 border-2 rounded-full animate-spin" style={{ borderColor: 'var(--accent-dim)', borderTopColor: 'var(--accent)' }} />
          </div>
        )}
        <div
          className="absolute bottom-0 left-0 h-1 transition-all duration-100"
          style={{ backgroundColor: 'var(--accent)', width: `${pct}%` }}
        />
        <input
          type="range"
          min={0}
          max={duration || 1}
          step={0.1}
          value={currentTime}
          onChange={seek}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        />
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3">
        <button
          onClick={togglePlay}
          disabled={loading}
          className="flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-full disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          style={{ backgroundColor: 'var(--surface-2)', border: '1px solid var(--surface-3)', color: 'var(--text)' }}
        >
          {isPlaying ? <Pause size={14} /> : <Play size={14} />}
        </button>

        <span className="text-xs tabular-nums flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
          {formatDuration(currentTime)} / {formatDuration(duration || null)}
        </span>

        <div className="flex-1" />

        <div className="flex items-center gap-0.5">
          {speeds.map(s => (
            <button
              key={s}
              onClick={() => changeSpeed(s)}
              className="px-1.5 py-0.5 text-[10px] rounded transition-colors"
              style={speed === s
                ? { backgroundColor: 'var(--accent-dim)', color: 'var(--accent)' }
                : { color: 'var(--text-muted)' }
              }
            >
              {s}x
            </button>
          ))}
        </div>

        {allowDownload && (
          <a
            href={audioUrl}
            download={filename ?? 'mix.wav'}
            className="flex items-center gap-1 transition-colors" style={{ color: 'var(--text-muted)' }}
            title="Download"
          >
            <Download size={13} />
          </a>
        )}
      </div>
    </div>
  )
}
