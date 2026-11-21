'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, Wand2 } from 'lucide-react'
import type { HandoffSong, HandoffStatus } from '@/lib/mix-session-intern.ts'

// ─── The mixing intern, on the Mix Session ───────────────────────────────────
// One button hands every song's open notes to the intern (POST
// /api/mix-session/intern files a job per song; the owner's Mac then works
// through them one at a time). Owner-only: for anyone else the route answers
// 404 and this renders nothing. Nothing is decided here: which songs are
// ready, waiting, or left for the owner is what the server answers
// (src/lib/mix-session-intern.ts).

// The Mac helper shares this route's hourly limit with these polls, so stay well under it.
const POLL_MS = 20_000

function minutesText(minutes: number): string {
  if (minutes < 60) return `about ${minutes} min`
  const hours = minutes / 60
  return `about ${Number.isInteger(hours) ? hours : hours.toFixed(1)} hr`
}

function songLine(song: HandoffSong): string {
  if (song.state === 'ready') return 'Ready to hand over'
  if (song.state === 'written-only') return 'Left for you: no measured note he has a fix for'
  if (song.state === 'queued' || song.stalled) return 'Waiting for your Mac'
  return song.stage ? `Working: ${song.stage}` : 'Working'
}

export default function SessionInternHandoff({ refreshKey }: { refreshKey: number }) {
  // null = not loaded (or not the owner): render nothing
  const [status, setStatus] = useState<HandoffStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [showSongs, setShowSongs] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/mix-session/intern')
      if (!res.ok) { if (res.status === 404) setStatus(null); return }
      const data = await res.json().catch(() => null)
      if (Array.isArray(data?.songs)) setStatus(data)
    } catch { /* a missed refresh is harmless: the next one catches up */ }
  }, [])

  // On open, and again whenever notes are ticked (a song can stop being ready).
  useEffect(() => { void load() }, [load, refreshKey])

  // While the Mac has work, keep the lines current.
  const inFlight = status?.in_flight_count ?? 0
  useEffect(() => {
    if (!inFlight) return
    const timer = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(timer)
  }, [inFlight, load])

  async function handAll() {
    setBusy(true)
    setMessage('')
    try {
      const res = await fetch('/api/mix-session/intern', { method: 'POST' })
      const data = await res.json().catch(() => null)
      if (!res.ok || !Array.isArray(data?.songs)) throw new Error(data?.error ?? 'Could not hand the session over. Try again.')
      setStatus(data)
      setShowSongs(true)
      const handed = Number(data.handed) || 0, failed = Number(data.failed) || 0
      setMessage(
        failed ? `Handed over ${handed}. ${failed} could not be started; try those again.`
          : handed ? `Handed over ${handed} ${handed === 1 ? 'song' : 'songs'}. Your Mac takes them one at a time.`
            : 'Nothing new to hand over.',
      )
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Could not hand the session over. Try again.')
    } finally {
      setBusy(false)
    }
  }

  if (!status || !status.songs.length) return null
  const { ready_count: ready, left_count: left, minutes } = status

  let summary: string
  if (ready) summary = `${ready} ${ready === 1 ? 'song has' : 'songs have'} notes the intern can fix, ${minutesText(minutes)} on your Mac${inFlight ? ` with the ${inFlight} already handed over` : ''}.`
  else if (inFlight) summary = `The intern has ${inFlight} ${inFlight === 1 ? 'song' : 'songs'}, ${minutesText(minutes)} left on your Mac.`
  else summary = 'None of the open notes are ones the intern has a fix for yet.'

  return (
    <div className="rounded-xl p-4" style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto min-w-0">
          <p className="text-sm font-semibold" style={{ color: 'var(--text)' }}>The intern</p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
            {summary}
            {left > 0 && ` ${left} ${left === 1 ? 'song is' : 'songs are'} left for you.`}
          </p>
        </div>
        <button
          onClick={() => setShowSongs(v => !v)}
          className="px-3 py-1.5 text-xs rounded-lg"
          style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
          aria-expanded={showSongs}
        >
          {showSongs ? 'Hide songs' : 'Show songs'}
        </button>
        <button
          onClick={() => void handAll()}
          disabled={busy || ready === 0}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg disabled:opacity-40"
          style={{ background: 'var(--accent)', color: '#080808' }}
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
          {busy ? 'Handing over…' : ready > 1 ? `Hand all ${ready} to the intern` : 'Hand to the intern'}
        </button>
      </div>
      {message && <p className="text-xs mt-2" style={{ color: 'var(--text-secondary)' }} role="status">{message}</p>}
      {showSongs && (
        <ul className="mt-3 space-y-1.5">
          {status.songs.map(song => (
            <li key={song.version_id} className="flex items-baseline justify-between gap-3 text-xs">
              <span className="truncate" style={{ color: 'var(--text)' }}>
                {song.title} <span style={{ color: 'var(--text-muted)' }}>{song.version_label}</span>
              </span>
              <span className="shrink-0 text-right" style={{ color: song.state === 'written-only' ? 'var(--text-muted)' : 'var(--text-secondary)' }}>
                {songLine(song)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
