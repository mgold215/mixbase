'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import {
  Play, Pause, SkipBack, SkipForward, Shuffle, Volume2, Music,
  Repeat, Repeat1, Search, ListMusic, Sliders, Menu, X,
} from 'lucide-react'
import type { Track } from '../api/tracks/route'
import { formatDuration, audioProxyUrl } from '@/lib/supabase'
import { analyzeAudioUrl, extractDominantColor } from '@/lib/audio-analysis'
import Nav from '@/components/Nav'

type LoopMode = 'none' | 'all' | 'one'
type EQPreset = 'Flat' | 'Bass' | 'Vocal' | 'Air' | 'Lo-Fi'
type SortKey = 'title' | 'date'

const EQ_PRESETS: Record<EQPreset, [number, number, number]> = {
  Flat:   [0,  0,  0],
  Bass:   [7,  1,  0],
  Vocal:  [-2, 6,  2],
  Air:    [0, -1,  6],
  'Lo-Fi':[4, -3, -9],
}

// MoodMix cassette label colors — pulled from the logo.
const STRIPE_BLUE   = '#2d3fd1'
const STRIPE_PINK   = '#ff2e82'
const STRIPE_YELLOW = '#f7d417'
const STRIPE_TEAL   = '#16b892'

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

// Hub styled after the MoodMix logo cassette: a solid black disc with a
// 6-point star cutout at the center (revealing the dark interior) plus a
// thin outer ring highlight. Spins while playing.
function Reel({ spinning, size = 78 }: { spinning: boolean; size?: number }) {
  // 6-point star path for the spindle cutout
  const star = (() => {
    const pts: string[] = []
    for (let i = 0; i < 12; i++) {
      const angle = (i * 30 - 90) * (Math.PI / 180)
      const r = i % 2 === 0 ? 17 : 7
      pts.push(`${(Math.cos(angle) * r).toFixed(2)},${(Math.sin(angle) * r).toFixed(2)}`)
    }
    return pts.join(' ')
  })()
  return (
    <svg
      viewBox="-50 -50 100 100"
      width={size}
      height={size}
      style={{
        animation: spinning ? 'reelSpin 2.4s linear infinite' : 'none',
        filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.8))',
      }}
    >
      {/* Outer wound tape — concentric brown rings fading inward */}
      <circle r="48" fill="#2a1608" />
      <circle r="48" fill="none" stroke="#3a1e0a" strokeWidth="0.8" />
      {[46, 43, 40, 37, 34, 31].map((r, i) => (
        <circle key={r} r={r} fill="none" stroke={i % 2 ? '#1a0d05' : '#3a1e0a'} strokeWidth="1" />
      ))}
      {/* Inner black hub disc */}
      <circle r="28" fill="#0a0a0a" />
      <circle r="28" fill="none" stroke="#1a1a1a" strokeWidth="0.5" />
      {/* 6-point star spindle cutout */}
      <polygon points={star} fill="#1a1a1a" stroke="#000" strokeWidth="0.5" strokeLinejoin="miter" />
      <circle r="3" fill="#000" />
    </svg>
  )
}

