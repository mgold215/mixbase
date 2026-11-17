'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Stethoscope, ChevronDown, ChevronUp, Plus } from 'lucide-react'
import { THIRD_OCTAVE_HZ } from '@/lib/mix-check.ts'
import { GENRE_FAMILIES, genreFamilyLabel, type MixSeverity } from '@/lib/mix-check-findings.ts'
import type { MixCheckReport } from '@/lib/mix-check-server'
import type { Feedback } from '@/lib/supabase'
import type { VersionLoudnessRow } from '@/lib/loudness-compare'
import MasterCheck, { type LoudnessCardProps } from '@/components/MasterCheck'

// ─── Mix Check — how loud this mix is, and what is measurably wrong with it ──
// ONE card, one button. It asks the server to analyse the whole mix
// (POST /api/versions/<id>/mix-check, a few seconds of work there, polled
// here) and shows the loudness readout that used to be its own "Master check"
// card (the server measures that too, so nothing is decoded in the browser),
// then what the check found: what changed since the previous version, how
// the balance sits against the artist's own catalog and against commercial
// references in the genre, and faults that need no comparison (a drop that
// lands smaller than its breakdown, a low end that cancels in mono, clipping).
//
// Every finding is ALSO written into the mix notes by the server, timestamped,
// under the "Mix Check" byline — `onNotes` hands the page those rows so the
// scrubber markers and the notes list show them without a reload. The report
// is stored on the version, so it is here again after a reload or a deploy.
//
// Owner-only for now: rendered only when the page was told `ownerTools`.
// Everyone else gets the loudness card on its own (MasterCheck).

type Props = {
  versionId: string
  projectId: string
  /** The loudness readout at the top of the card: the stored reading, the
   *  previous mix to compare it with, and where a new reading goes. */
  loudness: Omit<LoudnessCardProps, 'versionId'>
  /** The Mix Check notes now on the mix, in the page's own feedback shape. */
  onNotes: (notes: Feedback[]) => void
  /** Play the mix from a moment (seconds). */
  onJump: (seconds: number) => void
}

type State =
  | { status: 'loading' | 'none' | 'running' }
  | { status: 'error'; error: string }
  | { status: 'done'; report: MixCheckReport }

const SEVERITY: Record<MixSeverity, { label: string; color: string }> = {
  high: { label: 'High', color: '#f87171' },
  medium: { label: 'Medium', color: '#fbbf24' },
  low: { label: 'Low', color: 'var(--text-muted)' },
}

const clock = (s: number) => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`
const signed = (x: number) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(1)}`

