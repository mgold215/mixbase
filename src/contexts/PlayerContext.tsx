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
  /** True while the engine is buffering/seeking with intent to play — use to show a spinner
   *  instead of a fake "playing" animation. */
  buffering: boolean
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
  const [buffering, setBuffering] = useState(false)
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

  // True between calling play() and playback actually starting. If play() rejects with
  // AbortError (the load was interrupted — the #1 cause of "I clicked play and nothing
  // happened"), the 'canplay' listener retries while this is set. Cleared once 'playing'
  // fires or play() resolves.
  const pendingPlayRef = useRef(false)

  // A seek requested before metadata loaded (e.g. restoring last position). Applied on
  // 'loadedmetadata' since setting currentTime before the media is seekable is a no-op.
  const pendingSeekRef = useRef<number | null>(null)

  // Live mirror of currentProjectId so the (mount-once) audio event listeners can read it
  // without re-subscribing on every track change.
  const currentProjectIdRef = useRef<string | null>(null)
  useEffect(() => { currentProjectIdRef.current = currentProjectId }, [currentProjectId])

  // Stable ref to the most recent media session metadata so onPlay (a [] effect) can
  // re-apply it AFTER the iOS audio session activates — some iOS versions ignore metadata
  // set before play() resolves.
  const mediaMetaRef = useRef<{ title: string; artworkUrl: string | null; artist?: string } | null>(null)

  // Timestamp of last successful track fetch — used to avoid hammering on visibility
  const lastFetchRef = useRef(0)

  // Restore last-played track + position from localStorage.
  // Defined before the load effects so it can be called from their .then() callbacks.
  const restoreLastTrack = useCallback((trackList: Track[]) => {
    if (restoredRef.current) return
    restoredRef.current = true
    try {
      const raw = localStorage.getItem('mx-last-track')
      if (!raw) return
      const { projectId, time } = JSON.parse(raw) as { projectId: string; time: number }
      const track = trackList.find(t => t.project_id === projectId)
      if (!track) return
      const audio = audioRef.current
      if (!audio) return
      const url = audioProxyUrl(track.audio_url)
      audio.src = url
      // Setting currentTime now is a no-op (media not seekable yet) — defer to loadedmetadata.
      pendingSeekRef.current = time
      setCurrentProjectId(projectId)
      setCurrentUrl(url)
      setCurrentTime(time)
      mediaMetaRef.current = { title: track.title, artworkUrl: track.artwork_url, artist: track.artist }
      applyMediaSession(track.title, track.artwork_url, false, track.artist)
    } catch {}
  }, [])

  // Load tracks once on mount — retry once after 3 s on failure
  useEffect(() => {
    const load = () => fetch('/api/tracks')
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json() })
      .then((d: Track[]) => { setTracks(d); setLoading(false); setLoadError(false); lastFetchRef.current = Date.now(); restoreLastTrack(d) })
    load().catch(() => setTimeout(() => load().catch(() => { setLoading(false); setLoadError(true) }), 3000))
  }, [restoreLastTrack])

  // Re-fetch tracks when the app becomes visible (tab switch, phone unlock, PWA resume).
  // On error: retry immediately. On success: only re-fetch if stale (>60s since last load).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      // Always retry on error; otherwise only if data is stale
      if (!loadError && Date.now() - lastFetchRef.current < 60_000) return
      setLoadError(false)
      fetch('/api/tracks')
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json() })
        .then((d: Track[]) => { setTracks(d); setLoading(false); setLoadError(false); lastFetchRef.current = Date.now() })
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
      .then((d: Track[]) => { setTracks(d); setLoading(false); lastFetchRef.current = Date.now() })
    load().catch(() => setTimeout(() => load().catch(() => { setLoading(false); setLoadError(true) }), 3000))
  }, [])

  // ── Persist playback position to localStorage so it survives navigation ────
  // Save every 5 seconds (not every timeupdate) to avoid thrashing storage.
  const lastSaveRef = useRef(0)
  const savePosition = useCallback((projectId: string | null, time: number) => {
    if (!projectId || time < 1) return
    const now = Date.now()
    if (now - lastSaveRef.current < 5000) return
    lastSaveRef.current = now
    try { localStorage.setItem('mx-last-track', JSON.stringify({ projectId, time: Math.floor(time) })) } catch {}
  }, [])

  // Restore last position on mount (before any user interaction)
  const restoredRef = useRef(false)

  // ── Audio engine event wiring ──────────────────────────────────────────────
  // Mounted once. Reads currentProjectId via a ref so it never re-subscribes (which
  // previously dropped events mid-track-change). Covers the FULL lifecycle so the UI
  // state can never get stuck out of sync with the real element:
  //   play/playing → playing   waiting/seeking → buffering   pause/ended/error/emptied → stopped
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const syncDuration = () => setDuration(isNaN(audio.duration) ? 0 : audio.duration)

    const onTimeUpdate = () => {
      setCurrentTime(audio.currentTime)
      // Safety net: if time is advancing, the element is truly playing — clear any
      // stale buffering/paused flags so the UI can never be stuck showing a spinner
      // (or a fake "paused") while audio is actually coming out. setState to the same
      // value is a no-op in React, so this doesn't churn renders.
      if (!audio.paused) { setBuffering(false); setIsPlaying(true) }
      savePosition(currentProjectIdRef.current, audio.currentTime)
    }
    const onLoadedMeta = () => {
      syncDuration()
      // Apply any seek requested before the media was seekable (e.g. restored position).
      if (pendingSeekRef.current != null) {
        const t = pendingSeekRef.current
        pendingSeekRef.current = null
        try { audio.currentTime = Math.min(t, audio.duration || t) } catch { /* not seekable */ }
      }
    }
    const onPlay = () => {
      // Optimistic: the engine is running. 'playing'/'waiting' refine buffering below.
      setIsPlaying(true)
      // Re-apply full metadata after iOS activates the audio session — iOS sometimes
      // ignores metadata set before play() resolves, so we push it again on the play event.
      if (mediaMetaRef.current) {
        applyMediaSession(mediaMetaRef.current.title, mediaMetaRef.current.artworkUrl, true, mediaMetaRef.current.artist)
      } else if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'playing'
      }
    }
    const onPlaying = () => {
      // Audio is actually producing output now — this is the truthful "playing" signal.
      pendingPlayRef.current = false
      setIsPlaying(true)
      setBuffering(false)
    }
    const onWaiting = () => {
      // Stalled waiting for data while we intend to play → buffering, not playing.
      if (playIntentRef.current) setBuffering(true)
    }
    const onCanPlay = () => {
      setBuffering(false)
      // If an earlier play() was aborted by the load (AbortError), retry now that the
      // resource is ready. This is what kills "had to click play several times".
      if (pendingPlayRef.current && playIntentRef.current && audio.paused) {
        audio.play().then(() => { pendingPlayRef.current = false }).catch(() => {})
      }
    }
    const onPause = () => {
      setIsPlaying(false)
      setBuffering(false)
      pendingPlayRef.current = false
      // Force-save position on pause so we don't lose it
      const pid = currentProjectIdRef.current
      if (pid && audio.currentTime > 1) {
        try { localStorage.setItem('mx-last-track', JSON.stringify({ projectId: pid, time: Math.floor(audio.currentTime) })) } catch {}
      }
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'
    }
    const onEnded = () => {
      playIntentRef.current = false
      pendingPlayRef.current = false
      setIsPlaying(false)
      setBuffering(false)
    }
    const onError = () => {
      // Load/decode failed — clear all "in flight" flags so the UI doesn't lie.
      pendingPlayRef.current = false
      setIsPlaying(false)
      setBuffering(false)
    }
    const onEmptied = () => {
      // src was swapped out. If no play is queued, we're stopped; reset progress.
      if (!pendingPlayRef.current) {
        setIsPlaying(false)
        setBuffering(false)
      }
    }

    audio.addEventListener('timeupdate', onTimeUpdate)
    audio.addEventListener('durationchange', syncDuration)
    audio.addEventListener('loadedmetadata', onLoadedMeta)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('playing', onPlaying)
    audio.addEventListener('waiting', onWaiting)
    audio.addEventListener('canplay', onCanPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('ended', onEnded)
    audio.addEventListener('error', onError)
    audio.addEventListener('emptied', onEmptied)
    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate)
      audio.removeEventListener('durationchange', syncDuration)
      audio.removeEventListener('loadedmetadata', onLoadedMeta)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('playing', onPlaying)
      audio.removeEventListener('waiting', onWaiting)
      audio.removeEventListener('canplay', onCanPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('error', onError)
      audio.removeEventListener('emptied', onEmptied)
    }
  }, [savePosition])

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
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        const ctx = audioCtxRef.current
        if (ctx && ctx.state !== 'running') {
          ctx.resume().catch(() => {})
        }
        if (playIntentRef.current && audioRef.current?.paused) {
          pendingPlayRef.current = true
          audioRef.current.play().then(() => { pendingPlayRef.current = false }).catch(() => {})
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
        pendingPlayRef.current = true
        audioRef.current.play().then(() => { pendingPlayRef.current = false }).catch(() => {})
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
        pendingPlayRef.current = true
        audio.play().then(() => { pendingPlayRef.current = false }).catch(() => {})
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

  // Single entry point for starting playback. Handles the play() promise robustly:
  //  - resumes a suspended Web Audio context first (required for output)
  //  - on AbortError (load interrupted by a track switch) leaves pendingPlayRef set so the
  //    'canplay' listener retries automatically — no lost clicks
  //  - on NotAllowedError (autoplay blocked, no user gesture) clears intent cleanly so the
  //    UI shows "paused" rather than a fake "playing" state
  const attemptPlay = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    playIntentRef.current = true
    pendingPlayRef.current = true
    if (audioCtxRef.current?.state === 'suspended') audioCtxRef.current.resume().catch(() => {})
    // Only show buffering if we're genuinely not playing yet. Re-triggering an
    // already-playing element fires no 'playing' event, which would otherwise leave
    // the spinner stuck on.
    if (audio.paused || audio.readyState < 3 /* HAVE_FUTURE_DATA */) setBuffering(true)
    const p = audio.play()
    if (p && typeof p.then === 'function') {
      p.then(() => { pendingPlayRef.current = false })
       .catch((err: { name?: string }) => {
         if (err?.name === 'NotAllowedError') {
           // Needs a fresh user gesture — don't pretend we're playing.
           pendingPlayRef.current = false
           playIntentRef.current = false
           setIsPlaying(false)
           setBuffering(false)
         }
         // AbortError / other transient load errors: keep pendingPlayRef set; 'canplay' retries.
       })
    }
  }, [])

  const playTrack = useCallback((projectId: string) => {
    const audio = audioRef.current
    if (!audio) return
    const track = tracks.find(t => t.project_id === projectId)
    if (!track) return
    if (currentProjectId !== projectId) {
      const url = audioProxyUrl(track.audio_url)
      pendingSeekRef.current = null
      audio.src = url
      setCurrentProjectId(projectId)
      setCurrentUrl(url)
      setCustomMeta(null)
      setCurrentTime(0)
      setDuration(0)
    }
    mediaMetaRef.current = { title: track.title, artworkUrl: track.artwork_url, artist: track.artist }
    applyMediaSession(track.title, track.artwork_url, true, track.artist)
    audio.volume = volume
    attemptPlay()
  }, [tracks, currentProjectId, volume, attemptPlay])

  const playUrl = useCallback((url: string, title: string, artist = 'mixBASE', artworkUrl?: string, versionLabel = '') => {
    const audio = audioRef.current
    if (!audio) return
    if (currentUrl !== url || currentProjectId !== null) {
      pendingSeekRef.current = null
      audio.src = url
      setCurrentTime(0)
      setDuration(0)
    }
    setCurrentUrl(url)
    setCurrentProjectId(null)
    setCustomMeta({ title, artist, artwork_url: artworkUrl ?? null, versionLabel })
    mediaMetaRef.current = { title, artworkUrl: artworkUrl ?? null, artist }
    applyMediaSession(title, artworkUrl ?? null, true, artist)
    audio.volume = volume
    attemptPlay()
  }, [currentUrl, currentProjectId, volume, attemptPlay])

  const pause = useCallback(() => {
    playIntentRef.current = false
    pendingPlayRef.current = false
    audioRef.current?.pause()
  }, [])

  // Reads the element's *real* paused state, not React's isPlaying — the two can diverge
  // (a stalled/errored load stops audio without a pause event), and trusting stale state
  // was a source of "click play twice".
  const togglePlay = useCallback(() => {
    const audio = audioRef.current
    if (!audio || !currentTrack) return
    if (audio.paused) {
      applyMediaSession(currentTrack.title, currentTrack.artwork_url, true, currentTrack.artist)
      audio.volume = volume
      attemptPlay()
    } else {
      playIntentRef.current = false
      pendingPlayRef.current = false
      audio.pause()
    }
  }, [currentTrack, volume, attemptPlay])

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
      buffering,
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
