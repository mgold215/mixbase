'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Wand2, Square } from 'lucide-react'
import type { InternComparison, InternStep } from '@/lib/intern-jobs.ts'

// ─── The mixing intern, on the Mix Check card ────────────────────────────────
// "Hand to the intern" files a job (POST /api/versions/<id>/intern). The work
// happens on the owner's Mac: the mixBASE Intern helper there claims the job,
// fixes the measured notes in a COPY of the song's Logic project, bounces, and
// uploads the result as a new version.
//
// Three pieces, so the card stays one tidy thing (MixCheck.tsx lays them out):
//   InternRow      one line, always there: the button, or where the job is, and Stop
//   InternLog      the Intern tab: what it changed, and every step it took
//   InternCompare  the Compare tab: the handed mix beside the intern's version
// Nothing here measures or decides anything: the steps are what the Mac
// reported and the comparison is made by the server from the two stored Mix
// Check reports (owner-only, like the card).

export type InternJob = {
  id: string
  status: 'queued' | 'working' | 'done' | 'failed' | 'cancelled'
  stage: string | null
  stalled: boolean
  changes: { track: string; what: string; from?: string; to?: string }[]
  steps?: InternStep[]
  result_version_id: string | null
  error: string | null
  device: string | null
}

export type InternState = {
  loaded: boolean
  job: InternJob | null
  /** The finished job whose upload this version is. */
  madeBy: InternJob | null
  comparison: InternComparison | null
  /** There is a note on this mix the intern has a rule for. */
  canHand: boolean
  busy: boolean
  error: string | null
  hand: () => void
  stop: () => void
}

type Answer = { job: InternJob | null; made_by: InternJob | null; comparison: InternComparison | null; can_hand?: boolean }

