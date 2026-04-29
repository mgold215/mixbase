'use client'

import { useEffect, useRef, useState, useCallback, useMemo, type ChangeEvent } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import {
  Play, Pause, SkipBack, SkipForward, Shuffle, Volume2, Music,
  Repeat, Repeat1, Search, ListMusic, Menu, X, Share2, Check, ChevronDown,
} from 'lucide-react'
import type { Track } from '../api/tracks/route'
import { formatDuration, audioProxyUrl } from '@/lib/supabase'
import { analyzeAudioUrl, extractDominantColor } from '@/lib/audio-analysis'
import Nav from '@/components/Nav'
import { usePlayer } from '@/contexts/PlayerContext'

type LoopMode = 'none' | 'all' | 'one'
type SortKey = 'title' | 'date'

const WAVEFORM_BARS = 100

function generateWaveform(seed: string, count: number): number[] {
  let h = seed.length > 0
    ? seed.split('').reduce((a, c) => ((a * 31 + c.charCodeAt(0)) | 0), 0x811c9dc5)
    : 0x811c9dc5
  const raw = Array.from({ length: count }, (_, i) => {
    h = ((h * 1664525 + 1013904223) >>> 0) ^ (i * 2654435761)
    return (h >>> 0) / 0xffffffff
  })
  // 3-point smooth so adjacent bars don't spike wildly
  return raw.map((v, i) => {
    const p = i > 0 ? raw[i - 1] : v
    const n = i < raw.length - 1 ? raw[i + 1] : v
    const s = (p + v * 2 + n) / 4
    return 0.08 + s * 0.65  // clamp to 8–73%, no bar reaches full height
  })
}

// Map version status → short tag + color
function statusTag(status: string): { label: string; color: string } {
  switch (status) {
    case 'WIP':        return { label: 'WIP',       color: '#facc15' }
    case 'Mix/Master': return { label: 'MIX/MSTR',  color: '#60a5fa' }
    case 'Finished':   return { label: 'FINISHED',  color: '#34d399' }
    case 'Released':   return { label: 'RELEASED',  color: '#c084fc' }
    default:           return { label: status.toUpperCase(), color: '#ffffff' }
  }
}


