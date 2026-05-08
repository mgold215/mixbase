'use client'

import { createContext, useContext, useEffect, useRef, useState, useCallback, useMemo, type ReactNode, type RefObject } from 'react'
import type { Track } from '@/app/api/tracks/route'
import { audioProxyUrl } from '@/lib/supabase'
import { applyMediaSession } from '@/lib/media-session'

type PlayerCtx = {
  tracks: Track[]
  loading: boolean
  /** True when all fetch attempts failed — tracks is empty due to error, not genuinely no tracks */
  loadError: boolean
  currentTrack: Track | null
  isPlaying: boolean
  currentTime: number
  duration: number
  volume: number
  currentUrl: string | null
  /** The persistent <audio> element — share with the full player for seamless handoff */
  audioRef: RefObject<HTMLAudioElement | null>
  playTrack: (projectId: string) => void
  /** Play any URL through the shared audio element (shows in mini player) */
  playUrl: (url: string, title: string, artist?: string, artworkUrl?: string, versionLabel?: string) => void
  pause: () => void
  togglePlay: () => void
  seek: (time: number) => void
  setVolume: (v: number) => void
  next: () => void
  prev: () => void
  /** Re-fetch the track list (e.g. after a failed initial load) */
  reloadTracks: () => void
  /** Lazily initialises the Web Audio EQ chain on the shared <audio> element (call once on first interaction) */
  ensureAudioChain: () => void
  setEQGains: (bass: number, mid: number, treble: number) => void
}

const PlayerContext = createContext<PlayerCtx | null>(null)