export default function MixCheck({ versionId, projectId, loudness, onNotes, onJump }: Props) {
  const [state, setState] = useState<State>({ status: 'loading' })
  const [open, setOpen] = useState(false)
  const alive = useRef(true)
  const notesRef = useRef(onNotes)
  useEffect(() => { notesRef.current = onNotes }, [onNotes])
  const measuredRef = useRef(loudness.onMeasured)
  useEffect(() => { measuredRef.current = loudness.onMeasured })

  const read = useCallback(async (): Promise<State> => {
    const res = await fetch(`/api/versions/${versionId}/mix-check`, { cache: 'no-store' })
    if (!res.ok) return { status: 'error', error: res.status === 404 ? 'Not available' : `Could not load (${res.status})` }
    const body = await res.json()
    if (body.status === 'done') {
      notesRef.current(body.notes ?? [])
      // The check measured the loudness too: hand the page the saved reading.
      if (body.loudness) measuredRef.current?.(body.loudness as VersionLoudnessRow)
      return { status: 'done', report: body.report }
    }
    if (body.status === 'error') return { status: 'error', error: body.error ?? 'The check failed' }
    return { status: body.status === 'running' ? 'running' : 'none' }
  }, [versionId])

  // Poll while a check runs (also picks up one started on another device).
  const poll = useCallback(async () => {
    for (let i = 0; i < 150 && alive.current; i++) {
      const next = await read().catch((): State => ({ status: 'error', error: 'Network error' }))
      if (!alive.current) return
      if (next.status !== 'running') { setState(next); if (next.status === 'done') setOpen(true); return }
      await new Promise(r => setTimeout(r, 2500))
    }
    if (alive.current) setState({ status: 'error', error: 'The check is taking too long. Try again in a minute.' })
  }, [read])

  useEffect(() => {
    alive.current = true
    read()
      .then(next => {
        if (!alive.current) return
        setState(next)
        if (next.status === 'running') void poll()
      })
      .catch(() => { if (alive.current) setState({ status: 'none' }) })
    return () => { alive.current = false }
  }, [read, poll])

  const run = async () => {
    setState({ status: 'running' })
    const res = await fetch(`/api/versions/${versionId}/mix-check`, { method: 'POST' }).catch(() => null)
    if (!res || !res.ok) {
      const body = res ? await res.json().catch(() => null) : null
      setState({ status: 'error', error: body?.error ?? 'Could not start the check' })
      return
    }
    void poll()
  }

  const report = state.status === 'done' ? state.report : null
  const findings = report?.findings ?? []
  const counts = { high: 0, medium: 0, low: 0 }
  for (const f of findings) counts[f.severity]++

  // Until the first answer the card is the loudness readout alone.
  const actions = state.status === 'loading' ? null : (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={run}
        disabled={state.status === 'running'}
        className={`text-[11px] disabled:opacity-40 transition-colors ${report
          ? 'text-[var(--text-muted)] hover:text-[var(--text)]'
          : 'font-semibold text-[#2dd4bf] hover:text-[#14b8a6]'}`}
      >
        {state.status === 'running' ? 'Checking…' : report ? 'Check again' : 'Check this mix'}
      </button>
      {report && (
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
          className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text)] flex items-center gap-1 transition-colors"
        >
          {open ? 'Hide' : 'Show'} {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
      )}
    </div>
  )

  const body = (
    <>
      {state.status === 'none' && (
        <p className="text-xs text-[var(--text-muted)]">
          Measures the loudness, analyses the whole mix and writes what it finds into the notes, each at its place in the song.
        </p>
      )}
      {state.status === 'running' && (
        <p className="text-xs text-[var(--text-muted)]">Listening to the whole mix. This takes about half a minute.</p>
      )}
      {state.status === 'error' && <p className="text-xs" style={{ color: '#f87171' }}>{state.error}</p>}

      {report && (
        <p className="text-xs text-[var(--text-secondary)]">
          {findings.length === 0
            ? 'Nothing measurable stands out.'
            : `${findings.length} note${findings.length === 1 ? '' : 's'} added`}
          {counts.high > 0 && <span style={{ color: SEVERITY.high.color }}> · {counts.high} high</span>}
          {counts.medium > 0 && <span style={{ color: SEVERITY.medium.color }}> · {counts.medium} medium</span>}
          <span className="text-[var(--text-muted)]"> · {comparedLine(report)}</span>
        </p>
      )}

      {report && open && (
        <div className="space-y-3">
          {findings.length > 0 && (
            <ul className="space-y-1.5">
              {findings.map(f => (
                <li key={f.code} className="rounded-lg px-2.5 py-2" style={{ border: '1px solid var(--border)' }}>
                  <div className="flex items-baseline gap-2">
                    <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0 translate-y-[-1px]" style={{ backgroundColor: SEVERITY[f.severity].color }} aria-label={`${SEVERITY[f.severity].label} severity`} />
                    <span className="text-xs font-medium text-[var(--text)] flex-1">{f.title}</span>
                    {f.at != null && (
                      <button type="button" onClick={() => onJump(f.at!)} className="text-[11px] tabular-nums text-[var(--accent)] hover:underline shrink-0" title="Play from here">
                        {clock(f.at)}
                      </button>
                    )}
                  </div>
                  <p className="text-[11px] leading-relaxed text-[var(--text-muted)] mt-1 pl-3.5">{f.note}</p>
                </li>
              ))}
            </ul>
          )}

          {report.bands && <BandTable report={report} />}
          {report.curves && <SpectrumChart curves={report.curves} />}
          {report.detail && <SubTimeline report={report} onJump={onJump} />}
          <References report={report} projectId={projectId} />

          <p className="text-[10px] leading-relaxed text-[var(--text-muted)]">
            Measured from the stereo file, so it finds what can be measured and not what is a matter of taste.
            Tick a note off in the notes list and a later check will leave it alone.
          </p>
        </div>
      )}
    </>
  )

  return (
    <MasterCheck
      versionId={versionId}
      {...loudness}
      mixCheck={{ heading: <><Stethoscope size={12} /> Mix check</>, actions, body }}
    />
  )
}