export default function PlayerPage() {
  const {
    tracks, loading, currentTrack, isPlaying, currentTime, duration,
    volume, playTrack, togglePlay, seek: ctxSeek, setVolume,
    audioRef,
  } = usePlayer()

  const router = useRouter()
  const [filtered, setFiltered] = useState<Track[]>([])
  const [loopMode, setLoopMode] = useState<LoopMode>('none')
  const [shuffle, setShuffle] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('date')
  const [search, setSearch] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  // BPM / key analysis
  const [trackBPM, setTrackBPM] = useState<number | null>(null)
  const [trackKey, setTrackKey] = useState<string | null>(null)

  // Accent color derived from album art
  const [accent, setAccent] = useState<[number, number, number]>([167, 139, 250])

  // Refs
  const analysisAbortRef = useRef<AbortController | null>(null)

  // current = whatever the shared audio engine is playing right now
  const current = currentTrack
  // index of current track within the filtered sidebar list (for nav + highlight)
  const currentIdx = filtered.findIndex(t => t.project_id === currentTrack?.project_id)

  // ── Sort + search (uses tracks from context) ──────────────────────────────
  useEffect(() => {
    let list = [...tracks]
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(t => t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q))
    }
    list.sort((a, b) => sortKey === 'title' ? a.title.localeCompare(b.title) : b.uploaded_at - a.uploaded_at)
    setFiltered(list)
  }, [tracks, sortKey, search])

  // ── Deep-link / autoplay ───────────────────────────────────────────────────
  // If a ?track= param is present, switch to it (but don't restart if already on it).
  // If nothing is playing yet, autoplay the first track.
  useEffect(() => {
    if (filtered.length === 0) return
    const targetId = new URLSearchParams(window.location.search).get('track')
    if (targetId) {
      if (currentTrack?.project_id !== targetId) {
        const t = filtered.find(t => t.project_id === targetId)
        if (t) playTrack(t.project_id)
      }
    } else if (!currentTrack && filtered[0]) {
      playTrack(filtered[0].project_id)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered.length > 0 ? 'ready' : 'empty'])

  // ── Accent color from artwork ──────────────────────────────────────────────
  useEffect(() => {
    if (current?.artwork_url) {
      extractDominantColor(current.artwork_url).then(setAccent).catch(() => setAccent([167, 139, 250]))
    } else {
      setAccent([167, 139, 250])
    }
  }, [current])

  // ── BPM / key analysis ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!current) return
    analysisAbortRef.current?.abort()
    const abort = new AbortController()
    analysisAbortRef.current = abort
    setTrackBPM(null); setTrackKey(null)
    analyzeAudioUrl(audioProxyUrl(current.audio_url)).then(result => {
      if (abort.signal.aborted) return
      if (result) { setTrackBPM(result.bpm); setTrackKey(result.key) }
    })
  }, [current])


  // ── Playback (operates on shared context state + filtered list) ───────────
  const goTo = useCallback((idx: number) => {
    if (filtered[idx]) playTrack(filtered[idx].project_id)
  }, [filtered, playTrack])

  const next = useCallback(() => {
    if (filtered.length === 0) return
    const idx = currentIdx >= 0 ? currentIdx : 0
    if (shuffle) goTo(Math.floor(Math.random() * filtered.length))
    else goTo((idx + 1) % filtered.length)
  }, [shuffle, currentIdx, filtered.length, goTo])

  const prev = useCallback(() => {
    if (currentTime > 3) { ctxSeek(0); return }
    if (filtered.length === 0) return
    const idx = currentIdx >= 0 ? currentIdx : 0
    goTo((idx - 1 + filtered.length) % filtered.length)
  }, [currentIdx, currentTime, filtered.length, goTo, ctxSeek])

  // ── Loop mode: add ended listener to the shared audio element ────────────
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const handleEnded = () => {
      if (loopMode === 'one') { audio.play().catch(() => {}); return }
      if (loopMode === 'all') { next(); return }
      const idx = currentIdx >= 0 ? currentIdx : 0
      if (idx < filtered.length - 1) next()
    }
    audio.addEventListener('ended', handleEnded)
    return () => audio.removeEventListener('ended', handleEnded)
  }, [audioRef, loopMode, currentIdx, filtered.length, next])

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────────
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

  // ── Media Session: override context's action handlers with full-player nav ─
  // (shuffle + filtered-list next/prev). Context handles metadata + position state.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const set = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try { navigator.mediaSession.setActionHandler(action, handler) } catch { /* unsupported */ }
    }
    set('play',          () => togglePlay())
    set('pause',         () => togglePlay())
    set('previoustrack', () => prev())
    set('nexttrack',     () => next())
    set('seekbackward', (d) => {
      if (!audioRef.current) return
      audioRef.current.currentTime = Math.max(0, audioRef.current.currentTime - (d.seekOffset ?? 10))
    })
    set('seekforward', (d) => {
      if (!audioRef.current) return
      audioRef.current.currentTime = Math.min(duration, audioRef.current.currentTime + (d.seekOffset ?? 10))
    })
    set('seekto', (d) => {
      if (d.seekTime == null || !audioRef.current) return
      audioRef.current.currentTime = Math.min(d.seekTime, duration)
    })
    // On unmount, restore context's global handlers by re-triggering its effect
    return () => {
      ;(['play','pause','previoustrack','nexttrack','seekbackward','seekforward','seekto'] as MediaSessionAction[])
        .forEach(a => set(a, null))
    }
  }, [togglePlay, prev, next, duration, audioRef])

  // setPositionState with playbackRate (context handles the rest)
  useEffect(() => {
    if (!('mediaSession' in navigator) || duration <= 0) return
    try {
      navigator.mediaSession.setPositionState({
        duration,
        position: Math.min(currentTime, duration),
        playbackRate: 1,
      })
    } catch { /* guard against race where position > duration */ }
  }, [currentTime, duration])

  const seek = (e: ChangeEvent<HTMLInputElement>) => {
    ctxSeek(parseFloat(e.target.value))
  }

  const cycleLoop = () => setLoopMode(m => m === 'none' ? 'all' : m === 'all' ? 'one' : 'none')

  const handleShare = useCallback(() => {
    if (!current?.share_token) return
    const url = `${window.location.origin}/share/${current.share_token}`
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => {})
  }, [current])

  const pct = duration > 0 ? (currentTime / duration) * 100 : 0
  const accentCss = `rgb(${accent[0]},${accent[1]},${accent[2]})`
  const status = current ? statusTag(current.status) : null
  const bars = useMemo(() => generateWaveform(current?.project_id ?? '', WAVEFORM_BARS), [current?.project_id])

  // ── Empty state ────────────────────────────────────────────────────────────────
  if (!loading && tracks.length === 0) {  // tracks + loading come from PlayerContext
    return (
      <>
      <Nav />
      <div className="fixed top-14 left-0 right-0 flex flex-col items-center justify-center gap-4" style={{ bottom: 'var(--player-bottom, 0px)', backgroundColor: 'var(--bg-page)' }}>
        <ListMusic size={48} className="text-[var(--text-muted)]" />
        <p className="text-[var(--text-muted)]">No tracks yet.</p>
        <Link href="/dashboard" className="text-sm text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors">
          Go upload some mixes →
        </Link>
      </div>
      </>
    )
  }

  return (
    <>
    <Nav />
    <div className="fixed top-14 left-0 right-0 bg-black flex overflow-hidden select-none" style={{ bottom: 'var(--player-bottom, 0px)' }}>
      {/* No local <audio> — playback runs through the shared PlayerContext element */}

      {/* ── BIG album art backdrop (the whole screen) ─────────────────────────── */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        {current?.artwork_url && (
          <Image
            src={current.artwork_url} alt="" fill unoptimized
            className="object-cover transition-opacity duration-700"
            style={{ filter: 'blur(14px) saturate(1.5) brightness(0.6)' }}
          />
        )}
        {/* Vignette for readability */}
        <div className="absolute inset-0" style={{
          background: `
            radial-gradient(ellipse 90% 80% at 50% 45%, transparent 0%, rgba(0,0,0,0.35) 60%, rgba(0,0,0,0.75) 100%),
            radial-gradient(ellipse 80% 60% at 50% 50%, rgba(${accent[0]},${accent[1]},${accent[2]},0.18) 0%, transparent 70%)
          `,
        }} />
      </div>

      {/* ── Mobile backdrop (only when sidebar open) ─────────────────────── */}
      {sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          className="md:hidden absolute inset-0 bg-black/60 z-20"
        />
      )}

      {/* ── Sidebar: track list (fixed drawer on mobile, inline on desktop) ── */}
      <aside
        className={`
          flex flex-col z-30 transition-transform duration-300
          md:relative md:w-[340px] md:flex-shrink-0 md:translate-x-0
          absolute inset-y-0 left-0 w-[300px] max-w-[85vw]
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
        `}
        style={{
          background: 'rgba(6,12,11,0.92)',
          borderRight: '1px solid rgba(255,255,255,0.06)',
          backdropFilter: 'blur(24px)',
        }}>
        <div className="px-5 pt-6 pb-4">
          <div className="flex items-center justify-between mb-4">
            <p className="text-[10px] font-semibold tracking-[0.22em] text-[#777] uppercase">All Tracks</p>
            <button
              onClick={() => setSidebarOpen(false)}
              className="md:hidden p-1.5 rounded-md text-[#666] hover:text-white hover:bg-white/5 transition-colors"
              title="Close"
            >
              <X size={16} />
            </button>
          </div>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#555]" />
            <input
              type="text" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search tracks..."
              className="w-full bg-white/5 border border-white/10 rounded-lg pl-9 pr-3 py-2.5 text-sm text-white placeholder-[#555] focus:outline-none focus:border-white/20"
            />
          </div>
          <div className="flex gap-1 mt-3 p-1 rounded-lg bg-white/5">
            {(['date', 'title'] as SortKey[]).map(k => (
              <button key={k} onClick={() => setSortKey(k)}
                className={`text-[11px] px-3 py-1.5 rounded-md transition-all flex-1 font-medium ${sortKey === k ? 'bg-white/10 text-white' : 'text-[#666] hover:text-[#aaa]'}`}>
                {k === 'title' ? 'A–Z' : 'Recent'}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-3 pb-6">
          {loading ? Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-2 py-3">
              <div className="w-12 h-12 rounded-lg bg-white/5 animate-pulse flex-shrink-0" />
              <div className="flex-1 space-y-2">
                <div className="h-3 bg-white/5 rounded animate-pulse w-3/4" />
                <div className="h-2.5 bg-white/5 rounded animate-pulse w-1/2" />
              </div>
            </div>
          )) : filtered.map((t, i) => {
            const active = t.project_id === currentTrack?.project_id
            return (
              <button key={t.id} onClick={() => { goTo(i); setSidebarOpen(false) }}
                className={`w-full flex items-center gap-3 px-2.5 py-2.5 rounded-xl text-left transition-all mb-1 ${active ? 'bg-white/[0.08]' : 'hover:bg-white/[0.04]'}`}
                style={active ? { borderLeft: `2px solid ${accentCss}`, paddingLeft: 8 } : { borderLeft: '2px solid transparent' }}>
                <div className="w-12 h-12 rounded-lg overflow-hidden flex-shrink-0 bg-white/5 relative">
                  {t.artwork_url
                    ? <Image src={t.artwork_url} alt={t.title} fill className="object-cover" unoptimized />
                    : <div className="w-full h-full flex items-center justify-center"><Music size={16} className="text-[#444]" /></div>}
                  {active && isPlaying && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/45">
                      <div className="flex gap-[3px] items-end h-5">
                        {[1, 0.6, 0.85].map((h, j) => (
                          <div key={j} className="w-[3px] rounded-full animate-bounce"
                            style={{ height: `${h * 100}%`, backgroundColor: accentCss, animationDelay: `${j * 0.15}s` }} />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-medium truncate leading-tight ${active ? 'text-white' : 'text-[#ccc]'}`}>
                    {t.title}
                  </p>
                  <p className="text-xs text-[#666] truncate mt-1">
                    <span className="font-mono">v{String(t.version).replace(/^v/i, '')}</span>
                    <span className="mx-1.5 text-[#444]">·</span>
                    <span>{t.status}</span>
                  </p>
                </div>
              </button>
            )
          })}
        </div>
      </aside>

      {/* ── Main stage: artwork + full-width control bar ─────────────────── */}
      <main className="relative flex-1 flex flex-col overflow-hidden z-10">
        {/* Mobile hamburger — opens the track-list drawer */}
        <button
          onClick={() => setSidebarOpen(true)}
          className="md:hidden absolute top-3 left-3 z-20 p-2 rounded-lg bg-white/5 border border-white/10 text-white/80 hover:text-white hover:bg-white/10 transition-colors"
          title="Open track list"
        >
          <Menu size={18} />
        </button>
        {/* Minimize — go back */}
        <button
          onClick={() => router.back()}
          className="absolute top-3 right-3 z-20 p-2 rounded-lg bg-white/5 border border-white/10 text-white/60 hover:text-white hover:bg-white/10 transition-colors"
          title="Minimize player"
        >
          <ChevronDown size={18} />
        </button>
        {/* ── Full-bleed artwork area ── */}
        <div className="flex-1 relative min-h-0">
          {current && (
            <>
              {current.artwork_url ? (
                <Image src={current.artwork_url} alt={current.title} fill className="object-cover" unoptimized />
              ) : (
                <div className="absolute inset-0 bg-[#111] flex items-center justify-center">
                  <Music size={80} className="text-[#222]" />
                </div>
              )}
              {/* Bottom gradient + track info + waveform overlay */}
              {status && (
                <div
                  className="absolute bottom-0 left-0 right-0 pt-24"
                  style={{
                    background: `linear-gradient(to top,
                      rgba(6,12,11,0.97) 0%,
                      rgba(6,12,11,0.72) 18%,
                      rgba(${accent[0]},${accent[1]},${accent[2]},0.45) 40%,
                      rgba(${accent[0]},${accent[1]},${accent[2]},0.12) 72%,
                      transparent 100%
                    )`,
                  }}
                >
                  {/* Track info */}
                  <div className="px-5 pb-2">
                    <h2 className="text-2xl font-bold text-white leading-tight">{current.title}</h2>
                    <div className="flex flex-wrap items-center gap-x-2 mt-1">
                      <span className="font-mono text-sm text-white/50">v{String(current.version).replace(/^v/i, '')}</span>
                      <span className="text-white/20">·</span>
                      <span className="text-sm font-semibold" style={{ color: status.color }}>{status.label}</span>
                      {trackKey && <><span className="text-white/20">·</span><span className="text-sm font-mono text-white/50">{trackKey}</span></>}
                      {trackBPM && <><span className="text-white/20">·</span><span className="text-sm font-mono text-white/50">{trackBPM} BPM</span></>}
                    </div>
                  </div>

                  {/* Waveform scrubber */}
                  <div className="px-4 pt-2 pb-3">
                    <div
                      className="relative flex items-center gap-[1px] cursor-pointer"
                      style={{ height: 36 }}
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect()
                        ctxSeek(((e.clientX - rect.left) / rect.width) * duration)
                      }}
                    >
                      {bars.map((h, i) => {
                        const barPct = (i + 0.5) / WAVEFORM_BARS
                        const played = pct > 0 && barPct <= pct / 100
                        return (
                          <div
                            key={i}
                            className="flex-1 rounded-[1px]"
                            style={{
                              height: `${h * 100}%`,
                              minWidth: 0,
                              background: played ? accentCss : 'rgba(255,255,255,0.15)',
                              opacity: played ? 1 : 0.7,
                            }}
                          />
                        )
                      })}
                      {/* Playhead — 1px hairline with tight glow */}
                      <div
                        className="absolute top-[15%] bottom-[15%] w-px pointer-events-none"
                        style={{
                          left: `${pct}%`,
                          background: accentCss,
                          boxShadow: `0 0 6px ${accentCss}aa`,
                        }}
                      />
                      <input
                        type="range" min={0} max={duration || 0} step={0.1} value={currentTime}
                        onChange={seek}
                        className="absolute inset-0 w-full opacity-0 cursor-pointer"
                      />
                    </div>
                    <div className="flex justify-between mt-1">
                      <span className="text-[10px] text-white/40 font-mono tabular-nums">{formatDuration(Math.floor(currentTime))}</span>
                      <span className="text-[10px] text-white/30 font-mono tabular-nums">−{formatDuration(Math.max(0, Math.floor(duration - currentTime)))}</span>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* ── Full-width native-size control bar ───────────────────────────── */}
        {current && (
          <div
            className="flex-shrink-0 w-full border-t border-white/10 px-3 sm:px-6 py-3"
            style={{
              background: 'rgba(6,12,11,0.85)',
              backdropFilter: 'blur(24px)',
            }}
          >
            {/* ── Mobile: grid so transport is perfectly centered ── */}
            <div className="sm:hidden grid grid-cols-[1fr_auto_1fr] items-center">
              <div className="flex items-center gap-2">
                <button onClick={() => setShuffle(s => !s)}
                  className="p-2 transition-colors"
                  style={{ color: shuffle ? accentCss : 'rgba(255,255,255,0.55)' }}
                  title="Shuffle"><Shuffle size={20} /></button>
                <button onClick={cycleLoop}
                  className="p-2 transition-colors"
                  style={{ color: loopMode !== 'none' ? accentCss : 'rgba(255,255,255,0.55)' }}
                  title={`Loop: ${loopMode}`}>
                  {loopMode === 'one' ? <Repeat1 size={20} /> : <Repeat size={20} />}
                </button>
              </div>
              <div className="flex items-center gap-3">
                <button onClick={prev} className="p-2 text-white/75 hover:text-white transition-colors" title="Previous">
                  <SkipBack size={26} fill="currentColor" />
                </button>
                <button onClick={togglePlay}
                  className="w-14 h-14 rounded-full flex items-center justify-center transition-transform hover:scale-105 active:scale-95"
                  style={{ background: accentCss }}
                  title={isPlaying ? 'Pause' : 'Play'}>
                  {isPlaying ? <Pause size={28} fill="#000" className="text-black" /> : <Play size={28} fill="#000" className="text-black ml-0.5" />}
                </button>
                <button onClick={next} className="p-2 text-white/75 hover:text-white transition-colors" title="Next">
                  <SkipForward size={26} fill="currentColor" />
                </button>
              </div>
              <div className="flex items-center justify-end gap-1">
                {current?.share_token && (
                  <div className="relative">
                    <button onClick={handleShare}
                      className="p-2 transition-colors"
                      style={{ color: copied ? accentCss : 'rgba(255,255,255,0.55)' }}
                      title="Copy share link">
                      {copied ? <Check size={20} /> : <Share2 size={20} />}
                    </button>
                    {copied && (
                      <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 whitespace-nowrap text-[11px] font-medium px-2.5 py-1 rounded-lg pointer-events-none"
                        style={{ background: accentCss, color: '#000' }}>
                        Link copied!
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* ── Desktop: full bar with inline progress ── */}
            <div className="hidden sm:flex items-center gap-6">
              <div className="flex items-center gap-2 flex-shrink-0">
                <button onClick={() => setShuffle(s => !s)}
                  className="p-2 transition-colors"
                  style={{ color: shuffle ? accentCss : 'rgba(255,255,255,0.55)' }}
                  title="Shuffle"><Shuffle size={20} /></button>
                <button onClick={cycleLoop}
                  className="p-2 transition-colors"
                  style={{ color: loopMode !== 'none' ? accentCss : 'rgba(255,255,255,0.55)' }}
                  title={`Loop: ${loopMode}`}>
                  {loopMode === 'one' ? <Repeat1 size={20} /> : <Repeat size={20} />}
                </button>
              </div>
              <div className="flex-1 flex items-center gap-5 justify-center">
                <button onClick={prev} className="p-2 text-white/75 hover:text-white transition-colors" title="Previous">
                  <SkipBack size={26} fill="currentColor" />
                </button>
                <button onClick={togglePlay}
                  className="w-16 h-16 rounded-full flex items-center justify-center transition-transform hover:scale-105 active:scale-95"
                  style={{ background: accentCss }}
                  title={isPlaying ? 'Pause' : 'Play'}>
                  {isPlaying ? <Pause size={28} fill="#000" className="text-black" /> : <Play size={28} fill="#000" className="text-black ml-0.5" />}
                </button>
                <button onClick={next} className="p-2 text-white/75 hover:text-white transition-colors" title="Next">
                  <SkipForward size={26} fill="currentColor" />
                </button>
              </div>
              <div className="flex items-center gap-3 flex-shrink-0">
                <div className="flex items-center gap-2">
                  <Volume2 size={16} className="text-white/50" />
                  <div className="relative w-24 h-1.5 rounded-full bg-white/10">
                    <div className="absolute left-0 top-0 h-full rounded-full pointer-events-none"
                      style={{ width: `${volume * 100}%`, background: 'rgba(255,255,255,0.6)' }} />
                    <input type="range" min={0} max={1} step={0.01} value={volume}
                      onChange={e => setVolume(parseFloat(e.target.value))}
                      className="absolute inset-0 w-full opacity-0 cursor-pointer h-4 -top-1.5" />
                  </div>
                </div>
                {current?.share_token && (
                  <div className="relative">
                    <button onClick={handleShare}
                      className="p-2 transition-colors"
                      style={{ color: copied ? accentCss : 'rgba(255,255,255,0.55)' }}
                      title="Copy share link">
                      {copied ? <Check size={20} /> : <Share2 size={20} />}
                    </button>
                    {copied && (
                      <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 whitespace-nowrap text-[11px] font-medium px-2.5 py-1 rounded-lg pointer-events-none"
                        style={{ background: accentCss, color: '#000' }}>
                        Link copied!
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </main>

    </div>
    </>
  )
}