export function PlayerProvider({ children }: { children: ReactNode }) {
  const [tracks, setTracks] = useState<Track[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolumeState] = useState(0.85)
  const audioRef = useRef<HTMLAudioElement>(null)
  const [currentUrl, setCurrentUrl] = useState<string | null>(null)
  const [customMeta, setCustomMeta] = useState<{
    title: string; artist: string; artwork_url: string | null; versionLabel: string
  } | null>(null)

  // EQ chain — created lazily on first interaction with the full player
  const audioCtxRef = useRef<AudioContext | null>(null)
  const bassRef = useRef<BiquadFilterNode | null>(null)
  const midRef = useRef<BiquadFilterNode | null>(null)
  const trebleRef = useRef<BiquadFilterNode | null>(null)

  // Tracks user *intent* to play — iOS can pause the audio element before visibilitychange
  // fires, so we can't rely on audio.paused to know if we should restore playback.
  const playIntentRef = useRef(false)

  // Stable ref to the most recent media session metadata so onPlay (a [] effect) can
  // re-apply it AFTER the iOS audio session activates — some iOS versions ignore metadata
  // set before play() resolves. Also re-applied on visibilitychange because iOS can clear
  // metadata when the PWA is backgrounded.
  const mediaMetaRef = useRef<{ title: string; artist: string; artworkUrl: string | null } | null>(null)

  // User's artist name from /api/auth/me — fetched once per session and used as the
  // default artist for all playback. Falls back to 'mixBASE' until the fetch resolves.
  const artistFallbackRef = useRef<string>('mixBASE')

  // Load tracks once on mount — retry once after 3 s on failure
  useEffect(() => {
    const load = () => fetch('/api/tracks')
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json() })
      .then((d: Track[]) => { setTracks(d); setLoading(false); setLoadError(false) })
    load().catch(() => setTimeout(() => load().catch(() => { setLoading(false); setLoadError(true) }), 3000))
  }, [])

  // Cache the user's artist_name once so playUrl callers don't have to thread it through
  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.ok ? r.json() : null)
      .then((d: { artist_name?: string; display_name?: string } | null) => {
        const name = d?.artist_name?.trim() || d?.display_name?.trim()
        if (name) artistFallbackRef.current = name
      })
      .catch(() => {})
  }, [])

  // When the app becomes visible after being hidden and the last load errored, retry.
  // This covers the iOS PWA case where the app wakes up before the network is ready.
  useEffect(() => {
    if (!loadError) return
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      setLoading(true)
      setLoadError(false)
      fetch('/api/tracks')
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json() })
        .then((d: Track[]) => { setTracks(d); setLoading(false) })
        .catch(() => { setLoading(false); setLoadError(true) })
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [loadError])

  const reloadTracks = useCallback(() => {
    setLoading(true)
    setLoadError(false)
    const load = () => fetch('/api/tracks')
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json() })
      .then((d: Track[]) => { setTracks(d); setLoading(false) })
    load().catch(() => setTimeout(() => load().catch(() => { setLoading(false); setLoadError(true) }), 3000))
  }, [])

  // Wire up audio event listeners
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const onTimeUpdate = () => setCurrentTime(audio.currentTime)
    const onDurationChange = () => setDuration(isNaN(audio.duration) ? 0 : audio.duration)
    const onPlay = () => {
      setIsPlaying(true)
      // Re-apply full metadata after iOS activates the audio session — iOS sometimes
      // ignores metadata set before play() resolves, so we push it again on the play event.
      if (mediaMetaRef.current) {
        const m = mediaMetaRef.current
        applyMediaSession(m.title, m.artist, m.artworkUrl, true)
      } else if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'playing'
      }
    }
    const onPause = () => {
      setIsPlaying(false)
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'
    }
    const onEnded = () => { playIntentRef.current = false; setIsPlaying(false) }
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

  const currentTrack = useMemo<Track | null>(() => {
    if (currentProjectId) return tracks.find(t => t.project_id === currentProjectId) ?? null
    if (customMeta && currentUrl) return {
      id: '__custom__',
      project_id: '__custom__',
      share_token: null,
      title: customMeta.title,
      artist: customMeta.artist,
      artwork_url: customMeta.artwork_url,
      audio_url: currentUrl,
      status: 'WIP',
      version: customMeta.versionLabel,
      uploaded_at: 0,
      key_signature: null,
      bpm: null,
    }
    return null
  }, [currentProjectId, customMeta, currentUrl, tracks])

  useEffect(() => {
    if (!('mediaSession' in navigator) || duration <= 0) return
    try {
      navigator.mediaSession.setPositionState({ duration, position: Math.min(currentTime, duration), playbackRate: 1 })
    } catch { /* position race */ }
  }, [currentTime, duration])

  // ── visibilitychange — resume AudioContext + audio element after iOS suspends ─
  // iOS can pause <audio> *before* firing visibilitychange:hidden, so we track
  // user intent (playIntentRef) rather than the live audio.paused value.
  // Also re-push MediaSession metadata: iOS clears Now Playing info when the PWA
  // is backgrounded, leaving Tesla / lock-screen widgets blank until we re-set it.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        const ctx = audioCtxRef.current
        if (ctx && ctx.state !== 'running') {
          ctx.resume().catch(() => {})
        }
        if (playIntentRef.current && audioRef.current?.paused) {
          audioRef.current.play().catch(() => {})
        }
        if (mediaMetaRef.current && !audioRef.current?.paused) {
          const m = mediaMetaRef.current
          applyMediaSession(m.title, m.artist, m.artworkUrl, true)
        }
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  // ── pageshow — iOS sometimes fires this instead of visibilitychange on unlock
  useEffect(() => {
    const onPageShow = () => {
      const ctx = audioCtxRef.current
      if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {})
      if (playIntentRef.current && audioRef.current?.paused) {
        audioRef.current.play().catch(() => {})
      }
    }
    window.addEventListener('pageshow', onPageShow)
    return () => window.removeEventListener('pageshow', onPageShow)
  }, [])

  // ── stalled / interrupted recovery — iOS can silently pause audio
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const onStalled = () => {
      if (playIntentRef.current && audio.paused) {
        const ctx = audioCtxRef.current
        if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {})
        audio.play().catch(() => {})
      }
    }
    audio.addEventListener('stalled', onStalled)
    return () => audio.removeEventListener('stalled', onStalled)
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
    // iOS suspends the AudioContext when backgrounded; re-resume it so background playback continues.
    // Use playIntentRef rather than audio.paused — iOS may pause the element before suspending the context.
    ctx.onstatechange = () => {
      if (ctx.state === 'suspended' && playIntentRef.current) {
        ctx.resume().then(() => {
          // Restart the audio element too if iOS paused it alongside the context
          if (audioRef.current?.paused) audioRef.current.play().catch(() => {})
        }).catch(() => {})
      }
    }
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
      const url = audioProxyUrl(track.audio_url)
      audio.src = url
      setCurrentProjectId(projectId)
      setCurrentUrl(url)
      setCustomMeta(null)
      setCurrentTime(0)
      setDuration(0)
    }
    const trackArtist = track.artist?.trim() || artistFallbackRef.current
    mediaMetaRef.current = { title: track.title, artist: trackArtist, artworkUrl: track.artwork_url }
    applyMediaSession(track.title, trackArtist, track.artwork_url, true)
    audio.volume = volume
    playIntentRef.current = true
    if (audioCtxRef.current?.state === 'suspended') audioCtxRef.current.resume().catch(() => {})
    audio.play().catch(() => {})
  }, [tracks, currentProjectId, volume])

  const playUrl = useCallback((url: string, title: string, artist?: string, artworkUrl?: string, versionLabel = '') => {
    const audio = audioRef.current
    if (!audio) return
    if (currentUrl !== url || currentProjectId !== null) {
      audio.src = url
      setCurrentTime(0)
      setDuration(0)
    }
    const resolvedArtist = artist?.trim() || artistFallbackRef.current
    setCurrentUrl(url)
    setCurrentProjectId(null)
    setCustomMeta({ title, artist: resolvedArtist, artwork_url: artworkUrl ?? null, versionLabel })
    mediaMetaRef.current = { title, artist: resolvedArtist, artworkUrl: artworkUrl ?? null }
    applyMediaSession(title, resolvedArtist, artworkUrl ?? null, true)
    audio.volume = volume
    playIntentRef.current = true
    if (audioCtxRef.current?.state === 'suspended') audioCtxRef.current.resume().catch(() => {})
    audio.play().catch(() => {})
  }, [currentUrl, currentProjectId, volume])

  const pause = useCallback(() => {
    playIntentRef.current = false
    audioRef.current?.pause()
  }, [])

  const togglePlay = useCallback(() => {
    const audio = audioRef.current
    if (!audio || !currentTrack) return
    if (audioCtxRef.current?.state === 'suspended') audioCtxRef.current.resume().catch(() => {})
    if (isPlaying) {
      playIntentRef.current = false
      audio.pause()
    } else {
      if (currentTrack) {
        const reuseArtist =
          mediaMetaRef.current?.artist ||
          currentTrack.artist?.trim() ||
          artistFallbackRef.current
        applyMediaSession(currentTrack.title, reuseArtist, currentTrack.artwork_url, true)
      }
      playIntentRef.current = true
      audio.play().catch(() => {})
    }
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
    set('play',          () => { playIntentRef.current = true; audioRef.current?.play().catch(() => {}) })
    set('pause',         () => { playIntentRef.current = false; audioRef.current?.pause() })
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
      loadError,
      currentTrack,
      isPlaying,
      currentTime,
      duration,
      volume,
      currentUrl,
      audioRef,
      playTrack,
      playUrl,
      pause,
      togglePlay,
      seek,
      setVolume,
      next,
      prev,
      reloadTracks,
      ensureAudioChain,
      setEQGains,
    }}>
      {/* Hidden audio element — persists for the lifetime of the app session.
          Do NOT use display:none — iOS needs the element in the render tree
          for proper background audio session registration.
          playsInline is REQUIRED for iOS background audio in PWAs. */}
      <audio ref={audioRef} playsInline preload="auto" style={{ position: 'fixed', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }} />
      {children}
    </PlayerContext.Provider>
  )
}

export function usePlayer() {
  const ctx = useContext(PlayerContext)
  if (!ctx) throw new Error('usePlayer must be used within PlayerProvider')
  return ctx
}
