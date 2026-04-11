'use client'

import { createContext, useContext, useEffect, useRef, useState, useCallback, type ReactNode, type RefObject } from 'react'
import type { Track } from '@/app/api/tracks/route'
import { audioProxyUrl } from '@/lib/supabase'

type PlayerCtx = {
  tracks: Track[]
  loading: boolean
  currentTrack: Track | null
  isPlaying: boolean
  currentTime: number
  duration: number
  volume: number
  /** The persistent <audio> element — share with the full player for seamless handoff */
  audioRef: RefObject<HTMLAudioElement | null>
  playTrack: (projectId: string) => void
  pause: () => void
  togglePlay: () => void
  seek: (time: number) => void
  setVolume: (v: number) => void
  next: () => void
  prev: () => void
  /** Lazily initialises the Web Audio EQ chain on the shared <audio> element (call once on first interaction) */
  ensureAudioChain: () => void
  setEQGains: (bass: number, mid: number, treble: number) => void
}

const PlayerContext = createContext<PlayerCtx | null>(null)

export function PlayerProvider({ children }: { children: ReactNode }) {
  const [tracks, setTracks] = useState<Track[]>([])
  const [loading, setLoading] = useState(true)
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolumeState] = useState(0.85)
  const audioRef = useRef<HTMLAudioElement>(null)

  // EQ chain — created lazily on first interaction with the full player
  const audioCtxRef = useRef<AudioContext | null>(null)
  const bassRef = useRef<BiquadFilterNode | null>(null)
  const midRef = useRef<BiquadFilterNode | null>(null)
  const trebleRef = useRef<BiquadFilterNode | null>(null)

  // Load tracks once on mount
  useEffect(() => {
    fetch('/api/tracks')
      .then(r => r.json())
      .then((d: Track[]) => { setTracks(d); setLoading(false) })
      .catch(() => setLoading(false))
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

  // ── Media Session API ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!('mediaSession' in navigator) || !currentTrack) return
    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentTrack.title,
      artist: currentTrack.artist,
      artwork: currentTrack.artwork_url
        ? [{ src: currentTrack.artwork_url, sizes: '512x512', type: 'image/jpeg' }]
        : [],
    })
  }, [currentTrack])

  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused'
  }, [isPlaying])

  useEffect(() => {
    if (!('mediaSession' in navigator) || duration <= 0) return
    try {
      navigator.mediaSession.setPositionState({ duration, position: Math.min(currentTime, duration), playbackRate: 1 })
    } catch { /* position race */ }
  }, [currentTime, duration])

  // ── visibilitychange — resume AudioContext + audio element after iOS suspends ─
  useEffect(() => {
    let wasPlaying = false
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        wasPlaying = !(audioRef.current?.paused ?? true)
      } else if (document.visibilityState === 'visible') {
        if (audioCtxRef.current?.state !== 'running') {
          audioCtxRef.current?.resume().catch(() => {})
        }
        if (wasPlaying && audioRef.current?.paused) {
          audioRef.current.play().catch(() => {})
        }
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  // ── EQ chain ─────────────────────────────────────────────────────────────────
  const ensureAudioChain = useCallback(() => {
    if (audioCtxRef.current || !audioRef.current) return
    const ctx = new AudioContext()
    const src = ctx.createMediaElementSource(audioRef.current)
    const bass = ctx.createBiquadFilter(); bass.type = 'lowshelf'; bass.frequency.value = 200
    const mid = ctx.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = 1200; mid.Q.value = 1.2
    const treble = ctx.createBiquadFilter(); treble.type = 'highshelf'; treble.frequency.value = 4000
    src.connect(bass); bass.connect(mid); mid.connect(treble); treble.connect(ctx.destination)
    audioCtxRef.current = ctx
    bassRef.current = bass; midRef.current = mid; trebleRef.current = treble
  }, [])

  const setEQGains = useCallback((bass: number, mid: number, treble: number) => {
    if (bassRef.current) bassRef.current.gain.value = bass
    if (midRef.current) midRef.current.gain.value = mid
    if (trebleRef.current) trebleRef.current.gain.value = treble
  }, [])

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
    if (audioCtxRef.current?.state === 'suspended') audioCtxRef.current.resume().catch(() => {})
    audio.play().catch(() => {})
  }, [tracks, currentProjectId, volume])

  const pause = useCallback(() => {
    audioRef.current?.pause()
  }, [])

  const togglePlay = useCallback(() => {
    const audio = audioRef.current
    if (!audio || !currentTrack) return
    if (audioCtxRef.current?.state === 'suspended') audioCtxRef.current.resume().catch(() => {})
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

  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const set = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try { navigator.mediaSession.setActionHandler(action, handler) } catch { /* unsupported */ }
    }
    set('play',          () => audioRef.current?.play().catch(() => {}))
    set('pause',         () => audioRef.current?.pause())
    set('previoustrack', () => prev())
    set('nexttrack',     () => next())
    set('seekto',        (d) => { if (d.seekTime != null && audioRef.current) audioRef.current.currentTime = d.seekTime })
    set('seekbackward',  (d) => { if (audioRef.current) audioRef.current.currentTime = Math.max(0, audioRef.current.currentTime - (d.seekOffset ?? 10)) })
    set('seekforward',   (d) => { if (audioRef.current) audioRef.current.currentTime = Math.min(audioRef.current.duration || 0, audioRef.current.currentTime + (d.seekOffset ?? 10)) })
    return () => {
      ;(['play','pause','previoustrack','nexttrack','seekto','seekbackward','seekforward'] as MediaSessionAction[])
        .forEach(a => set(a, null))
    }
  }, [prev, next])

  return (
    <PlayerContext.Provider value={{
      tracks,
      loading,
      currentTrack,
      isPlaying,
      currentTime,
      duration,
      volume,
      audioRef,
      playTrack,
      pause,
      togglePlay,
      seek,
      setVolume,
      next,
      prev,
      ensureAudioChain,
      setEQGains,
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
