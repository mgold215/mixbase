'use client'

import { Suspense, useEffect, useRef, useState, useCallback, useMemo, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  Play, Pause, SkipBack, SkipForward, Shuffle, Volume2, Repeat, Repeat1, Search, ListMusic, Menu, X, Share2, Check, ChevronDown, NotebookPen,
} from 'lucide-react'
import CassetteIcon from '@/components/CassetteIcon'
import type { Track } from '../api/tracks/route'
import { formatDuration, audioProxyUrl, MIX_NOTE_AUTHOR, type Feedback } from '@/lib/supabase'
import { trackShareUrl } from '@/lib/share-url'
import { analyzeAudioUrl, extractDominantColor } from '@/lib/audio-analysis'
import { copyToClipboard } from '@/lib/clipboard'
import Nav from '@/components/Nav'
import { usePlayer } from '@/contexts/PlayerContext'

type SortKey = 'title' | 'date'

// The player's accent, matching the app's teal --accent (#2dd4bf) rather than a
// standalone green, so the full-screen player reads as the same product.
const PLAYER_ACCENT = '#2dd4bf'
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

// m:ss for the quick-note stamp and list. formatDuration() renders 0 as
// "--:--", but a note pinned at the very start of a mix is legitimate — the
// same rule punch-list.ts pins with its own clock().
function noteClock(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

// Map version status → short tag + color. 'WIP' / 'Mix/Master' are the retired
// pre-034 spellings, folded onto the current set for unmigrated rows.
function statusTag(status: string): { label: string; color: string } {
  switch (status) {
    case 'Mix':
    case 'WIP':        return { label: 'MIX',       color: '#60a5fa' }
    case 'Master':
    case 'Mix/Master': return { label: 'MASTER',    color: '#a78bfa' }
    case 'Finished':   return { label: 'FINISHED',  color: '#34d399' }
    case 'Released':   return { label: 'RELEASED',  color: '#2dd4bf' }
    default:           return { label: status.toUpperCase(), color: '#ffffff' }
  }
}


export default function PlayerPageWrapper() {
  return (
    <Suspense>
      <PlayerPage />
    </Suspense>
  )
}

function PlayerPage() {
  const {
    tracks, loading, loadError, reloadTracks, refreshTracks, currentTrack, isPlaying, buffering, currentTime, duration,
    volume, playTrack, togglePlay, seek: ctxSeek, setVolume,
    loopMode, shuffle, setLoopMode, setShuffle, setQueue, next, prev,
  } = usePlayer()

  // The track list lives in PlayerContext (which outlives every page), so it can
  // be stale by the time the full player opens — e.g. after editing a project.
  // Silently re-sync on every mount.
  useEffect(() => { refreshTracks() }, [refreshTracks])

  const router = useRouter()
  const searchParams = useSearchParams()
  const trackParam = searchParams.get('track')
  const [filtered, setFiltered] = useState<Track[]>([])
  const [sortKey, setSortKey] = useState<SortKey>('date')
  const [search, setSearch] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  // ── Quick mix notes ────────────────────────────────────────────────────────
  // Jot a timestamped note on the mix you're hearing without leaving the
  // player (button or the N key). The stamp is "live" (tracks playback) until
  // the first keystroke, then freezes — the note pins the moment you REACTED,
  // not the moment you finished typing. Saved via POST /api/mix-notes into
  // mb_feedback, so the project page's markers, punch list and AI summary all
  // pick it up with no extra plumbing.
  const [notesOpen, setNotesOpen] = useState(false)
  const [noteText, setNoteText] = useState('')
  const [noteAt, setNoteAt] = useState<number | null>(null)   // null = stamp is live
  const [noteSaving, setNoteSaving] = useState(false)
  const [noteError, setNoteError] = useState<string | null>(null)
  const [notes, setNotes] = useState<Feedback[]>([])
  // Version id the `notes` list belongs to — null until a fetch lands.
  const [notesVersion, setNotesVersion] = useState<string | null>(null)
  const noteInputRef = useRef<HTMLInputElement | null>(null)

  // BPM / key analysis
  const [trackBPM, setTrackBPM] = useState<number | null>(null)
  const [trackKey, setTrackKey] = useState<string | null>(null)

  // Accent color derived from album art
  const [accent, setAccent] = useState<[number, number, number]>([167, 139, 250])

  // Refs
  const analysisAbortRef = useRef<AbortController | null>(null)
  const vizVideoRef = useRef<HTMLVideoElement | null>(null)

  // current = whatever the shared audio engine is playing right now
  const current = currentTrack

  // ── Project visualizer (Spotify-Canvas style) ─────────────────────────────
  // Keep the muted video loop in step with the audio: canvas runs while the
  // track plays, freezes on pause. play() can reject (autoplay policy before
  // first gesture) — the video just sits on its first frame, which is fine.
  useEffect(() => {
    const v = vizVideoRef.current
    if (!v) return
    if (isPlaying) v.play().catch(() => {})
    else v.pause()
  }, [isPlaying, current?.visualizer_url])

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

  // ── Shared queue ───────────────────────────────────────────────────────────
  // Push the visible (filtered + sorted) order into the engine so next/prev and
  // auto-advance follow it from ANY tab — the queue outlives this page.
  useEffect(() => {
    setQueue(filtered.map(t => t.project_id))
  }, [filtered, setQueue])

  // ── Deep-link / autoplay ───────────────────────────────────────────────────
  // If a ?track= param is present, switch to it (but don't restart if already on it),
  // then strip the param so revisiting this URL (back/forward, tab switches) can't
  // force-restart a stale track later. If nothing is playing yet, start the first track.
  useEffect(() => {
    if (filtered.length === 0) return
    if (trackParam) {
      if (currentTrack?.project_id !== trackParam) {
        const t = filtered.find(t => t.project_id === trackParam)
        if (t) playTrack(t.project_id)
      }
      router.replace('/player', { scroll: false })
    } else if (!currentTrack && filtered[0]) {
      playTrack(filtered[0].project_id)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackParam, filtered.length > 0 ? 'ready' : 'empty'])

  // ── Accent color from artwork ──────────────────────────────────────────────
  useEffect(() => {
    if (current?.artwork_url) {
      extractDominantColor(current.artwork_url).then(setAccent).catch(() => setAccent([167, 139, 250]))
    } else {
      setAccent([167, 139, 250])
    }
  }, [current])

  // ── BPM / key analysis ─────────────────────────────────────────────────────
  // Manual project values take priority — only auto-detect what isn't set.
  // Deferred ~2.5s and abortable so the 4 MB analysis fetch never competes with the
  // critical first buffer of the track that's trying to start playing (a major cause
  // of stalled/"had to click play twice" starts).
  useEffect(() => {
    if (!current) return
    analysisAbortRef.current?.abort()
    const abort = new AbortController()
    analysisAbortRef.current = abort
    setTrackKey(current.key_signature ?? null)
    setTrackBPM(current.bpm ?? null)
    if (current.key_signature && current.bpm) return
    const url = audioProxyUrl(current.audio_url)
    const timer = setTimeout(() => {
      if (abort.signal.aborted) return
      analyzeAudioUrl(url, abort.signal).then(result => {
        if (abort.signal.aborted || !result) return
        if (!current.key_signature) setTrackKey(result.key)
        if (!current.bpm) setTrackBPM(result.bpm)
      })
    }, 2500)
    return () => clearTimeout(timer)
  }, [current])


  // ── Playback ───────────────────────────────────────────────────────────────
  // Transport (next/prev), loop and auto-advance live in PlayerContext now, so
  // they keep working after this page unmounts. This page only picks tracks.
  const goTo = useCallback((idx: number) => {
    if (filtered[idx]) playTrack(filtered[idx].project_id)
  }, [filtered, playTrack])

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.code === 'Space') { e.preventDefault(); togglePlay() }
      if (e.code === 'ArrowLeft') { e.preventDefault(); prev() }
      if (e.code === 'ArrowRight') { e.preventDefault(); next() }
      // Bare N toggles the quick-note panel — modifiers stay the browser's (⌘N).
      if (e.code === 'KeyN' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault(); setNotesOpen(o => !o)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [togglePlay, prev, next])

  // ── Quick mix notes: lifecycle ─────────────────────────────────────────────
  // Always the id of the mix playing RIGHT NOW — the save handler checks it
  // after its await, because auto-advance can change tracks mid-request and a
  // note for the old mix must not be appended to the new mix's list.
  const currentVersionRef = useRef<string | null>(null)
  useEffect(() => { currentVersionRef.current = current?.id ?? null }, [current?.id])

  // A frozen stamp from the previous track must not pin a note on the next one;
  // a fetched list from the previous track must not render under it either.
  useEffect(() => {
    setNoteAt(null)
    setNoteError(null)
    setNotes([])
    setNotesVersion(null)
  }, [current?.id])

  // Load the current mix's existing notes/feedback once per version while the
  // panel is open — the list doubles as "what have I already flagged?".
  useEffect(() => {
    const versionId = current?.id
    if (!notesOpen || !versionId || notesVersion === versionId) return
    let stale = false
    fetch(`/api/versions/${versionId}`)
      .then(r => (r.ok ? r.json() : null))
      .then((v: { mb_feedback?: Feedback[] } | null) => {
        if (stale || !v) return
        setNotesVersion(versionId)
        setNotes(v.mb_feedback ?? [])
      })
      .catch(() => {})
    return () => { stale = true }
  }, [notesOpen, current?.id, notesVersion])

  // Focus the input the moment the panel opens, so N → type → Enter is one flow.
  useEffect(() => {
    if (notesOpen) noteInputRef.current?.focus()
  }, [notesOpen])

  const noteStamp = Math.max(0, Math.floor(noteAt ?? currentTime))

  const onNoteChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (noteAt === null && e.target.value.trim()) setNoteAt(currentTime)
    setNoteText(e.target.value)
  }

  // ±5s corrects for reaction time — by the time you hit N, the moment you
  // heard is already behind the playhead.
  const nudgeNote = (delta: number) => {
    const base = noteAt ?? currentTime
    const max = duration > 0 ? duration : base
    setNoteAt(Math.min(max, Math.max(0, base + delta)))
  }

  const saveNote = async () => {
    const versionId = current?.id
    const text = noteText.trim()
    if (!versionId || !text || noteSaving) return
    const stamped = noteStamp
    setNoteSaving(true)
    setNoteError(null)
    try {
      const res = await fetch('/api/mix-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version_id: versionId, comment: text, timestamp_seconds: stamped }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        setNoteError((data as { error?: string } | null)?.error ?? 'Couldn’t save the note — try again.')
        return
      }
      if (currentVersionRef.current === versionId) {
        setNotes(prev => [...prev, data as Feedback])
      }
      setNoteText('')
      setNoteAt(null)
    } catch {
      setNoteError('Couldn’t save the note — check your connection.')
    } finally {
      setNoteSaving(false)
    }
  }

  const onNoteKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); saveNote() }
    if (e.key === 'Escape') { e.preventDefault(); setNotesOpen(false) }
  }

  // Media Session handlers + position state are owned entirely by PlayerContext.
  // (This page used to override them and null them on unmount, which killed
  // lock-screen/media-key controls after navigating away.)

  const seek = (e: ChangeEvent<HTMLInputElement>) => {
    ctxSeek(parseFloat(e.target.value))
  }

  const cycleLoop = () => setLoopMode(loopMode === 'none' ? 'all' : loopMode === 'all' ? 'one' : 'none')

  const handleShare = useCallback(() => {
    if (!current?.share_token) return
    const url = trackShareUrl(current.share_token)
    copyToClipboard(url).then(ok => {
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      } else {
        // Clipboard blocked (insecure origin / some iOS webviews). Surface the
        // link so Share isn't a silent dead button — mirrors copyShareLink in
        // ProjectClient, which flashes an error toast this page doesn't have.
        alert(`Couldn't copy automatically. Copy this link:\n${url}`)
      }
    })
  }, [current])

  const pct = duration > 0 ? (currentTime / duration) * 100 : 0
  const accentCss = `rgb(${accent[0]},${accent[1]},${accent[2]})`
  const status = current ? statusTag(current.status) : null
  const bars = useMemo(() => generateWaveform(current?.project_id ?? '', WAVEFORM_BARS), [current?.project_id])

  // ── Empty state ────────────────────────────────────────────────────────────────
  // Only when nothing is playing either. A feed track played via the URL queue
  // is not in `tracks` (that list is the user's OWN uploads — possibly empty,
  // possibly a degraded fetch) — expanding it must show the player, not
  // "No tracks yet" over live audio.
  if (!loading && tracks.length === 0 && !currentTrack) {
    return (
      <>
      <Nav />
      <div className="fixed top-14 left-0 right-0 flex flex-col items-center justify-center gap-4" style={{ bottom: 'var(--player-bottom, 0px)', backgroundColor: 'var(--bg-page)' }}>
        <ListMusic size={48} className="text-[var(--text-muted)]" />
        {loadError ? (
          <>
            <p className="text-[var(--text-muted)]">Couldn&apos;t load tracks.</p>
            <button
              onClick={reloadTracks}
              className="text-sm px-4 py-2 rounded-lg transition-colors"
              style={{ backgroundColor: 'var(--surface-2)', color: 'var(--accent)', border: '1px solid var(--border)' }}
            >
              Retry
            </button>
          </>
        ) : (
          <>
            <p className="text-[var(--text-muted)]">No tracks yet.</p>
            <Link href="/dashboard" className="text-sm text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors">
              Go upload some mixes →
            </Link>
          </>
        )}
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
                    : <div className="w-full h-full flex items-center justify-center"><CassetteIcon size={16} className="text-[#444]" /></div>}
                  {active && isPlaying && !buffering && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/45">
                      <div className="flex gap-[3px] items-end h-5">
                        {[1, 0.6, 0.85].map((h, j) => (
                          <div key={j} className="w-[3px] rounded-full animate-bounce"
                            style={{ height: `${h * 100}%`, backgroundColor: accentCss, animationDelay: `${j * 0.15}s` }} />
                        ))}
                      </div>
                    </div>
                  )}
                  {active && buffering && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/45">
                      <div className="w-4 h-4 border-2 rounded-full animate-spin"
                        style={{ borderColor: 'rgba(255,255,255,0.25)', borderTopColor: accentCss }} />
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-medium truncate leading-tight ${active ? 'text-white' : 'text-[#ccc]'}`}>
                    {t.title}
                  </p>
                  <p className="text-xs text-[#666] truncate mt-1">
                    <span className="font-mono">{t.version}</span>
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
      {/* Plain <div> (not <main>) — the root layout now provides the single
          <main> landmark, and nesting <main> elements is invalid HTML. */}
      <div className="relative flex-1 flex flex-col overflow-hidden z-10">
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
                  <CassetteIcon size={80} className="text-[#222]" />
                </div>
              )}
              {/* Project visualizer — loops over the artwork while the track plays
                  (artwork stays underneath as the instant frame while the video loads).
                  Keyed by URL so switching tracks swaps the element cleanly. */}
              {current.visualizer_url && (
                <video
                  key={current.visualizer_url}
                  ref={vizVideoRef}
                  src={current.visualizer_url}
                  autoPlay
                  loop
                  muted
                  playsInline
                  preload="auto"
                  className="absolute inset-0 w-full h-full object-cover"
                />
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
                      <span className="font-mono text-sm text-white/50">{current.version}</span>
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
                      {/* Note markers — dots above the bars where notes are
                          pinned (loaded once the notes panel has been opened
                          for this mix). Accent = your own notes, white =
                          listener feedback. */}
                      {duration > 0 && notesVersion === current?.id && notes
                        .filter(f => f.timestamp_seconds != null)
                        .map(f => (
                          <div
                            key={f.id}
                            className="absolute w-1.5 h-1.5 rounded-full pointer-events-none"
                            style={{
                              left: `calc(${Math.min(100, (f.timestamp_seconds! / duration) * 100)}% - 3px)`,
                              top: -5,
                              background: f.reviewer_name === MIX_NOTE_AUTHOR ? PLAYER_ACCENT : 'rgba(255,255,255,0.6)',
                            }}
                          />
                        ))}
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

        {/* ── Quick mix notes panel ────────────────────────────────────────── */}
        {current && notesOpen && (
          <div
            className="flex-shrink-0 w-full border-t border-white/10 px-3 sm:px-6 py-3"
            style={{ background: 'rgba(6,12,11,0.92)', backdropFilter: 'blur(24px)' }}
          >
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] font-semibold tracking-[0.22em] text-[#777] uppercase">Mix notes</p>
              <button
                onClick={() => setNotesOpen(false)}
                className="p-1 rounded-md text-[#666] hover:text-white hover:bg-white/5 transition-colors"
                title="Close notes (N)"
              >
                <X size={14} />
              </button>
            </div>

            {notes.length > 0 && (
              <div className="max-h-28 overflow-y-auto mb-2 space-y-1 pr-1">
                {[...notes]
                  .sort((a, b) => (a.timestamp_seconds ?? 0) - (b.timestamp_seconds ?? 0))
                  .map(f => (
                    <div key={f.id} className="flex items-start gap-2 text-xs">
                      {f.timestamp_seconds != null ? (
                        <button
                          onClick={() => ctxSeek(f.timestamp_seconds!)}
                          className="flex-shrink-0 font-mono tabular-nums text-[11px] px-1.5 py-0.5 rounded-md bg-white/5 hover:bg-white/15 transition-colors"
                          style={{ color: PLAYER_ACCENT }}
                          title={`Jump to ${noteClock(f.timestamp_seconds)}`}
                        >
                          {noteClock(f.timestamp_seconds)}
                        </button>
                      ) : (
                        <span className="flex-shrink-0 text-[11px] px-1.5 py-0.5 text-white/30">—</span>
                      )}
                      <p className="text-white/80 leading-snug pt-0.5 min-w-0 break-words">
                        {f.reviewer_name !== MIX_NOTE_AUTHOR && <span className="text-white/40">{f.reviewer_name}: </span>}
                        {f.comment}
                      </p>
                    </div>
                  ))}
              </div>
            )}

            <div className="flex items-center gap-2">
              {/* Stamp chip: live (dim) until the first keystroke freezes it
                  (accent). ±5s corrects for reaction time. */}
              <div className="flex items-center flex-shrink-0 rounded-lg bg-white/5 border border-white/10 overflow-hidden">
                <button
                  onClick={() => nudgeNote(-5)}
                  className="px-1.5 py-2 text-[10px] text-white/50 hover:text-white hover:bg-white/10 transition-colors"
                  title="Pin 5s earlier"
                >−5s</button>
                <span
                  className="px-1 font-mono tabular-nums text-xs"
                  style={{ color: noteAt === null ? 'rgba(255,255,255,0.5)' : PLAYER_ACCENT }}
                >
                  {noteClock(noteStamp)}
                </span>
                <button
                  onClick={() => nudgeNote(5)}
                  className="px-1.5 py-2 text-[10px] text-white/50 hover:text-white hover:bg-white/10 transition-colors"
                  title="Pin 5s later"
                >+5s</button>
              </div>
              <input
                ref={noteInputRef}
                type="text"
                value={noteText}
                onChange={onNoteChange}
                onKeyDown={onNoteKeyDown}
                maxLength={2000}
                placeholder="Jot a note — Enter saves, Esc closes"
                className="flex-1 min-w-0 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-[#555] focus:outline-none focus:border-white/20"
              />
              <button
                onClick={saveNote}
                disabled={noteSaving || !noteText.trim()}
                className="flex-shrink-0 px-3 py-2 rounded-lg text-xs font-semibold transition-opacity disabled:opacity-40"
                style={{ background: PLAYER_ACCENT, color: '#000' }}
              >
                {noteSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
            {noteError && <p className="text-xs text-red-400 mt-1.5">{noteError}</p>}
          </div>
        )}

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
                <button onClick={() => setShuffle(!shuffle)}
                  className="p-2 transition-colors"
                  style={{ color: shuffle ? PLAYER_ACCENT : 'rgba(255,255,255,0.55)' }}
                  title="Shuffle"><Shuffle size={20} /></button>
                <button onClick={cycleLoop}
                  className="p-2 transition-colors"
                  style={{ color: loopMode !== 'none' ? PLAYER_ACCENT : 'rgba(255,255,255,0.55)' }}
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
                  style={{ background: PLAYER_ACCENT }}
                  title={isPlaying ? 'Pause' : 'Play'}>
                  {buffering
                    ? <span className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: 'rgba(0,0,0,0.25)', borderTopColor: '#000' }} />
                    : isPlaying ? <Pause size={28} fill="#000" className="text-black" /> : <Play size={28} fill="#000" className="text-black ml-0.5" />}
                </button>
                <button onClick={next} className="p-2 text-white/75 hover:text-white transition-colors" title="Next">
                  <SkipForward size={26} fill="currentColor" />
                </button>
              </div>
              <div className="flex items-center justify-end gap-1">
                <button
                  onClick={() => setNotesOpen(o => !o)}
                  className="p-2 transition-colors"
                  style={{ color: notesOpen ? PLAYER_ACCENT : 'rgba(255,255,255,0.55)' }}
                  title="Mix notes (N)"
                >
                  <NotebookPen size={20} />
                </button>
                {current?.share_token && (
                  <div className="relative">
                    <button onClick={handleShare}
                      className="p-2 transition-colors"
                      style={{ color: copied ? PLAYER_ACCENT : 'rgba(255,255,255,0.55)' }}
                      title="Copy share link">
                      {copied ? <Check size={20} /> : <Share2 size={20} />}
                    </button>
                    {copied && (
                      <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 whitespace-nowrap text-[11px] font-medium px-2.5 py-1 rounded-lg pointer-events-none"
                        style={{ background: PLAYER_ACCENT, color: '#000' }}>
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
                <button onClick={() => setShuffle(!shuffle)}
                  className="p-2 transition-colors"
                  style={{ color: shuffle ? PLAYER_ACCENT : 'rgba(255,255,255,0.55)' }}
                  title="Shuffle"><Shuffle size={20} /></button>
                <button onClick={cycleLoop}
                  className="p-2 transition-colors"
                  style={{ color: loopMode !== 'none' ? PLAYER_ACCENT : 'rgba(255,255,255,0.55)' }}
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
                  style={{ background: PLAYER_ACCENT }}
                  title={isPlaying ? 'Pause' : 'Play'}>
                  {buffering
                    ? <span className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: 'rgba(0,0,0,0.25)', borderTopColor: '#000' }} />
                    : isPlaying ? <Pause size={28} fill="#000" className="text-black" /> : <Play size={28} fill="#000" className="text-black ml-0.5" />}
                </button>
                <button onClick={next} className="p-2 text-white/75 hover:text-white transition-colors" title="Next">
                  <SkipForward size={26} fill="currentColor" />
                </button>
              </div>
              <div className="flex items-center gap-3 flex-shrink-0">
                <button
                  onClick={() => setNotesOpen(o => !o)}
                  className="p-2 transition-colors"
                  style={{ color: notesOpen ? PLAYER_ACCENT : 'rgba(255,255,255,0.55)' }}
                  title="Mix notes (N)"
                >
                  <NotebookPen size={20} />
                </button>
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
                      style={{ color: copied ? PLAYER_ACCENT : 'rgba(255,255,255,0.55)' }}
                      title="Copy share link">
                      {copied ? <Check size={20} /> : <Share2 size={20} />}
                    </button>
                    {copied && (
                      <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 whitespace-nowrap text-[11px] font-medium px-2.5 py-1 rounded-lg pointer-events-none"
                        style={{ background: PLAYER_ACCENT, color: '#000' }}>
                        Link copied!
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

    </div>
    </>
  )
}
