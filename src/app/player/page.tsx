'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import {
  Play, Pause, SkipBack, SkipForward, Shuffle, Volume2, Music,
  Repeat, Repeat1, Search, ListMusic, Sliders,
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

// MoodMix cassette label colors — pulled from the logo.
const STRIPE_BLUE   = '#2d3fd1'
const STRIPE_PINK   = '#ff2e82'
const STRIPE_YELLOW = '#f7d417'
const STRIPE_TEAL   = '#16b892'

// Single reel: dark hub with spokes; spins while playing.
function Reel({ spinning, accent }: { spinning: boolean; accent: string }) {
  return (
    <div
      className="relative rounded-full flex items-center justify-center"
      style={{
        width: 96, height: 96,
        background: 'radial-gradient(circle at 35% 30%, #1a1a1a 0%, #000 70%)',
        boxShadow: 'inset 0 0 0 3px #2a2a2a, 0 4px 12px rgba(0,0,0,0.6)',
        animation: spinning ? 'reelSpin 2.4s linear infinite' : 'none',
      }}
    >
      {/* Spokes */}
      {[0, 1, 2, 3, 4, 5].map(i => (
        <div
          key={i}
          className="absolute"
          style={{
            width: 6, height: 30,
            background: 'linear-gradient(180deg, #3a3a3a, #1a1a1a)',
            borderRadius: 3,
            transform: `rotate(${i * 60}deg) translateY(-26px)`,
            transformOrigin: 'center 41px',
          }}
        />
      ))}
      {/* Accent ring */}
      <div
        className="absolute rounded-full pointer-events-none"
        style={{
          inset: 6,
          border: `1px solid ${accent}`,
          opacity: 0.35,
        }}
      />
      {/* Center dot */}
      <div className="w-3 h-3 rounded-full" style={{ background: '#555' }} />
    </div>
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

    // Extract accent color from artwork
    if (current.artwork_url) {
      extractDominantColor(current.artwork_url).then(setAccent).catch(() => setAccent([167, 139, 250]))
    } else {
      setAccent([167, 139, 250])
    }

    // BPM + Key analysis (background)
    analysisAbortRef.current?.abort()
    const abort = new AbortController()
    analysisAbortRef.current = abort
    analyzeAudioUrl(audioProxyUrl(current.audio_url)).then(result => {
      if (abort.signal.aborted) return
      if (result) { setTrackBPM(result.bpm); setTrackKey(result.key) }
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

  // ── Empty state ────────────────────────────────────────────────────────────────
  if (!loading && tracks.length === 0) {
    return (
      <div className="fixed inset-0 bg-[#0a0819] flex flex-col items-center justify-center gap-4">
        <ListMusic size={48} className="text-[#222]" />
        <p className="text-[#555]">No tracks yet.</p>
        <Link href="/dashboard" className="text-sm text-[#a78bfa] hover:text-[#c4b5fd] transition-colors">
          Go upload some mixes →
        </Link>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 bg-[#0a0819] flex flex-col overflow-hidden select-none">
      <audio
        ref={audioRef}
        onTimeUpdate={onTimeUpdate}
        onDurationChange={onDurationChange}
        onEnded={onEnded}
        onPlay={onPlay}
        onPause={onPause}
      />

      {/* ── Blurred artwork backdrop ─────────────────────────────────────────── */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        {current?.artwork_url && (
          <Image
            src={current.artwork_url} alt="" fill unoptimized
            className="object-cover transition-opacity duration-700"
            style={{ filter: 'blur(140px) saturate(1.6) brightness(0.2)' }}
          />
        )}
        <div className="absolute inset-0" style={{
          background: `radial-gradient(ellipse 70% 60% at 50% 40%, rgba(${accent[0]},${accent[1]},${accent[2]},0.14) 0%, transparent 70%)`,
        }} />
      </div>

      {/* ── Main layout ──────────────────────────────────────────────────────── */}
      <div className="relative flex flex-1 overflow-hidden pb-[92px]">

        {/* ── Sidebar: bigger, cleaner track list ─────────────────────────── */}
        <aside className="w-[340px] flex-shrink-0 flex flex-col"
          style={{
            background: 'rgba(10,8,25,0.8)',
            borderRight: '1px solid rgba(255,255,255,0.06)',
            backdropFilter: 'blur(20px)',
          }}>
          <div className="px-5 pt-6 pb-4">
            <p className="text-[10px] font-semibold tracking-[0.22em] text-[#666] uppercase mb-4">All Tracks</p>
            {/* Search */}
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#555]" />
              <input
                type="text" value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search tracks..."
                className="w-full bg-[#15122a] border border-[#242038] rounded-lg pl-9 pr-3 py-2.5 text-sm text-white placeholder-[#444] focus:outline-none focus:border-[#a78bfa]/40"
              />
            </div>
            {/* Sort toggle */}
            <div className="flex gap-1 mt-3 p-1 rounded-lg bg-[#15122a]">
              {(['date', 'title'] as SortKey[]).map(k => (
                <button key={k} onClick={() => setSortKey(k)}
                  className={`text-[11px] px-3 py-1.5 rounded-md transition-all flex-1 font-medium ${sortKey === k ? 'bg-[#2a2450] text-white' : 'text-[#555] hover:text-[#aaa]'}`}>
                  {k === 'title' ? 'A–Z' : 'Recent'}
                </button>
              ))}
            </div>
          </div>

          {/* Track list — bigger tiles, cleaner type */}
          <div className="flex-1 overflow-y-auto px-3 pb-6">
            {loading ? Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-2 py-3">
                <div className="w-12 h-12 rounded-lg bg-[#1a1630] animate-pulse flex-shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 bg-[#1a1630] rounded animate-pulse w-3/4" />
                  <div className="h-2.5 bg-[#14122a] rounded animate-pulse w-1/2" />
                </div>
              </div>
            )) : filtered.map((t, i) => {
              const active = i === currentIdx
              return (
                <button key={t.id} onClick={() => goTo(i)}
                  className={`w-full flex items-center gap-3 px-2.5 py-2.5 rounded-xl text-left transition-all mb-1 ${active ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]'}`}
                  style={active ? { borderLeft: `2px solid ${accentCss}`, paddingLeft: 8 } : { borderLeft: '2px solid transparent' }}>
                  <div className="w-12 h-12 rounded-lg overflow-hidden flex-shrink-0 bg-[#1a1630] relative">
                    {t.artwork_url
                      ? <Image src={t.artwork_url} alt={t.title} fill className="object-cover" unoptimized />
                      : <div className="w-full h-full flex items-center justify-center"><Music size={16} className="text-[#333]" /></div>}
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
                    <p className="text-xs text-[#666] truncate mt-1">{t.artist}</p>
                  </div>
                </button>
              )
            })}
          </div>
        </aside>

        {/* ── Center stage: the cassette ───────────────────────────────────── */}
        <main className="flex-1 flex flex-col items-center justify-center gap-6 px-8 relative overflow-hidden">
          {current && (
            <>
              {/* Cassette shell */}
              <div className="relative" style={{ width: 720, height: 460 }}>
                {/* Outer shell with gradient + rounded corners */}
                <div
                  className="absolute inset-0 rounded-[18px]"
                  style={{
                    background: 'linear-gradient(180deg, #1a1538 0%, #0a0720 100%)',
                    border: '2px solid #2a2450',
                    boxShadow: `0 30px 80px rgba(0,0,0,0.7), 0 0 60px rgba(${accent[0]},${accent[1]},${accent[2]},0.18)`,
                  }}
                />

                {/* Corner screws */}
                {[
                  { t: 14, l: 14 }, { t: 14, r: 14 },
                  { b: 14, l: 14 }, { b: 14, r: 14 },
                ].map((p, i) => (
                  <div key={i} className="absolute w-3 h-3 rounded-full"
                    style={{
                      top: p.t, left: p.l, right: p.r, bottom: p.b,
                      background: 'radial-gradient(circle at 35% 30%, #666, #1a1a1a)',
                      boxShadow: 'inset 0 0 0 1px #000, 0 1px 2px rgba(0,0,0,0.6)',
                    }} />
                ))}

                {/* Colored label area */}
                <div className="absolute overflow-hidden rounded-md"
                  style={{ top: 36, left: 36, right: 36, bottom: 96 }}>
                  {/* Blue top stripe */}
                  <div style={{ height: '14%', background: STRIPE_BLUE }} className="relative flex items-center px-6">
                    <span className="text-white/70 text-[10px] font-black tracking-[0.3em]">MOODMIX CASSETTE</span>
                  </div>

                  {/* Pink stripe — track title */}
                  <div style={{ height: '20%', background: STRIPE_PINK }} className="relative flex items-center justify-center px-16">
                    <span
                      className="text-white font-black tracking-wider uppercase truncate"
                      style={{ fontSize: current.title.length > 14 ? 28 : 40, lineHeight: 1, textShadow: '0 2px 0 rgba(0,0,0,0.3)' }}>
                      {current.title}
                    </span>
                    <span className="absolute right-4 top-1 text-white text-[11px] font-black tracking-wider">MIX</span>
                  </div>

                  {/* Yellow stripe — reels + tape */}
                  <div style={{ height: '36%', background: STRIPE_YELLOW }} className="relative flex items-center justify-center px-10">
                    {/* Left reel */}
                    <Reel spinning={isPlaying} accent={accentCss} />

                    {/* Tape between reels */}
                    <div className="flex-1 mx-4 relative h-6 rounded-sm overflow-hidden"
                      style={{ background: '#0a0a0a', boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.8)' }}>
                      {/* Tape fill = progress */}
                      <div className="absolute inset-y-0 left-0 transition-[width] duration-200"
                        style={{
                          width: `${pct}%`,
                          background: `linear-gradient(180deg, #4a3a28 0%, #2a1e10 100%)`,
                        }} />
                      {/* Playhead mark */}
                      <div className="absolute top-0 bottom-0 w-[2px]"
                        style={{ left: `${pct}%`, background: accentCss, boxShadow: `0 0 6px ${accentCss}` }} />
                    </div>

                    {/* Right reel */}
                    <Reel spinning={isPlaying} accent={accentCss} />
                  </div>

                  {/* Teal stripe — artist */}
                  <div style={{ height: '16%', background: STRIPE_TEAL }} className="relative flex items-center justify-center px-10">
                    <span className="text-white/95 text-base font-bold tracking-wide uppercase truncate">
                      {current.artist}
                    </span>
                  </div>

                  {/* Blue bottom stripe — BPM / key */}
                  <div style={{ height: '14%', background: STRIPE_BLUE }} className="relative flex items-center justify-between px-6">
                    <span className="text-white/70 text-[10px] font-black tracking-[0.25em]">SIDE A</span>
                    <div className="flex items-center gap-3">
                      {trackKey && <span className="text-white text-[11px] font-mono font-bold">{trackKey}</span>}
                      {trackBPM && <span className="text-white text-[11px] font-mono font-bold">{trackBPM} BPM</span>}
                    </div>
                  </div>
                </div>

                {/* Metal base with holes */}
                <div className="absolute left-9 right-9 bottom-9 flex items-center justify-center gap-6 rounded-md"
                  style={{
                    height: 42,
                    background: 'linear-gradient(180deg, #4a4654 0%, #2a2632 60%, #1a1622 100%)',
                    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.1), inset 0 -1px 0 rgba(0,0,0,0.4)',
                  }}>
                  {/* Capstan holes */}
                  {[0, 1, 2, 3, 4].map(i => (
                    <div key={i} className="w-3.5 h-3.5 rounded-full"
                      style={{
                        background: 'radial-gradient(circle at 50% 40%, #000 0%, #000 60%, #1a1a1a 100%)',
                        boxShadow: 'inset 0 2px 3px rgba(0,0,0,0.9), 0 0 0 1px rgba(255,255,255,0.05)',
                      }} />
                  ))}
                </div>
              </div>

              {/* Artwork thumbnail + now playing below cassette */}
              {current.artwork_url && (
                <div className="flex items-center gap-3 mt-2">
                  <div className="w-10 h-10 rounded-md overflow-hidden" style={{ boxShadow: `0 0 20px rgba(${accent[0]},${accent[1]},${accent[2]},0.3)` }}>
                    <Image src={current.artwork_url} alt="" width={40} height={40} className="object-cover w-full h-full" unoptimized />
                  </div>
                  <span className="text-xs text-[#777]">Now playing from <span className="text-white/80">{current.artist}</span></span>
                </div>
              )}
            </>
          )}
        </main>
      </div>

      {/* ── Bottom controls bar ────────────────────────────────────────────── */}
      <div className="fixed bottom-0 left-0 right-0 h-[92px] flex flex-col justify-center px-6 gap-2.5"
        style={{ backdropFilter: 'blur(40px)', background: 'rgba(10,8,25,0.88)', borderTop: '1px solid rgba(255,255,255,0.05)' }}>

        {/* Progress bar */}
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-[#555] w-10 text-right tabular-nums">{formatDuration(Math.floor(currentTime))}</span>
          <div className="relative flex-1 h-[3px] rounded-full" style={{ background: 'rgba(255,255,255,0.08)' }}>
            <div className="absolute left-0 top-0 h-full rounded-full pointer-events-none transition-all"
              style={{ width: `${pct}%`, background: `linear-gradient(to right, rgba(${accent[0]},${accent[1]},${accent[2]},0.6), ${accentCss})` }} />
            <div className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full border-2 border-white shadow transition-all pointer-events-none"
              style={{ left: `calc(${pct}% - 6px)`, background: accentCss, opacity: isPlaying ? 1 : 0.6 }} />
            <input type="range" min={0} max={duration || 0} step={0.1} value={currentTime}
              onChange={seek} className="absolute inset-0 w-full opacity-0 cursor-pointer h-5 -top-1" />
          </div>
          <span className="text-[11px] text-[#555] w-10 tabular-nums">{formatDuration(Math.floor(duration))}</span>
        </div>

        {/* Controls row */}
        <div className="flex items-center justify-center gap-2 relative">
          {/* Left: Shuffle + Loop */}
          <div className="absolute left-0 flex items-center gap-1">
            <button onClick={() => setShuffle(s => !s)}
              className="p-2 rounded-lg transition-colors"
              style={{ color: shuffle ? accentCss : '#3a3a3a' }}>
              <Shuffle size={15} />
            </button>
            <button onClick={cycleLoop}
              className="p-2 rounded-lg transition-colors"
              style={{ color: loopMode !== 'none' ? accentCss : '#3a3a3a' }}>
              {loopMode === 'one' ? <Repeat1 size={15} /> : <Repeat size={15} />}
            </button>
          </div>

          {/* Center: Prev | Play/Pause | Next */}
          <button onClick={prev} className="p-2 text-[#777] hover:text-white transition-colors"><SkipBack size={20} /></button>
          <button onClick={togglePlay}
            className="w-12 h-12 rounded-full flex items-center justify-center transition-all hover:scale-105 active:scale-95"
            style={{ background: accentCss, boxShadow: `0 0 24px rgba(${accent[0]},${accent[1]},${accent[2]},0.55)` }}>
            {isPlaying
              ? <Pause size={22} fill="#000" className="text-black" />
              : <Play size={22} fill="#000" className="text-black ml-0.5" />}
          </button>
          <button onClick={next} className="p-2 text-[#777] hover:text-white transition-colors"><SkipForward size={20} /></button>

          {/* Right: Settings menu + Volume */}
          <div className="absolute right-0 flex items-center gap-3">
            {/* Settings (Speed + EQ hidden behind one menu) */}
            <div className="relative">
              <button onClick={() => setShowSettings(v => !v)}
                className="p-2 rounded-lg transition-colors"
                style={{ color: (speed !== 1 || eqPreset !== 'Flat') ? accentCss : '#3a3a3a' }}>
                <Sliders size={15} />
              </button>
              {showSettings && (
                <div className="absolute bottom-10 right-0 rounded-xl border border-[#242038] overflow-hidden shadow-2xl z-50 min-w-[200px]"
                  style={{ background: 'rgba(14,10,28,0.96)', backdropFilter: 'blur(24px)' }}>
                  {/* Speed */}
                  <div className="px-3 py-2.5 border-b border-[#242038]">
                    <p className="text-[10px] text-[#555] uppercase tracking-wider mb-1.5">Speed</p>
                    <button onClick={cycleSpeed}
                      className="text-sm font-mono text-white tabular-nums hover:text-[#a78bfa] transition-colors">
                      {speed}× <span className="text-[#555] text-xs">(click to cycle)</span>
                    </button>
                  </div>
                  {/* EQ */}
                  <div className="px-3 py-2.5">
                    <p className="text-[10px] text-[#555] uppercase tracking-wider mb-1.5">EQ Preset</p>
                    <div className="flex flex-wrap gap-1">
                      {(Object.keys(EQ_PRESETS) as EQPreset[]).map(p => (
                        <button key={p} onClick={() => setEqPreset(p)}
                          className="text-[11px] px-2 py-1 rounded-md transition-colors font-medium"
                          style={eqPreset === p
                            ? { color: '#fff', background: accentCss }
                            : { color: '#888', background: '#1a1630' }}>
                          {p}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Volume */}
            <div className="flex items-center gap-1.5">
              <Volume2 size={13} className="text-[#444]" />
              <div className="relative w-20 h-[3px] rounded-full" style={{ background: 'rgba(255,255,255,0.08)' }}>
                <div className="absolute left-0 top-0 h-full rounded-full pointer-events-none"
                  style={{ width: `${volume * 100}%`, background: 'rgba(255,255,255,0.35)' }} />
                <input type="range" min={0} max={1} step={0.01} value={volume}
                  onChange={e => setVolume(parseFloat(e.target.value))}
                  className="absolute inset-0 w-full opacity-0 cursor-pointer h-4 -top-1.5" />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Reel spin animation */}
      <style>{`
        @keyframes reelSpin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  )
}