export default function PlayerPage() {
  const [tracks, setTracks] = useState<Track[]>([])
  const [filtered, setFiltered] = useState<Track[]>([])
  const [loading, setLoading] = useState(true)
  const [currentIdx, setCurrentIdx] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(0.85)
  const [loopMode, setLoopMode] = useState<LoopMode>('none')
  const [shuffle, setShuffle] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('date')
  const [search, setSearch] = useState('')
  const [eqPreset, setEqPreset] = useState<EQPreset>('Flat')
  const [speed, setSpeed] = useState(1)
  const [showSettings, setShowSettings] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [scale, setScale] = useState(1)
  const [cassetteH, setCassetteH] = useState(500)

  // BPM / key analysis
  const [trackBPM, setTrackBPM] = useState<number | null>(null)
  const [trackKey, setTrackKey] = useState<string | null>(null)

  // Accent color derived from album art
  const [accent, setAccent] = useState<[number, number, number]>([167, 139, 250])

  // Refs
  const audioRef = useRef<HTMLAudioElement>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const bassRef = useRef<BiquadFilterNode | null>(null)
  const midRef = useRef<BiquadFilterNode | null>(null)
  const trebleRef = useRef<BiquadFilterNode | null>(null)
  const analysisAbortRef = useRef<AbortController | null>(null)
  const cassetteRef = useRef<HTMLDivElement>(null)

  const current = filtered[currentIdx] ?? null

  // ── Fetch tracks ──────────────────────────────────────────────────────────────
  useEffect(() => {
    fetch('/api/tracks').then(r => r.json()).then((d: Track[]) => {
      setTracks(d); setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  // ── Sort + search ─────────────────────────────────────────────────────────────
  useEffect(() => {
    let list = [...tracks]
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(t => t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q))
    }
    list.sort((a, b) => sortKey === 'title' ? a.title.localeCompare(b.title) : b.uploaded_at - a.uploaded_at)
    setFiltered(list)
    setCurrentIdx(0)
  }, [tracks, sortKey, search])

  // ── Setup Web Audio chain (once, on first interaction) ─────────────────────────
  function ensureAudioChain() {
    if (audioCtxRef.current || !audioRef.current) return
    const ctx = new AudioContext()
    const src = ctx.createMediaElementSource(audioRef.current)
    const bass = ctx.createBiquadFilter(); bass.type = 'lowshelf'; bass.frequency.value = 200
    const mid = ctx.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = 1200; mid.Q.value = 1.2
    const treble = ctx.createBiquadFilter(); treble.type = 'highshelf'; treble.frequency.value = 4000
    src.connect(bass); bass.connect(mid); mid.connect(treble); treble.connect(ctx.destination)
    audioCtxRef.current = ctx
    bassRef.current = bass; midRef.current = mid; trebleRef.current = treble
  }

  // ── Load track ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !current) return
    audio.src = audioProxyUrl(current.audio_url)
    audio.volume = volume
    audio.playbackRate = speed
    setCurrentTime(0); setDuration(0); setTrackBPM(null); setTrackKey(null)
    if (isPlaying) audio.play().catch(() => setIsPlaying(false))

    if (current.artwork_url) {
      extractDominantColor(current.artwork_url).then(setAccent).catch(() => setAccent([167, 139, 250]))
    } else {
      setAccent([167, 139, 250])
    }

    analysisAbortRef.current?.abort()
    const abort = new AbortController()
    analysisAbortRef.current = abort
    analyzeAudioUrl(audioProxyUrl(current.audio_url)).then(result => {
      if (abort.signal.aborted) return
      if (result) { setTrackBPM(result.bpm); setTrackKey(result.key) }
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIdx, filtered])

  // ── Responsive scaling — fit the 760px cassette to any viewport ──────────────
  useEffect(() => {
    const update = () => {
      const vw = window.innerWidth
      // Sidebar is 340px but only visible on md+ (>=768px)
      const sidebarW = vw >= 768 ? 340 : 0
      const margin = 24
      const availableW = vw - sidebarW - margin
      setScale(Math.min(1, availableW / 760))
      if (cassetteRef.current) setCassetteH(cassetteRef.current.offsetHeight)
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [current])

  useEffect(() => { if (audioRef.current) audioRef.current.volume = volume }, [volume])
  useEffect(() => { if (audioRef.current) audioRef.current.playbackRate = speed }, [speed])

  useEffect(() => {
    const [bv, mv, tv] = EQ_PRESETS[eqPreset]
    if (bassRef.current) bassRef.current.gain.value = bv
    if (midRef.current) midRef.current.gain.value = mv
    if (trebleRef.current) trebleRef.current.gain.value = tv
  }, [eqPreset])

  // ── Playback ───────────────────────────────────────────────────────────────────
  const goTo = useCallback((idx: number, play = true) => {
    setCurrentIdx(idx); if (play) setIsPlaying(true)
  }, [])

  const next = useCallback(() => {
    if (filtered.length === 0) return
    if (shuffle) goTo(Math.floor(Math.random() * filtered.length))
    else goTo((currentIdx + 1) % filtered.length)
  }, [shuffle, currentIdx, filtered.length, goTo])

  const prev = useCallback(() => {
    if (currentTime > 3 && audioRef.current) { audioRef.current.currentTime = 0; return }
    if (filtered.length === 0) return
    goTo((currentIdx - 1 + filtered.length) % filtered.length)
  }, [currentIdx, currentTime, filtered.length, goTo])

  const togglePlay = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    ensureAudioChain()
    if (audioCtxRef.current?.state === 'suspended') audioCtxRef.current.resume()
    if (isPlaying) { audio.pause(); setIsPlaying(false) }
    else { audio.play().then(() => setIsPlaying(true)).catch(() => {}) }
  }, [isPlaying])

  // ── Audio events ───────────────────────────────────────────────────────────────
  const onTimeUpdate = () => setCurrentTime(audioRef.current?.currentTime ?? 0)
  const onDurationChange = () => setDuration(audioRef.current?.duration ?? 0)
  const onPlay = () => setIsPlaying(true)
  const onPause = () => setIsPlaying(false)
  const onEnded = useCallback(() => {
    if (loopMode === 'one') { audioRef.current?.play().catch(() => {}); return }
    if (loopMode === 'all') { next(); return }
    if (currentIdx < filtered.length - 1) next()
    else setIsPlaying(false)
  }, [loopMode, currentIdx, filtered.length, next])

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

  const seek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const t = parseFloat(e.target.value)
    if (audioRef.current) audioRef.current.currentTime = t
    setCurrentTime(t)
  }

  const cycleLoop = () => setLoopMode(m => m === 'none' ? 'all' : m === 'all' ? 'one' : 'none')
  const cycleSpeed = () => {
    const speeds = [0.75, 1, 1.25, 1.5, 2]
    setSpeed(s => speeds[(speeds.indexOf(s) + 1) % speeds.length])
  }

  const pct = duration > 0 ? (currentTime / duration) * 100 : 0
  const accentCss = `rgb(${accent[0]},${accent[1]},${accent[2]})`
  const status = current ? statusTag(current.status) : null

  // ── Empty state ────────────────────────────────────────────────────────────────
  if (!loading && tracks.length === 0) {
    return (
      <>
      <Nav />
      <div className="fixed top-14 left-0 right-0 bottom-0 bg-[#0a0819] flex flex-col items-center justify-center gap-4">
        <ListMusic size={48} className="text-[#222]" />
        <p className="text-[#555]">No tracks yet.</p>
        <Link href="/dashboard" className="text-sm text-[#a78bfa] hover:text-[#c4b5fd] transition-colors">
          Go upload some mixes →
        </Link>
      </div>
      </>
    )
  }

  return (
    <>
    <Nav />
    <div className="fixed top-14 left-0 right-0 bottom-0 bg-black flex overflow-hidden select-none">
      <audio
        ref={audioRef}
        onTimeUpdate={onTimeUpdate}
        onDurationChange={onDurationChange}
        onEnded={onEnded}
        onPlay={onPlay}
        onPause={onPause}
      />

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
          background: 'rgba(8,6,18,0.92)',
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
            const active = i === currentIdx
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

      {/* ── Main stage: the cassette (with controls inside) ────────────────── */}
      <main className="relative flex-1 flex items-center justify-center px-3 sm:px-8 overflow-hidden z-10">
        {/* Mobile hamburger — opens the track-list drawer */}
        <button
          onClick={() => setSidebarOpen(true)}
          className="md:hidden absolute top-3 left-3 z-10 p-2 rounded-lg bg-white/5 border border-white/10 text-white/80 hover:text-white hover:bg-white/10 transition-colors"
          title="Open track list"
        >
          <Menu size={18} />
        </button>
        {current && status && (
          <div
            className="relative"
            style={{ width: 760 * scale, height: cassetteH * scale }}
          >
            <div
              ref={cassetteRef}
              className="relative"
              style={{
                width: 760,
                transform: `scale(${scale})`,
                transformOrigin: 'top left',
              }}
            >
            {/* Cassette shell — chamfered bottom corners like a real cassette */}
            <div
              className="relative overflow-hidden"
              style={{
                background: 'linear-gradient(180deg, #1a1538 0%, #0a0720 60%, #0a0720 100%)',
                boxShadow: `0 40px 100px rgba(0,0,0,0.8), 0 0 80px rgba(${accent[0]},${accent[1]},${accent[2]},0.22)`,
                padding: 40,
                paddingBottom: 24,
                clipPath: 'polygon(18px 0, calc(100% - 18px) 0, 100% 18px, 100% calc(100% - 34px), calc(100% - 34px) 100%, 34px 100%, 0 calc(100% - 34px), 0 18px)',
              }}
            >
              {/* Corner screws — positioned with the chamfered bottom corners */}
              {[
                { top: 12, left: 12 },
                { top: 12, right: 12 },
                { bottom: 44, left: 10 },
                { bottom: 44, right: 10 },
              ].map((p, i) => (
                <div key={i} className="absolute w-3.5 h-3.5 rounded-full"
                  style={{
                    ...p,
                    background: 'radial-gradient(circle at 35% 30%, #777, #222 70%, #000)',
                    boxShadow: 'inset 0 0 0 1px #000, 0 1px 2px rgba(0,0,0,0.6)',
                  }}>
                  {/* Phillips slot */}
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="w-2 h-[1px] bg-[#111]" />
                  </div>
                </div>
              ))}

              {/* Colored label area */}
              <div className="overflow-hidden rounded-md">
                {/* Blue top stripe — brand */}
                <div style={{ height: 44, background: STRIPE_BLUE }} className="relative flex items-center px-6">
                  <span className="text-white/80 text-[11px] font-black tracking-[0.32em] lowercase">moodmixformat</span>
                  <span className="ml-auto text-white text-[12px] font-black tracking-[0.2em] uppercase px-2 py-0.5 rounded bg-white/10">{current.version}</span>
                </div>

                {/* Pink stripe — track title */}
                <div style={{ height: 80, background: STRIPE_PINK }} className="relative flex items-center justify-center px-16">
                  <span
                    className="text-white font-black tracking-wider uppercase truncate w-full text-center"
                    style={{
                      fontSize: current.title.length > 18 ? 26 : current.title.length > 12 ? 34 : 44,
                      lineHeight: 1,
                      textShadow: '0 2px 0 rgba(0,0,0,0.25)',
                    }}>
                    {current.title}
                  </span>
                  <span className="absolute right-4 top-2 text-white text-[11px] font-black tracking-wider">MIX</span>
                </div>

                {/* Yellow stripe — pill-shaped window with two black hubs touching,
                    separated by a thin silver divider (matches the MMF logo). */}
                <div style={{ height: 126, background: STRIPE_YELLOW }} className="relative">
                  {/* Pill-shaped smoked-glass window — dark interior with slight
                      translucency, so you can faintly see detail behind it */}
                  <div
                    className="absolute left-1/2 -translate-x-1/2 rounded-full overflow-hidden"
                    style={{
                      top: 14, bottom: 14, width: 360,
                      background: 'linear-gradient(180deg, rgba(38,34,44,0.88) 0%, rgba(18,16,22,0.92) 55%, rgba(28,24,32,0.88) 100%)',
                      backdropFilter: 'blur(4px)',
                      boxShadow: [
                        'inset 0 4px 10px rgba(0,0,0,0.85)',
                        'inset 0 -2px 4px rgba(255,255,255,0.08)',
                        'inset 0 0 0 1px rgba(0,0,0,0.6)',
                        'inset 0 0 0 2px rgba(255,255,255,0.08)',
                        '0 1px 0 rgba(255,255,255,0.55)',
                      ].join(', '),
                    }}
                  >
                    {/* Two hubs spaced apart with real cassette proportions */}
                    <div className="absolute inset-0 flex items-center justify-center gap-[88px]">
                      <Reel spinning={isPlaying} />
                      <Reel spinning={isPlaying} />
                    </div>
                    {/* Thin exposed tape stretched across the top between hubs */}
                    <div
                      className="absolute h-[2px] pointer-events-none"
                      style={{
                        top: '32%',
                        left: '22%',
                        right: '22%',
                        background: 'linear-gradient(180deg, #6b3e20 0%, #3a2010 60%, #1a0a04 100%)',
                        boxShadow: '0 1px 0 rgba(255,180,120,0.1), 0 -1px 0 rgba(0,0,0,0.4)',
                      }}
                    />
                  </div>
                </div>

                {/* Progress bar — a thin exposed-tape strip just under the window */}
                <div style={{ height: 22, background: STRIPE_YELLOW }} className="relative flex items-center px-10">
                  <div
                    className="flex-1 relative h-[6px] rounded-[2px] overflow-hidden"
                    style={{
                      background: '#0a0a0a',
                      boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.95), 0 1px 0 rgba(255,255,255,0.35)',
                    }}
                  >
                    <div
                      className="absolute inset-y-0 left-0 transition-[width] duration-200"
                      style={{
                        width: `${pct}%`,
                        background: 'linear-gradient(180deg, #6b3e20 0%, #3a2010 50%, #1a0a04 100%)',
                      }}
                    />
                    <div
                      className="absolute top-0 bottom-0 w-[2px] pointer-events-none"
                      style={{ left: `${pct}%`, background: accentCss, boxShadow: `0 0 6px ${accentCss}` }}
                    />
                    <input
                      type="range" min={0} max={duration || 0} step={0.1} value={currentTime}
                      onChange={seek}
                      className="absolute inset-0 w-full opacity-0 cursor-pointer"
                    />
                  </div>
                </div>

                {/* Teal (green) stripe — clean decorative band (no text, per request) */}
                <div style={{ height: 32, background: STRIPE_TEAL }} className="relative">
                  <div className="absolute inset-0 flex items-center justify-between px-6">
                    {/* Minimal ornament lines to balance the band */}
                    <div className="flex gap-1">
                      {[0, 1, 2, 3].map(i => <div key={i} className="w-3 h-[2px] bg-white/40" />)}
                    </div>
                    <div className="flex gap-1">
                      {[0, 1, 2, 3].map(i => <div key={i} className="w-3 h-[2px] bg-white/40" />)}
                    </div>
                  </div>
                </div>

                {/* Blue bottom stripe — status + BPM/key */}
                <div style={{ height: 36, background: STRIPE_BLUE }} className="relative flex items-center justify-between px-6">
                  <div className="flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full" style={{ background: status.color, boxShadow: `0 0 6px ${status.color}` }} />
                    <span className="text-white text-[10px] font-black tracking-[0.22em]">{status.label}</span>
                  </div>
                  <div className="flex items-center gap-4">
                    {trackKey && <span className="text-white text-[11px] font-mono font-bold">{trackKey}</span>}
                    {trackBPM && <span className="text-white text-[11px] font-mono font-bold">{trackBPM} BPM</span>}
                  </div>
                </div>
              </div>

              {/* Time readout */}
              <div className="flex items-center justify-between px-2 pt-3 pb-2">
                <span className="text-[11px] text-white/60 font-mono tabular-nums tracking-wide">
                  {formatDuration(Math.floor(currentTime))}
                </span>
                <span className="text-[11px] text-white/40 font-mono tabular-nums tracking-wide">
                  −{formatDuration(Math.max(0, Math.floor(duration - currentTime)))}
                </span>
              </div>

              {/* Metal base with controls inside */}
              <div
                className="relative rounded-md flex items-center justify-between px-6"
                style={{
                  height: 72,
                  background: 'linear-gradient(180deg, #5a5664 0%, #3a3642 45%, #1a161e 100%)',
                  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.15), inset 0 -1px 0 rgba(0,0,0,0.5), 0 2px 4px rgba(0,0,0,0.3)',
                }}>
                {/* Shuffle + loop (left) */}
                <div className="flex items-center gap-1">
                  <button onClick={() => setShuffle(s => !s)}
                    className="p-2 rounded-md hover:bg-white/5 transition-colors"
                    style={{ color: shuffle ? accentCss : 'rgba(255,255,255,0.4)' }}
                    title="Shuffle">
                    <Shuffle size={15} />
                  </button>
                  <button onClick={cycleLoop}
                    className="p-2 rounded-md hover:bg-white/5 transition-colors"
                    style={{ color: loopMode !== 'none' ? accentCss : 'rgba(255,255,255,0.4)' }}
                    title={`Loop: ${loopMode}`}>
                    {loopMode === 'one' ? <Repeat1 size={15} /> : <Repeat size={15} />}
                  </button>
                </div>

                {/* Transport (center) */}
                <div className="flex items-center gap-4">
                  <button onClick={prev}
                    className="p-2 text-white/70 hover:text-white transition-colors"
                    title="Previous">
                    <SkipBack size={22} fill="currentColor" />
                  </button>
                  <button onClick={togglePlay}
                    className="w-14 h-14 rounded-full flex items-center justify-center transition-all hover:scale-105 active:scale-95"
                    style={{
                      background: `linear-gradient(180deg, ${accentCss}, rgba(${accent[0]},${accent[1]},${accent[2]},0.8))`,
                      boxShadow: `0 0 28px rgba(${accent[0]},${accent[1]},${accent[2]},0.6), inset 0 1px 0 rgba(255,255,255,0.25)`,
                    }}
                    title={isPlaying ? 'Pause' : 'Play'}>
                    {isPlaying
                      ? <Pause size={24} fill="#000" className="text-black" />
                      : <Play size={24} fill="#000" className="text-black ml-0.5" />}
                  </button>
                  <button onClick={next}
                    className="p-2 text-white/70 hover:text-white transition-colors"
                    title="Next">
                    <SkipForward size={22} fill="currentColor" />
                  </button>
                </div>

                {/* Volume + settings (right) */}
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1.5">
                    <Volume2 size={13} className="text-white/40" />
                    <div className="relative w-20 h-[3px] rounded-full bg-white/10">
                      <div className="absolute left-0 top-0 h-full rounded-full pointer-events-none"
                        style={{ width: `${volume * 100}%`, background: 'rgba(255,255,255,0.5)' }} />
                      <input type="range" min={0} max={1} step={0.01} value={volume}
                        onChange={e => setVolume(parseFloat(e.target.value))}
                        className="absolute inset-0 w-full opacity-0 cursor-pointer h-4 -top-1.5" />
                    </div>
                  </div>
                  <div className="relative">
                    <button onClick={() => setShowSettings(v => !v)}
                      className="p-2 rounded-md hover:bg-white/5 transition-colors"
                      style={{ color: (speed !== 1 || eqPreset !== 'Flat') ? accentCss : 'rgba(255,255,255,0.4)' }}
                      title="Settings">
                      <Sliders size={15} />
                    </button>
                    {showSettings && (
                      <div className="absolute bottom-10 right-0 rounded-xl border border-white/10 overflow-hidden shadow-2xl z-50 min-w-[220px]"
                        style={{ background: 'rgba(14,10,28,0.98)', backdropFilter: 'blur(24px)' }}>
                        <div className="px-3 py-2.5 border-b border-white/5">
                          <p className="text-[10px] text-[#666] uppercase tracking-wider mb-1.5">Speed</p>
                          <button onClick={cycleSpeed}
                            className="text-sm font-mono text-white tabular-nums hover:text-[#a78bfa] transition-colors">
                            {speed}× <span className="text-[#555] text-xs ml-1">(click to cycle)</span>
                          </button>
                        </div>
                        <div className="px-3 py-2.5">
                          <p className="text-[10px] text-[#666] uppercase tracking-wider mb-1.5">EQ Preset</p>
                          <div className="flex flex-wrap gap-1">
                            {(Object.keys(EQ_PRESETS) as EQPreset[]).map(p => (
                              <button key={p} onClick={() => setEqPreset(p)}
                                className="text-[11px] px-2.5 py-1 rounded-md transition-colors font-medium"
                                style={eqPreset === p
                                  ? { color: '#fff', background: accentCss }
                                  : { color: '#888', background: 'rgba(255,255,255,0.06)' }}>
                                {p}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
            </div>
          </div>
        )}
      </main>

      <style>{`
        @keyframes reelSpin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
    </>
  )
}