const active = (job: InternJob | null) => job?.status === 'queued' || job?.status === 'working'
const signed = (x: number) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(1)}`
const clockOf = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
}

/** The intern's state for one mix, followed while a job is in flight. `onDone`: a new version is on the song. */
export function useIntern(versionId: string, onDone: () => void): InternState {
  const [answer, setAnswer] = useState<Answer | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const doneRef = useRef(onDone)
  useEffect(() => { doneRef.current = onDone })
  // Whether this page saw the job in flight: only then is its finish news.
  const sawActive = useRef(false)

  const read = useCallback(async (): Promise<Answer | null> => {
    const res = await fetch(`/api/versions/${versionId}/intern`, { cache: 'no-store' }).catch(() => null)
    if (!res?.ok) return null
    return res.json().catch(() => null)
  }, [versionId])

  useEffect(() => {
    let alive = true
    void read().then(body => { if (alive) setAnswer(body ?? { job: null, made_by: null, comparison: null }) })
    return () => { alive = false }
  }, [read])

  // While a job is in flight, follow it. It also picks up one started on the phone.
  const job = answer?.job ?? null
  const inFlight = active(job)
  useEffect(() => {
    if (!inFlight) return
    let alive = true
    const timer = setInterval(() => { void read().then(body => { if (alive && body) setAnswer(body) }) }, 4000)
    return () => { alive = false; clearInterval(timer) }
  }, [inFlight, read])

  // The new version is on the song: tell the page once, so it shows it.
  // A job that was already done when the page loaded announces nothing.
  useEffect(() => {
    if (inFlight) { sawActive.current = true; return }
    if (job?.status === 'done' && job.result_version_id && sawActive.current) {
      sawActive.current = false
      doneRef.current()
    }
  }, [job, inFlight])

  const send = async (method: 'POST' | 'DELETE') => {
    setBusy(true); setError(null)
    const res = await fetch(`/api/versions/${versionId}/intern`, { method }).catch(() => null)
    const body = res ? await res.json().catch(() => null) : null
    if (!res?.ok) setError(body?.error ?? (method === 'POST' ? 'Could not hand this over' : 'Could not stop it'))
    else {
      if (method === 'POST') sawActive.current = true
      setAnswer(prev => ({ job: body?.job ?? null, made_by: prev?.made_by ?? null, comparison: prev?.comparison ?? null, can_hand: prev?.can_hand }))
    }
    setBusy(false)
  }

  return {
    loaded: answer !== null, job, madeBy: answer?.made_by ?? null, comparison: answer?.comparison ?? null, canHand: answer?.can_hand === true,
    busy, error, hand: () => { void send('POST') }, stop: () => { void send('DELETE') },
  }
}

/** One line: the button, or where the job is, and Stop. Nothing when there is nothing to hand over or show. */
export function InternRow({ intern }: { intern: InternState }) {
  const { job, madeBy, busy } = intern
  const hasNotes = intern.canHand
  if (!intern.loaded || (!hasNotes && !job && !madeBy)) return null
  const inFlight = active(job)
  const waiting = job?.status === 'queued' || (job?.status === 'working' && job.stalled)

  let line: React.ReactNode
  if (waiting) line = <>Waiting for your Mac<span className="text-[var(--text-muted)]"> · on, unlocked and running mixBASE Intern</span></>
  else if (job?.status === 'working') line = <><span className="inline-block w-1.5 h-1.5 rounded-full bg-[#2dd4bf] animate-pulse mr-1.5 translate-y-[-1px]" />{job.stage ?? 'Working'}</>
  else if (job?.status === 'failed') line = <span style={{ color: '#fbbf24' }}>{job.error ?? 'The intern could not finish.'}</span>
  else if (job?.status === 'done') line = 'Fixed version added to the song'
  else if (job?.status === 'cancelled') line = <span className="text-[var(--text-muted)]">Stopped. Nothing was uploaded.</span>
  else if (madeBy) line = 'The intern made this version'
  else line = <span className="text-[var(--text-muted)]">Fixes the measured notes in a copy of the Logic project</span>

  return (
    <div className="flex items-start gap-2 text-[11px]">
      <Wand2 size={12} className="text-[var(--text-muted)] shrink-0 mt-0.5" />
      <p className="flex-1 min-w-0 text-[var(--text-secondary)]">
        {line}
        {intern.error && <span style={{ color: '#f87171' }}> · {intern.error}</span>}
      </p>
      {inFlight ? (
        <button type="button" onClick={intern.stop} disabled={busy} className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text)] disabled:opacity-40 flex items-center gap-1 transition-colors">
          <Square size={9} /> Stop
        </button>
      ) : hasNotes ? (
        <button
          type="button" onClick={intern.hand} disabled={busy}
          title="Your Mac fixes these notes in a copy of the Logic project, bounces it and adds the result as a new version. Your project is not touched."
          className="shrink-0 font-semibold text-[#2dd4bf] hover:text-[#14b8a6] disabled:opacity-40 transition-colors"
        >
          {job?.status === 'failed' ? 'Try again' : 'Hand to the intern'}
        </button>
      ) : null}
    </div>
  )
}

/** The Intern tab: what it changed, then every step it took, in order. */
export function InternLog({ job }: { job: InternJob }) {
  const steps = job.steps ?? []
  return (
    <div className="space-y-3">
      {job.changes.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">What it changed (in a copy)</h4>
          <ul className="text-[11px] space-y-0.5">
            {job.changes.map((c, i) => (
              <li key={`${c.track}-${c.what}-${i}`} className="flex gap-2">
                <span className="text-[var(--text)] shrink-0">{c.track}</span>
                <span className="text-[var(--text-muted)]">{c.what}{c.to ? ` ${c.to}` : ''}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="space-y-1">
        <h4 className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Steps{job.device ? ` · ${job.device}` : ''}</h4>
        {steps.length === 0 ? (
          <p className="text-[11px] text-[var(--text-muted)]">{job.status === 'queued' ? 'Not started yet.' : 'No step log for this job.'}</p>
        ) : (
          <ol className="text-[11px] space-y-0.5">
            {steps.map((s, i) => s.detail ? (
              <li key={i} className="pl-[4.5rem] text-[var(--text-muted)] leading-relaxed">{s.text}</li>
            ) : (
              <li key={i} className="flex gap-2 pt-1">
                <span className="w-16 shrink-0 tabular-nums text-[var(--text-muted)]">{clockOf(s.at)}</span>
                <span className="text-[var(--text)]">{s.text}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
      {job.status === 'failed' && job.error && <p className="text-[11px]" style={{ color: '#fbbf24' }}>{job.error}</p>}
    </div>
  )
}

const NOTE_STATE = {
  cleared: { label: 'Cleared', color: '#2dd4bf' },
  still: { label: 'Still', color: 'var(--text-muted)' },
  new: { label: 'New', color: '#fbbf24' },
} as const

/** The Compare tab: the handed mix beside the intern's version, band by band, and what became of each note. */
export function InternCompare({ comparison }: { comparison: InternComparison }) {
  const c = comparison
  const cell = (v: number | null, unit = '') => (v == null ? '·' : `${signed(v)}${unit}`)
  const delta = (a: number | null, b: number | null) => (a == null || b == null ? null : Math.round((b - a) * 10) / 10)
  const tone = (d: number | null) => (d == null || Math.abs(d) < 1 ? 'var(--text-muted)' : 'var(--text)')
  const rows: { name: React.ReactNode; from: string; to: string; d: number | null }[] = [
    ...c.bands.map(b => ({ name: <>{b.label} <span className="text-[var(--text-muted)]">{b.range}</span></>, from: cell(b.from), to: cell(b.to), d: delta(b.from, b.to) })),
    { name: 'Loudness, LUFS', from: c.loudness.from?.toFixed(1) ?? '·', to: c.loudness.to?.toFixed(1) ?? '·', d: delta(c.loudness.from, c.loudness.to) },
    { name: 'True peak, dB', from: c.truePeak.from?.toFixed(1) ?? '·', to: c.truePeak.to?.toFixed(1) ?? '·', d: delta(c.truePeak.from, c.truePeak.to) },
  ]
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <table className="w-full text-[11px] tabular-nums">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
              <th className="text-left font-normal py-1 pr-2">{c.against ? `dB vs ${c.against}` : 'Band, dB'}</th>
              <th className="text-right font-normal py-1 pl-2 max-w-[6rem] truncate">{c.from}</th>
              <th className="text-right font-normal py-1 pl-2 max-w-[6rem] truncate">{c.to}</th>
              <th className="text-right font-normal py-1 pl-2">Change</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                <td className="py-1 pr-2 text-[var(--text-secondary)]">{r.name}</td>
                <td className="py-1 pl-2 text-right text-[var(--text-muted)]">{r.from}</td>
                <td className="py-1 pl-2 text-right text-[var(--text-secondary)]">{r.to}</td>
                <td className="py-1 pl-2 text-right font-medium" style={{ color: tone(r.d) }}>{r.d == null ? '·' : signed(r.d)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {c.notes.length > 0 && (
        <ul className="text-[11px] space-y-1">
          {c.notes.map((n, i) => (
            <li key={i} className="flex gap-2">
              <span className="w-12 shrink-0 text-[10px] uppercase tracking-wider pt-px" style={{ color: NOTE_STATE[n.state].color }}>{NOTE_STATE[n.state].label}</span>
              <span className={n.state === 'cleared' ? 'text-[var(--text-muted)] line-through' : 'text-[var(--text-secondary)]'}>
                {n.state === 'cleared' ? n.before : n.after}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
