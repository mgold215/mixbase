'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import {
  Play, Pause, SkipBack, SkipForward, Shuffle, Volume2, Music,
  Repeat, Repeat1, Search, ListMusic,
} from 'lucide-react'
import type { Track } from '../api/tracks/route'
import { formatDuration, audioProxyUrl } from '@/lib/supabase'
import { analyzeAudioUrl, extractDominantColor } from '@/lib/audio-analysis'

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

const VINYL_BG = `radial-gradient(circle at 50% 50%,
  #000 0%, #000 4.5%,
  #2a1a40 4.5%, #1a0d2e 6%,
  #111 6%, #0d0d0d 12%,
  #1a1a1a 12%, #111 20%,
  #181818 20%, #0f0f0f 30%,
  #161616 30%, #0d0d0d 42%,
  #151515 42%, #0c0c0c 56%,
  #141414 56%, #0b0b0b 72%,
  #131313 72%, #1a1a1a 100%
)`

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
  const [showEQ, setShowEQ] = useState(false)

  // BPM / key analysis
  const [trackBPM, setTrackBPM] = useState<number | null>(null)
  const [trackKey, setTrackKey] = useState<string | null>(null)
  const [analyzing, setAnalyzing] = useState(false)

  // Dynamic accent color from album art
  const [accent, setAccent] = useState<[number, number, number]>([167, 139, 250])

  // Background crossfade
  const [bgSlot, setBgSlot] = useState<0 | 1>(0)
  const [bgUrls, setBgUrls] = useState<[string | null, string | null]>([null, null])

  // Refs
  const audioRef = useRef<HTMLAudioElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const bassRef = useRef<BiquadFilterNode | null>(null)
  const midRef = useRef<BiquadFilterNode | null>(null)
  const trebleRef = useRef<BiquadFilterNode | null>(null)
  const rafRef = useRef<number>(0)
  const analysisAbortRef = useRef<AbortController | null>(null)

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
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    const bass = ctx.createBiquadFilter(); bass.type = 'lowshelf'; bass.frequency.value = 200
    const mid = ctx.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = 1200; mid.Q.value = 1.2
    const treble = ctx.createBiquadFilter(); treble.type = 'highshelf'; treble.frequency.value = 4000
    src.connect(bass); bass.connect(mid); mid.connect(treble); treble.connect(analyser); analyser.connect(ctx.destination)
    audioCtxRef.current = ctx
    analyserRef.current = analyser
    bassRef.current = bass; midRef.current = mid; trebleRef.current = treble
    rafRef.current = requestAnimationFrame(drawViz)
  }

  // ── Visualizer ─────────────────────────────────────────────────────────────────
  const drawViz = useCallback(() => {
    rafRef.current = requestAnimationFrame(drawViz)
    const canvas = canvasRef.current
    const analyser = analyserRef.current
    if (!canvas || !analyser) return
    const ctx = canvas.getContext('2d')!
    const W = canvas.width, H = canvas.height
    const cx = W / 2, cy = H / 2
    ctx.clearRect(0, 0, W, H)
    const data = new Uint8Array(analyser.frequencyBinCount)
    analyser.getByteFrequencyData(data)
    const [r, g, b] = accent
    const numBars = 90
    const innerR = 237, maxBar = 72
    for (let i = 0; i < numBars; i++) {
      const val = data[Math.floor(i * data.length / numBars)] / 255
      const h = val * maxBar + 2
      const angle = (i / numBars) * Math.PI * 2 - Math.PI / 2
      const cos = Math.cos(angle), sin = Math.sin(angle)
      const alpha = 0.25 + val * 0.75
      ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`
      ctx.lineWidth = Math.max(1.5, (W * 0.75 / numBars) - 1)
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(cx + cos * innerR, cy + sin * innerR)
      ctx.lineTo(cx + cos * (innerR + h), cy + sin * (innerR + h))
      ctx.stroke()
    }
  }, [accent])

  // ── Load track ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !current) return
    audio.src = audioProxyUrl(current.audio_url)
    audio.volume = volume
    audio.playbackRate = speed
    setCurrentTime(0); setDuration(0); setTrackBPM(null); setTrackKey(null)
    if (isPlaying) audio.play().catch(() => setIsPlaying(false))

    // Background crossfade
    const next: 0 | 1 = bgSlot === 0 ? 1 : 0
    setBgUrls(prev => { const u = [...prev] as [string | null, string | null]; u[next] = current.artwork_url; return u })
    setBgSlot(next)

    // Extract accent color
    if (current.artwork_url) {
      extractDominantColor(current.artwork_url).then(setAccent).catch(() => setAccent([167, 139, 250]))
    } else {
      setAccent([167, 139, 250])
    }

    // BPM + Key analysis in background
    analysisAbortRef.current?.abort()
    const abort = new AbortController()
    analysisAbortRef.current = abort
    setAnalyzing(true)
    analyzeAudioUrl(audioProxyUrl(current.audio_url)).then(result => {
      if (abort.signal.aborted) return
      if (result) { setTrackBPM(result.bpm); setTrackKey(result.key) }
      setAnalyzing(false)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIdx, filtered])

  useEffect(() => { if (audioRef.current) audioRef.current.volume = volume }, [volume])
  useEffect(() => { if (audioRef.current) audioRef.current.playbackRate = speed }, [speed])

  // ── EQ ─────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const [bv, mv, tv] = EQ_PRESETS[eqPreset]
    if (bassRef.current) bassRef.current.gain.value = bv
    if (midRef.current) midRef.current.gain.value = mv
    if (trebleRef.current) trebleRef.current.gain.value = tv
  }, [eqPreset])

  // ── Cleanup RAF on unmount ─────────────────────────────────────────────────────
  useEffect(() => () => { cancelAnimationFrame(rafRef.current) }, [])

  // ── Playback ───────────────────────────────────────────────────────────────────
  const goTo = useCallback((idx: number, play = true) => {
    setCurrentIdx(idx); if (play) setIsPlaying(true)
  }, [])

  const next = useCallback(() => {
    if (shuffle) goTo(Math.floor(Math.random() * filtered.length))
    else goTo((currentIdx + 1) % filtered.length)
  }, [shuffle, currentIdx, filtered.length, goTo])

  const prev = useCallback(() => {
    if (currentTime > 3 && audioRef.current) { audioRef.current.currentTime = 0; return }
    goTo((currentIdx - 1 + filtered.length) % filtered.length)
  }, [currentIdx, currentTime, filtered.length, goTo])

  const togglePlay = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    ensureAudioChain()
    if (audioCtxRef.current?.state === 'suspended') audioCtxRef.current.resume()
    if (isPlaying) { audio.pause(); setIsPlaying(false) }
    else { audio.play().then(() => setIsPlaying(true)).catch(() => {}) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
  const cycleEQ = () => {
    const keys = Object.keys(EQ_PRESETS) as EQPreset[]
    setEqPreset(p => keys[(keys.indexOf(p) + 1) % keys.length])
  }

  const pct = duration > 0 ? (currentTime / duration) * 100 : 0
  const accentCss = `rgb(${accent[0]},${accent[1]},${accent[2]})`

  // ── Empty state ────────────────────────────────────────────────────────────────
  if (!loading && tracks.length === 0) {
    return (
      <div className="fixed inset-0 bg-[#050508] flex flex-col items-center justify-center gap-4">
        <ListMusic size={48} className="text-[#222]" />
        <p className="text-[#555]">No tracks yet.</p>
        <Link href="/dashboard" className="text-sm text-[#a78bfa] hover:text-[#c4b5fd] transition-colors">
          Go upload some mixes →
        </Link>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 bg-[#050508] flex flex-col overflow-hidden select-none">
      <audio
        ref={audioRef}
        onTimeUpdate={onTimeUpdate}
        onDurationChange={onDurationChange}
        onEnded={onEnded}
        onPlay={onPlay}
        onPause={onPause}
      />

      {/* ── Animated background ──────────────────────────────────────────────── */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        {([0, 1] as const).map(slot => (
          <div key={slot} className="absolute inset-0 transition-opacity duration-1000"
            style={{ opacity: bgUrls[slot] ? (bgSlot === slot ? 1 : 0) : 0 }}>
            {bgUrls[slot] && (
              <Image src={bgUrls[slot]!} alt="" fill unoptimized
                className="object-cover"
                style={{ filter: 'blur(120px) saturate(1.8) brightness(0.18)' }} />
            )}
          </div>
        ))}
        {/* Radial glow that pulses with accent color */}
        <div className="absolute inset-0" style={{
          background: `radial-gradient(ellipse 60% 50% at 55% 40%, rgba(${accent[0]},${accent[1]},${accent[2]},0.12) 0%, transparent 70%)`,
          transition: 'background 1.2s ease',
        }} />
      </div>

      {/* ── Layout: sidebar + stage ──────────────────────────────────────────── */}
      <div className="relative flex flex-1 overflow-hidden pb-[100px]">

        {/* ── Sidebar ──────────────────────────────────────────────────────── */}
        <aside className="w-[280px] flex-shrink-0 flex flex-col"
          style={{ background: 'rgba(10,8,16,0.75)', borderRight: '1px solid rgba(255,255,255,0.05)', backdropFilter: 'blur(20px)' }}>
          {/* Header */}
          <div className="px-4 pt-5 pb-3">
            <p className="text-[10px] font-semibold tracking-[0.2em] text-[#444] uppercase mb-3">All Tracks</p>
            {/* Search */}
            <div className="relative">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#444]" />
              <input
                type="text" value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search..."
                className="w-full bg-[#111] border border-[#1e1e1e] rounded-lg pl-7 pr-3 py-1.5 text-xs text-white placeholder-[#333] focus:outline-none focus:border-[#a78bfa]/30"
              />
            </div>
            {/* Sort */}
            <div className="flex gap-1 mt-2">
              {(['title', 'date'] as SortKey[]).map(k => (
                <button key={k} onClick={() => setSortKey(k)}
                  className={`text-[10px] px-2.5 py-1 rounded-md transition-colors flex-1 ${sortKey === k ? 'bg-[#1e1e1e] text-white' : 'text-[#444] hover:text-[#888]'}`}>
                  {k === 'title' ? 'A–Z' : 'Recent'}
                </button>
              ))}
            </div>
          </div>

          {/* Track list */}
          <div className="flex-1 overflow-y-auto px-2 pb-4">
            {loading ? Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-2 py-2.5">
                <div className="w-10 h-10 rounded-lg bg-[#1a1a1a] animate-pulse flex-shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-2.5 bg-[#1a1a1a] rounded animate-pulse w-3/4" />
                  <div className="h-2 bg-[#141414] rounded animate-pulse w-1/2" />
                </div>
              </div>
            )) : filtered.map((t, i) => {
              const active = i === currentIdx
              return (
                <button key={t.id} onClick={() => goTo(i)}
                  className={`w-full flex items-center gap-3 px-2 py-2 rounded-xl text-left transition-all mb-0.5 ${active ? 'bg-white/5' : 'hover:bg-white/3'}`}
                  style={active ? { borderLeft: `2px solid ${accentCss}`, paddingLeft: 6 } : { borderLeft: '2px solid transparent' }}>
                  <div className="w-10 h-10 rounded-lg overflow-hidden flex-shrink-0 bg-[#1a1a1a] relative">
                    {t.artwork_url
                      ? <Image src={t.artwork_url} alt={t.title} fill className="object-cover" unoptimized />
                      : <div className="w-full h-full flex items-center justify-center"><Music size={14} className="text-[#333]" /></div>}
                    {active && isPlaying && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                        <div className="flex gap-0.5 items-end h-4">
                          {[1, 0.6, 0.8].map((h, j) => (
                            <div key={j} className="w-0.5 rounded-full animate-bounce"
                              style={{ height: `${h * 100}%`, backgroundColor: accentCss, animationDelay: `${j * 0.15}s` }} />
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-xs font-medium truncate transition-colors ${active ? 'text-white' : 'text-[#aaa]'}`}
                      style={active ? { color: 'white' } : {}}>{t.title}</p>
                    <p className="text-[10px] text-[#555] truncate mt-0.5">{t.artist}</p>
                  </div>
                </button>
              )
            })}
          </div>
        </aside>

        {/* ── Center stage ─────────────────────────────────────────────────── */}
        <main className="flex-1 flex flex-col items-center justify-center gap-5 relative overflow-hidden">
          {current && (
            <>
              {/* Artwork + vinyl + visualizer stack */}
              <div className="relative" style={{ width: 600, height: 600 }}>
                {/* Circular frequency visualizer */}
                <canvas ref={canvasRef} width={600} height={600}
                  className="absolute inset-0 pointer-events-none" style={{ zIndex: 3 }} />

                {/* Vinyl record */}
                <div className="absolute" style={{
                  width: 500, height: 500,
                  top: '50%', left: '50%',
                  transform: 'translate(-50%, -50%)',
                  zIndex: 1,
                }}>
                  <div className="w-full h-full rounded-full" style={{
                    background: VINYL_BG,
                    animation: isPlaying ? 'spinVinyl 1.8s linear infinite' : 'spinVinyl 1.8s linear infinite paused',
                    boxShadow: `0 0 80px rgba(0,0,0,0.9), 0 0 30px rgba(${accent[0]},${accent[1]},${accent[2]},0.08)`,
                  }} />
                </div>

                {/* Album artwork */}
                <div
                  onClick={togglePlay}
                  className="absolute cursor-pointer rounded-[18px] overflow-hidden transition-all duration-500"
                  style={{
                    width: 460, height: 460,
                    top: '50%', left: '50%',
                    transform: `translate(-50%, -50%) scale(${isPlaying ? 1 : 0.97})`,
                    zIndex: 2,
                    boxShadow: isPlaying
                      ? `0 0 80px 20px rgba(${accent[0]},${accent[1]},${accent[2]},0.4), 0 30px 80px rgba(0,0,0,0.7)`
                      : '0 20px 60px rgba(0,0,0,0.7)',
                  }}>
                  {current.artwork_url
                    ? <Image src={current.artwork_url} alt={current.title} fill className="object-cover" unoptimized />
                    : <div className="w-full h-full flex items-center justify-center bg-[#111]"><Music size={80} className="text-[#222]" /></div>}
                </div>
              </div>

              {/* Track info */}
              <div className="text-center max-w-lg px-4">
                <div className="flex items-center justify-center gap-2.5 flex-wrap mb-1">
                  <h1 className="text-xl font-bold text-white leading-tight">{current.title}</h1>
                  {trackKey && (
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded-full border font-semibold"
                      style={{ color: accentCss, borderColor: `rgba(${accent[0]},${accent[1]},${accent[2]},0.4)`, background: `rgba(${accent[0]},${accent[1]},${accent[2]},0.1)` }}>
                      {trackKey}
                    </span>
                  )}
                  {trackBPM && (
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded-full border font-semibold"
                      style={{ color: accentCss, borderColor: `rgba(${accent[0]},${accent[1]},${accent[2]},0.4)`, background: `rgba(${accent[0]},${accent[1]},${accent[2]},0.1)` }}>
                      {trackBPM} BPM
                    </span>
                  )}
                  {analyzing && !trackKey && (
                    <span className="text-[10px] text-[#444] animate-pulse">analyzing…</span>
                  )}
                </div>
                <p className="text-sm text-[#555]">{current.artist}</p>
              </div>
            </>
          )}
        </main>
      </div>

      {/* ── Bottom controls ───────────────────────────────────────────────────── */}
      <div className="fixed bottom-0 left-0 right-0 h-[100px] flex flex-col justify-center px-6 gap-2.5"
        style={{ backdropFilter: 'blur(40px)', background: 'rgba(5,5,8,0.85)', borderTop: '1px solid rgba(255,255,255,0.04)' }}>

        {/* Progress bar */}
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-[#444] w-10 text-right tabular-nums">{formatDuration(Math.floor(currentTime))}</span>
          <div className="relative flex-1 h-[3px] rounded-full" style={{ background: 'rgba(255,255,255,0.08)' }}>
            <div className="absolute left-0 top-0 h-full rounded-full pointer-events-none transition-all"
              style={{ width: `${pct}%`, background: `linear-gradient(to right, rgba(${accent[0]},${accent[1]},${accent[2]},0.7), ${accentCss})` }} />
            <div className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full border-2 border-white shadow transition-all pointer-events-none"
              style={{ left: `calc(${pct}% - 6px)`, background: accentCss, opacity: isPlaying ? 1 : 0.6 }} />
            <input type="range" min={0} max={duration || 0} step={0.1} value={currentTime}
              onChange={seek} className="absolute inset-0 w-full opacity-0 cursor-pointer h-5 -top-1" />
          </div>
          <span className="text-[11px] text-[#444] w-10 tabular-nums">{formatDuration(Math.floor(duration))}</span>
        </div>

        {/* Controls row */}
        <div className="flex items-center justify-center gap-2 relative">
          {/* Left: Shuffle + Loop */}
          <div className="absolute left-0 flex items-center gap-1">
            <button onClick={() => setShuffle(s => !s)}
              className={`p-2 rounded-lg transition-colors text-xs ${shuffle ? 'text-white' : 'text-[#333] hover:text-[#777]'}`}
              style={shuffle ? { color: accentCss } : {}}>
              <Shuffle size={14} />
            </button>
            <button onClick={cycleLoop}
              className="p-2 rounded-lg transition-colors"
              style={loopMode !== 'none' ? { color: accentCss } : { color: '#333' }}>
              {loopMode === 'one' ? <Repeat1 size={14} /> : <Repeat size={14} />}
            </button>
          </div>

          {/* Center: Prev | Play/Pause | Next */}
          <button onClick={prev} className="p-2 text-[#666] hover:text-white transition-colors"><SkipBack size={18} /></button>

          <button onClick={togglePlay}
            className="w-11 h-11 rounded-full flex items-center justify-center transition-all hover:scale-105 active:scale-95"
            style={{ background: accentCss, boxShadow: `0 0 20px rgba(${accent[0]},${accent[1]},${accent[2]},0.5)` }}>
            {isPlaying
              ? <Pause size={20} fill="#000" className="text-black" />
              : <Play size={20} fill="#000" className="text-black ml-0.5" />}
          </button>

          <button onClick={next} className="p-2 text-[#666] hover:text-white transition-colors"><SkipForward size={18} /></button>

          {/* Right: Speed + EQ + Volume */}
          <div className="absolute right-0 flex items-center gap-3">
            {/* Speed */}
            <button onClick={cycleSpeed}
              className="text-[10px] font-mono px-2 py-1 rounded-md transition-colors"
              style={speed !== 1 ? { color: accentCss, background: `rgba(${accent[0]},${accent[1]},${accent[2]},0.1)` } : { color: '#444' }}>
              {speed}×
            </button>

            {/* EQ */}
            <div className="relative">
              <button onClick={() => setShowEQ(v => !v)}
                className="text-[10px] font-mono px-2 py-1 rounded-md transition-colors"
                style={eqPreset !== 'Flat' ? { color: accentCss, background: `rgba(${accent[0]},${accent[1]},${accent[2]},0.1)` } : { color: '#444' }}>
                {eqPreset}
              </button>
              {showEQ && (
                <div className="absolute bottom-8 right-0 rounded-xl border border-[#1e1e1e] overflow-hidden shadow-2xl z-50"
                  style={{ background: 'rgba(12,10,18,0.95)', backdropFilter: 'blur(20px)' }}>
                  {(Object.keys(EQ_PRESETS) as EQPreset[]).map(p => (
                    <button key={p} onClick={() => { setEqPreset(p); setShowEQ(false) }}
                      className="block w-full text-left px-4 py-2 text-xs transition-colors hover:bg-white/5"
                      style={eqPreset === p ? { color: accentCss } : { color: '#888' }}>
                      {p}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Volume */}
            <div className="flex items-center gap-1.5">
              <Volume2 size={12} className="text-[#333]" />
              <div className="relative w-20 h-[3px] rounded-full" style={{ background: 'rgba(255,255,255,0.08)' }}>
                <div className="absolute left-0 top-0 h-full rounded-full pointer-events-none"
                  style={{ width: `${volume * 100}%`, background: 'rgba(255,255,255,0.3)' }} />
                <input type="range" min={0} max={1} step={0.01} value={volume}
                  onChange={e => setVolume(parseFloat(e.target.value))}
                  className="absolute inset-0 w-full opacity-0 cursor-pointer h-4 -top-1.5" />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* CSS animations */}
      <style>{`
        @keyframes spinVinyl { to { transform: rotate(360deg); } }
        .hover\\:bg-white\\/3:hover { background: rgba(255,255,255,0.03); }
      `}</style>
    </div>
  )
}
