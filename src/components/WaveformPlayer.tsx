'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { Play, Pause, Download } from 'lucide-react'
import { formatDuration } from '@/lib/supabase'

type Props = {
  audioUrl: string
  allowDownload?: boolean
  filename?: string
  // For A/B compare: sync playback position from outside
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
  const containerRef = useRef<HTMLDivElement>(null)
  const wavesurferRef = useRef<import('wavesurfer.js').default | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [loading, setLoading] = useState(true)
  const [speed, setSpeed] = useState(1)
  const speeds = [0.5, 0.75, 1, 1.25, 1.5]

  useEffect(() => {
    if (!containerRef.current) return
    let ws: import('wavesurfer.js').default | null = null

    // Dynamically import wavesurfer (browser-only)
    import('wavesurfer.js').then(({ default: WaveSurfer }) => {
      ws = WaveSurfer.create({
        container: containerRef.current!,
        waveColor: '#2a2a2a',
        progressColor: '#a78bfa',
        url: audioUrl,
        height: compact ? 48 : 72,
        barWidth: 2,
        barGap: 1,
        barRadius: 2,
        normalize: true,
        interact: true,
      })

      ws.on('ready', () => {
        setDuration(ws!.getDuration())
        setLoading(false)
      })

      ws.on('timeupdate', (time: number) => {
        setCurrentTime(time)
        onTimeUpdate?.(time)
      })

      ws.on('play', () => setIsPlaying(true))
      ws.on('pause', () => setIsPlaying(false))
      ws.on('finish', () => setIsPlaying(false))

      wavesurferRef.current = ws
    })

    return () => {
      ws?.destroy()
      wavesurferRef.current = null
    }
  }, [audioUrl, compact])

  // Sync playback position from outside (A/B compare)
  useEffect(() => {
    if (syncPosition !== undefined && wavesurferRef.current && duration > 0) {
      const fraction = syncPosition / duration
      wavesurferRef.current.seekTo(Math.min(1, Math.max(0, fraction)))
    }
  }, [syncPosition, duration])

  const togglePlay = useCallback(() => {
    wavesurferRef.current?.playPause()
  }, [])

  const changeSpeed = useCallback((newSpeed: number) => {
    setSpeed(newSpeed)
    wavesurferRef.current?.setPlaybackRate(newSpeed)
  }, [])

  // Keyboard shortcut: Space to play/pause when focused
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === ' ') { e.preventDefault(); togglePlay() }
    if (e.key === 'ArrowRight') wavesurferRef.current?.skip(5)
    if (e.key === 'ArrowLeft') wavesurferRef.current?.skip(-5)
  }, [togglePlay])

  return (
    <div
      className="w-full focus:outline-none"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {/* Waveform */}
      <div className="waveform-container relative">
        {loading && (
          <div className={`absolute inset-0 flex items-center justify-center bg-[#0f0f0f] rounded-lg ${compact ? 'h-12' : 'h-[72px]'}`}>
            <div className="w-4 h-4 border-2 border-[#a78bfa]/30 border-t-[#a78bfa] rounded-full animate-spin" />
          </div>
        )}
        <div ref={containerRef} className="w-full" />
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3 mt-2">
        {/* Play/Pause */}
        <button
          onClick={togglePlay}
          disabled={loading}
          className="flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-full bg-[#1e1e1e] hover:bg-[#a78bfa]/20 border border-[#2a2a2a] hover:border-[#a78bfa]/30 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
        >
          {isPlaying ? <Pause size={14} /> : <Play size={14} />}
        </button>

        {/* Time display */}
        <span className="text-xs text-[#555] tabular-nums flex-shrink-0">
          {formatDuration(currentTime)} / {formatDuration(duration)}
        </span>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Speed control */}
        <div className="flex items-center gap-0.5">
          {speeds.map(s => (
            <button
              key={s}
              onClick={() => changeSpeed(s)}
              className={`px-1.5 py-0.5 text-[10px] rounded transition-colors ${
                speed === s
                  ? 'bg-[#a78bfa]/20 text-[#a78bfa]'
                  : 'text-[#444] hover:text-[#888]'
              }`}
            >
              {s}x
            </button>
          ))}
        </div>

        {/* Download */}
        {allowDownload && (
          <a
            href={audioUrl}
            download={filename ?? 'mix.wav'}
            className="flex items-center gap-1 text-[#444] hover:text-[#888] transition-colors"
            title="Download"
          >
            <Download size={13} />
          </a>
        )}
      </div>
    </div>
  )
}
