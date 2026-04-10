'use client'

import { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react'
import type { Track } from '@/app/api/tracks/route'
import { audioProxyUrl } from '@/lib/supabase'

type PlayerCtx = {
  tracks: Track[]
  currentTrack: Track | null
  isPlaying: boolean
  currentTime: number
  duration: number
  volume: number
  playTrack: (projectId: string) => void
  pause: () => void
  togglePlay: () => void
  seek: (time: number) => void
  setVolume: (v: number) => void
  next: () => void
  prev: () => void
}

const PlayerContext = createContext<PlayerCtx | null>(null)

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const [tracks, setTracks] = useState<Track[]>([])
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolumeState] = useState(0.85)
  const audioRef = useRef<HTMLAudioElement>(null)

  // Load tracks once on mount
  useEffect(() => {
    fetch('/api/tracks')
      .then(r => r.json())
      .then((d: Track[]) => setTracks(d))
      .catch(() => {})
  }, [])

  // Wire up audio event listeners
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const onTimeUpdate = () => setCurrentTime(audio.currentTime)
    const onDurationChange = () => setDuration(isNaN(audio.duration) ? 0 : audio.duration)
    const onPlay = () => setIsPlaying(true)
    const onPause = () => setIsPlaying(false)
    const onEnded = () => setIsPlaying(false)
    audio.addEventListener('timeupdate', onTimeUpdate)
    audio.addEventListener('durationchange', onDurationChange)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('ended', onEnded)
    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate)
      audio.removeEventListener('durationchange', onDurationChange)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('ended', onEnded)
    }
  }, [])

  const currentTrack = tracks.find(t => t.project_id === currentProjectId) ?? null

  const playTrack = useCallback((projectId: string) => {
    const audio = audioRef.current
    if (!audio) return
    const track = tracks.find(t => t.project_id === projectId)
    if (!track) return
    if (currentProjectId !== projectId) {
      audio.src = audioProxyUrl(track.audio_url)
      setCurrentProjectId(projectId)
      setCurrentTime(0)
      setDuration(0)
    }
    audio.volume = volume
    audio.play().catch(() => {})
  }, [tracks, currentProjectId, volume])

  const pause = useCallback(() => {
    audioRef.current?.pause()
  }, [])

  const togglePlay = useCallback(() => {
    const audio = audioRef.current
    if (!audio || !currentTrack) return
    if (isPlaying) audio.pause()
    else audio.play().catch(() => {})
  }, [isPlaying, currentTrack])

  const seek = useCallback((time: number) => {
    if (audioRef.current) audioRef.current.currentTime = time
  }, [])

  const setVolume = useCallback((v: number) => {
    setVolumeState(v)
    if (audioRef.current) audioRef.current.volume = v
  }, [])

  const next = useCallback(() => {
    if (!currentProjectId || tracks.length === 0) return
    const idx = tracks.findIndex(t => t.project_id === currentProjectId)
    const nextTrack = tracks[(idx + 1) % tracks.length]
    if (nextTrack) playTrack(nextTrack.project_id)
  }, [tracks, currentProjectId, playTrack])

  const prev = useCallback(() => {
    if (!currentProjectId || tracks.length === 0) return
    const idx = tracks.findIndex(t => t.project_id === currentProjectId)
    const prevTrack = tracks[(idx - 1 + tracks.length) % tracks.length]
    if (prevTrack) playTrack(prevTrack.project_id)
  }, [tracks, currentProjectId, playTrack])

  return (
    <PlayerContext.Provider value={{
      tracks,
      currentTrack,
      isPlaying,
      currentTime,
      duration,
      volume,
      playTrack,
      pause,
      togglePlay,
      seek,
      setVolume,
      next,
      prev,
    }}>
      {/* Hidden audio element — persists for the lifetime of the app session */}
      <audio ref={audioRef} style={{ display: 'none' }} />
      {children}
    </PlayerContext.Provider>
  )
}

export function usePlayer() {
  const ctx = useContext(PlayerContext)
  if (!ctx) throw new Error('usePlayer must be used within PlayerProvider')
  return ctx
}
