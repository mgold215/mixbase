'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Wand2, Square } from 'lucide-react'

// ─── The mixing intern, on the Mix Check card ────────────────────────────────
// "Hand to the intern" files a job (POST /api/versions/<id>/intern). The work
// happens on the owner's Mac: the mixBASE Intern helper there claims the job,
// fixes the measured notes in a COPY of the song's Logic project, bounces, and
// uploads the result as a new version. This panel only shows where that is:
// waiting for the Mac, the stage it reports, the changes it made, and Stop.
// Nothing here measures or decides anything (owner-only, like the card).

export type InternJob = {
  id: string
  status: 'queued' | 'working' | 'done' | 'failed' | 'cancelled'
  stage: string | null
  stalled: boolean
  changes: { track: string; what: string; from?: string; to?: string }[]
  result_version_id: string | null
  error: string | null
  device: string | null
}

type Props = {
  versionId: string
  /** Whether this mix has notes to hand over (a finished check with findings). */
  hasNotes: boolean
  /** The intern finished and a new version is on the song. */
  onDone: () => void
}

const active = (job: InternJob | null) => job?.status === 'queued' || job?.status === 'working'

export function ChangeList({ changes }: { changes: InternJob['changes'] }) {
  if (!changes.length) return null
  return (
    <ul className="text-[11px] text-[var(--text-secondary)] space-y-0.5">
      {changes.map((c, i) => (
        <li key={`${c.track}-${c.what}-${i}`} className="flex gap-2">
          <span className="text-[var(--text)] shrink-0">{c.track}</span>
          <span className="text-[var(--text-muted)]">{c.what}{c.to ? ` ${c.to}` : ''}</span>
        </li>
      ))}
    </ul>
  )
}

export default function InternPanel({ versionId, hasNotes, onDone }: Props) {
  const [job, setJob] = useState<InternJob | null>(null)
  const [madeBy, setMadeBy] = useState<InternJob | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const doneRef = useRef(onDone)
  useEffect(() => { doneRef.current = onDone })
  // Whether this page saw the job in flight: only then is its finish news.
  const sawActive = useRef(false)

  const read = useCallback(async (): Promise<{ job: InternJob | null; made_by: InternJob | null } | null> => {
    const res = await fetch(`/api/versions/${versionId}/intern`, { cache: 'no-store' }).catch(() => null)
    if (!res?.ok) return null
    return res.json().catch(() => null)
  }, [versionId])

  const show = useCallback((body: { job: InternJob | null; made_by: InternJob | null } | null) => {
    if (!body) return
    setJob(body.job ?? null)
    setMadeBy(body.made_by ?? null)
    setLoaded(true)
  }, [])

  useEffect(() => {
    let alive = true
    void read().then(body => { if (alive) show(body) })
    return () => { alive = false }
  }, [read, show])

  // While a job is in flight, follow it. It also picks up one started on the phone.
  const inFlight = active(job)
  useEffect(() => {
    if (!inFlight) return
    let alive = true
    const timer = setInterval(() => { void read().then(body => { if (alive) show(body) }) }, 4000)
    return () => { alive = false; clearInterval(timer) }
  }, [inFlight, read, show])

  // The new version is on the song: tell the page once, so it shows it.
  // A job that was already done when the page loaded announces nothing.
  useEffect(() => {
    if (inFlight) { sawActive.current = true; return }
    if (job?.status === 'done' && job.result_version_id && sawActive.current) {
      sawActive.current = false
      doneRef.current()
    }
  }, [job, inFlight])

  const hand = async () => {
    setBusy(true); setError(null)
    const res = await fetch(`/api/versions/${versionId}/intern`, { method: 'POST' }).catch(() => null)
    const body = res ? await res.json().catch(() => null) : null
    if (!res?.ok) setError(body?.error ?? 'Could not hand this over')
    else { sawActive.current = true; setJob(body.job) }
    setBusy(false)
  }

  const stop = async () => {
    setBusy(true)
    const res = await fetch(`/api/versions/${versionId}/intern`, { method: 'DELETE' }).catch(() => null)
    const body = res ? await res.json().catch(() => null) : null
    if (res?.ok) setJob(body?.job ?? null)
    setBusy(false)
  }

  if (!loaded) return null
  // Nothing to hand over and nothing to show.
  if (!hasNotes && !job && !madeBy) return null

  const waiting = job?.status === 'queued' || (job?.status === 'working' && job.stalled)

  return (
    <div className="rounded-lg px-2.5 py-2 space-y-1.5" style={{ border: '1px solid var(--border)' }}>
      <div className="flex items-center gap-2">
        <Wand2 size={12} className="text-[var(--text-muted)] shrink-0" />
        <span className="text-[11px] font-medium text-[var(--text)] flex-1">Mixing intern</span>
        {inFlight ? (
          <button type="button" onClick={stop} disabled={busy} className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text)] disabled:opacity-40 flex items-center gap-1 transition-colors">
            <Square size={9} /> Stop
          </button>
        ) : hasNotes ? (
          <button type="button" onClick={hand} disabled={busy} className="text-[11px] font-semibold text-[#2dd4bf] hover:text-[#14b8a6] disabled:opacity-40 transition-colors">
            {job?.status === 'failed' ? 'Try again' : 'Hand to the intern'}
          </button>
        ) : null}
      </div>

      {madeBy && (
        <>
          <p className="text-[11px] text-[var(--text-muted)]">The intern made this version. What it changed in the Logic project (on a copy):</p>
          <ChangeList changes={madeBy.changes} />
        </>
      )}

      {!job && !madeBy && hasNotes && (
        <p className="text-[11px] text-[var(--text-muted)]">
          Fixes the measured notes in a copy of the Logic project on your Mac, bounces it and adds the result as a new version. Your project is not touched.
        </p>
      )}
      {waiting && (
        <p className="text-[11px] text-[var(--text-secondary)]">
          Waiting for your Mac<span className="text-[var(--text-muted)]"> · it starts when the Mac is on, unlocked and running mixBASE Intern</span>
        </p>
      )}
      {job?.status === 'working' && !job.stalled && (
        <>
          <p className="text-[11px] text-[var(--text-secondary)]">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#2dd4bf] animate-pulse mr-1.5 translate-y-[-1px]" />
            {job.stage ?? 'Working'}{job.device ? <span className="text-[var(--text-muted)]"> · {job.device}</span> : null}
          </p>
          <ChangeList changes={job.changes} />
        </>
      )}
      {job?.status === 'done' && (
        <>
          <p className="text-[11px] text-[var(--text-secondary)]">Done. The fixed mix is on the song as a new version, checked again.</p>
          <ChangeList changes={job.changes} />
        </>
      )}
      {job?.status === 'failed' && <p className="text-[11px]" style={{ color: '#fbbf24' }}>{job.error ?? 'The intern could not finish.'}</p>}
      {job?.status === 'cancelled' && <p className="text-[11px] text-[var(--text-muted)]">Stopped. Nothing was uploaded.</p>}
      {error && <p className="text-[11px]" style={{ color: '#f87171' }}>{error}</p>}
    </div>
  )
}