function comparedLine(report: MixCheckReport): string {
  const c = report.compared
  const parts: string[] = []
  if (c?.previous) parts.push(`vs ${c.previous}`)
  if (c && c.catalog > 0) parts.push(`${c.catalog} of your songs`)
  if (c?.industry) parts.push(`${c.industry.count} ${c.industry.label} references`)
  return parts.length ? parts.join(', ') : 'no comparisons yet'
}

function BandTable({ report }: { report: MixCheckReport }) {
  const c = report.compared
  const cols: { key: 'vsPrevious' | 'vsCatalog' | 'vsIndustry'; head: string }[] = []
  if (c?.previous) cols.push({ key: 'vsPrevious', head: c.previous })
  if (c && c.catalog > 0) cols.push({ key: 'vsCatalog', head: 'Catalog' })
  if (c?.industry) cols.push({ key: 'vsIndustry', head: 'Genre' })
  if (!cols.length) return null
  const tone = (v: number | null) => (v == null ? 'var(--text-muted)' : Math.abs(v) >= 5 ? SEVERITY.high.color : Math.abs(v) >= 3 ? SEVERITY.medium.color : 'var(--text-secondary)')
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px] tabular-nums">
        <thead>
          <tr className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
            <th className="text-left font-normal py-1 pr-2">Band, dB vs</th>
            {cols.map(col => <th key={col.key} className="text-right font-normal py-1 pl-2 max-w-[7rem] truncate">{col.head}</th>)}
          </tr>
        </thead>
        <tbody>
          {report.bands!.map(b => (
            <tr key={b.key} style={{ borderTop: '1px solid var(--border)' }}>
              <td className="py-1 pr-2 text-[var(--text-secondary)]">{b.label} <span className="text-[var(--text-muted)]">{b.range}</span></td>
              {cols.map(col => (
                <td key={col.key} className="py-1 pl-2 text-right" style={{ color: tone(b[col.key]) }}>
                  {b[col.key] == null ? '·' : signed(b[col.key]!)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const W = 340

function SpectrumChart({ curves }: { curves: NonNullable<MixCheckReport['curves']> }) {
  const H = 150, ml = 26, mr = 6, mt = 8, mb = 18
  const series = [
    { name: 'Genre', data: curves.industry, color: 'var(--text-muted)', dash: '3 3', width: 1.2 },
    { name: 'Catalog', data: curves.catalog, color: 'var(--text-secondary)', dash: '', width: 1.2 },
    { name: 'Previous', data: curves.previous, color: '#60a5fa', dash: '', width: 1.4 },
    { name: 'This mix', data: curves.mix, color: 'var(--accent)', dash: '', width: 2 },
  ].filter(s => s.data)
  const all = series.flatMap(s => s.data as number[]).filter(v => v > -80)
  if (!all.length) return null
  const top = Math.ceil(Math.max(...all) / 5) * 5, bottom = Math.max(top - 40, Math.floor(Math.min(...all) / 5) * 5)
  const lo = THIRD_OCTAVE_HZ[0], hi = THIRD_OCTAVE_HZ[THIRD_OCTAVE_HZ.length - 1]
  const x = (f: number) => ml + (W - ml - mr) * (Math.log(f / lo) / Math.log(hi / lo))
  const y = (v: number) => mt + (H - mt - mb) * ((top - Math.max(bottom, Math.min(top, v))) / (top - bottom))
  const path = (d: number[]) => d.map((v, i) => `${i ? 'L' : 'M'}${x(THIRD_OCTAVE_HZ[i]).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const ticks = [30, 60, 120, 250, 500, 1000, 2000, 4000, 8000]
  return (
    <figure className="space-y-1">
      <figcaption className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] flex flex-wrap gap-x-3 gap-y-0.5">
        <span>Balance where the mix is fullest</span>
        {series.map(s => (
          <span key={s.name} className="normal-case tracking-normal flex items-center gap-1">
            <span className="inline-block w-3" style={{ borderTop: `2px ${s.dash ? 'dashed' : 'solid'} ${s.color}` }} />{s.name}
          </span>
        ))}
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Spectrum of this mix against its comparisons">
        {[top, top - 10, top - 20, top - 30, top - 40].filter(v => v >= bottom).map(v => (
          <g key={v}>
            <line x1={ml} x2={W - mr} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeWidth="1" />
            <text x={ml - 4} y={y(v) + 3} textAnchor="end" fontSize="8" fill="var(--text-muted)">{v}</text>
          </g>
        ))}
        {ticks.map(f => (
          <text key={f} x={x(f)} y={H - 5} textAnchor="middle" fontSize="8" fill="var(--text-muted)">{f >= 1000 ? `${f / 1000}k` : f}</text>
        ))}
        {series.map(s => (
          <path key={s.name} d={path(s.data as number[])} fill="none" stroke={s.color} strokeWidth={s.width} strokeDasharray={s.dash} strokeLinejoin="round" />
        ))}
      </svg>
    </figure>
  )
}

function SubTimeline({ report, onJump }: { report: MixCheckReport; onJump: (s: number) => void }) {
  const d = report.detail!
  const H = 96, ml = 26, mr = 6, mt = 8, mb = 16
  const n = d.timeline.sub.length
  if (n < 10) return null
  const vals = d.timeline.sub.filter(v => v > -80)
  if (!vals.length) return null
  const top = Math.ceil(Math.max(...vals) / 5) * 5, bottom = top - 30
  const x = (s: number) => ml + (W - ml - mr) * (s / n)
  const y = (v: number) => mt + (H - mt - mb) * ((top - Math.max(bottom, Math.min(top, v))) / (top - bottom))
  // 4-second steps: per-second values are too jumpy to read at this size.
  const step = 4
  let line = ''
  for (let s = 0; s < n; s += step) {
    const seg = d.timeline.sub.slice(s, s + step).filter(v => v > -119)
    const v = seg.length ? 10 * Math.log10(seg.reduce((a, b) => a + Math.pow(10, b / 10), 0) / seg.length) : bottom
    line += `${s ? 'L' : 'M'}${x(s).toFixed(1)},${y(v).toFixed(1)} L${x(Math.min(n, s + step)).toFixed(1)},${y(v).toFixed(1)} `
  }
  const marks = (report.findings ?? []).filter(f => f.at != null)
  const tickEvery = n > 360 ? 120 : 60
  return (
    <figure className="space-y-1">
      <figcaption className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
        Sub level through the song <span className="normal-case tracking-normal">· shaded where the kick plays · dots are notes</span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Sub level over time">
        {d.sections.filter(s => s.kind === 'rhythm').map(s => (
          <rect key={s.start} x={x(s.start)} y={mt} width={x(s.end) - x(s.start)} height={H - mt - mb} fill="var(--text-muted)" opacity="0.12" />
        ))}
        {[top, top - 10, top - 20, top - 30].map(v => (
          <g key={v}>
            <line x1={ml} x2={W - mr} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeWidth="1" />
            <text x={ml - 4} y={y(v) + 3} textAnchor="end" fontSize="8" fill="var(--text-muted)">{v}</text>
          </g>
        ))}
        {Array.from({ length: Math.floor(n / tickEvery) + 1 }, (_, i) => i * tickEvery).map(s => (
          <text key={s} x={x(s)} y={H - 4} textAnchor="middle" fontSize="8" fill="var(--text-muted)">{clock(s)}</text>
        ))}
        <path d={line} fill="none" stroke="var(--accent)" strokeWidth="1.6" strokeLinejoin="round" />
        {marks.map(f => (
          <circle key={f.code} cx={x(f.at!)} cy={mt + 3} r="3" fill={SEVERITY[f.severity].color} style={{ cursor: 'pointer' }} onClick={() => onJump(f.at!)}>
            <title>{`${clock(f.at!)} · ${f.title}`}</title>
          </circle>
        ))}
      </svg>
    </figure>
  )
}

// The genre references, and adding one from a full-quality file. The file goes
// straight to Storage (POST /api/upload-url → PUT), the server measures it and
// deletes it: only the measurement is kept.
function References({ report, projectId }: { report: MixCheckReport; projectId: string }) {
  const c = report.compared
  const [open, setOpen] = useState(false)
  const [artist, setArtist] = useState('')
  const [title, setTitle] = useState('')
  const [family, setFamily] = useState<string>(c?.family ?? GENRE_FAMILIES[0].key)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const refs = c?.references ?? []

  const add = async () => {
    const file = fileRef.current?.files?.[0]
    if (!file || !artist.trim() || !title.trim()) { setMessage('Pick a file and fill in the artist and title.'); return }
    if (file.size > 50 * 1024 * 1024) { setMessage('That file is over 50 MB. A shorter WAV or a 320 kbps MP3 of the track measures the same.'); return }
    const ext = (file.name.split('.').pop() ?? '').toLowerCase()
    if (!['wav', 'aif', 'aiff', 'flac', 'mp3', 'm4a'].includes(ext)) { setMessage('Use a WAV, AIFF, FLAC, MP3 or M4A file.'); return }
    setBusy(true); setMessage('Uploading…')
    try {
      const path = `${projectId}/mixref-${Date.now()}.${ext}`
      const signed = await fetch('/api/upload-url', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: path, contentType: file.type || 'application/octet-stream', bucket: 'mf-audio' }),
      })
      if (!signed.ok) throw new Error('Could not start the upload')
      const { signedUrl } = await signed.json()
      const put = await fetch(signedUrl, { method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file })
      if (!put.ok) throw new Error('The upload failed')
      setMessage('Measuring…')
      const res = await fetch('/api/mix-check/references', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, path, family, artist: artist.trim(), title: title.trim() }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.error ?? 'Could not measure that file')
      setMessage(`Added to the ${genreFamilyLabel(family)} references. The file was not kept. Check the mix again to use it.`)
      setArtist(''); setTitle('')
      if (fileRef.current) fileRef.current.value = ''
    } catch (err) {
      setMessage((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg px-2.5 py-2" style={{ border: '1px solid var(--border)' }}>
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} className="w-full flex items-center justify-between text-[11px] text-[var(--text-muted)] hover:text-[var(--text)] transition-colors">
        <span>
          {c?.industry
            ? `Genre references: ${c.industry.count} ${c.industry.label} tracks${c.genreAssumed ? ' (no genre on this song, so your usual one)' : ''}`
            : 'Genre references: none for this genre yet'}
        </span>
        {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {refs.length > 0 && (
            <ul className="text-[11px] text-[var(--text-secondary)] space-y-0.5">
              {refs.map(r => (
                <li key={`${r.artist}|${r.title}`}>
                  {r.artist} · {r.title} <span className="text-[var(--text-muted)]">{r.source === 'full' ? 'full file' : 'preview'}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[10px] leading-relaxed text-[var(--text-muted)]">
            Previews are short and lossy: good for balance, not for loudness. Add a full-quality file of a track and it replaces its preview. Only the measurement is kept, never the audio.
          </p>
          <div className="grid grid-cols-2 gap-1.5">
            <input id="mixref-artist" value={artist} onChange={e => setArtist(e.target.value)} placeholder="Artist" maxLength={120} className="text-xs px-2 py-1.5 rounded-md bg-transparent text-[var(--text)]" style={{ border: '1px solid var(--border)' }} />
            <input id="mixref-title" value={title} onChange={e => setTitle(e.target.value)} placeholder="Track title" maxLength={120} className="text-xs px-2 py-1.5 rounded-md bg-transparent text-[var(--text)]" style={{ border: '1px solid var(--border)' }} />
            <select id="mixref-family" value={family} onChange={e => setFamily(e.target.value)} className="text-xs px-2 py-1.5 rounded-md bg-transparent text-[var(--text)]" style={{ border: '1px solid var(--border)' }}>
              {GENRE_FAMILIES.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
            </select>
            <input id="mixref-file" ref={fileRef} type="file" accept=".wav,.aif,.aiff,.flac,.mp3,.m4a,audio/*" className="text-[11px] text-[var(--text-muted)]" />
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={add} disabled={busy} className="text-[11px] px-2.5 py-1 rounded-full border text-[var(--text-secondary)] hover:text-[var(--text)] disabled:opacity-40 flex items-center gap-1 transition-colors" style={{ borderColor: 'var(--border)' }}>
              <Plus size={11} /> Add reference
            </button>
            {message && <span className="text-[11px] text-[var(--text-muted)]">{message}</span>}
          </div>
        </div>
      )}
    </div>
  )
}
