'use client'

import { useMemo, useState, useEffect } from 'react'
import Link from 'next/link'
import {
  Send, Search, Check, ChevronLeft, Upload, Download, Plus, X,
  ExternalLink, AlertTriangle, Trash2, Pencil, ListMusic, FileText,
} from 'lucide-react'
import {
  type Curator, type SbSubmission, type Song, type FilterState, type CuratorType,
  type ContactMethod, type Confidence, type CuratorInsert,
  EMPTY_FILTERS, SUBMISSION_STATUSES, allGenres, applyFilters, resolveSend, actionLabel,
  buildMailto, copyToClipboard, renderTemplate, splitSubjectBody, loadTemplate, saveTemplate,
  resetTemplate, DEFAULT_TEMPLATE, curatorsToCsv, parseCuratorCsv, EXAMPLE_CSV,
} from '@/lib/submit'

const TYPES: CuratorType[] = ['label', 'playlist', 'blog', 'radio', 'influencer', 'other']
const METHODS: ContactMethod[] = ['form', 'email', 'soundcloud', 'instagram', 'twitter', 'other']

const RESPONDED = ['responded', 'accepted', 'rejected']

function download(name: string, text: string) {
  const blob = new Blob([text], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

// ── Small reusable confidence badge ──
function ConfidenceBadge({ c }: { c: Curator }) {
  if (c.confidence === 'UNVERIFIED') {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium"
        style={{ background: 'rgba(255,176,32,0.12)', color: '#ffb020' }}>
        <AlertTriangle size={11} /> Unverified
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{ background: 'rgba(74,222,128,0.12)', color: '#4ade80' }}>
      <Check size={11} /> Verified
    </span>
  )
}

export default function SubmitClient({
  songs, initialCurators, initialSubmissions,
}: {
  songs: Song[]
  initialCurators: Curator[]
  initialSubmissions: SbSubmission[]
  userId: string
}) {
  const [curators, setCurators] = useState<Curator[]>(initialCurators)
  const [submissions, setSubmissions] = useState<SbSubmission[]>(initialSubmissions)
  const [view, setView] = useState<'compose' | 'tracker'>('compose')
  const [step, setStep] = useState<'select' | 'review'>('select')

  const [songId, setSongId] = useState(songs[0]?.project_id ?? '')
  const [pitch, setPitch] = useState('')
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [messages, setMessages] = useState<Record<string, string>>({})
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE)

  const [toast, setToast] = useState<{ msg: string; kind: 'ok' | 'warn' } | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [editing, setEditing] = useState<Curator | null>(null)
  const [templateOpen, setTemplateOpen] = useState(false)

  useEffect(() => {
    // Load the saved template once (deferred so it isn't a sync setState in effect).
    Promise.resolve().then(() => setTemplate(loadTemplate()))
  }, [])

  function showToast(msg: string, kind: 'ok' | 'warn' = 'ok') {
    setToast({ msg, kind })
    setTimeout(() => setToast(null), 3200)
  }

  const song = songs.find((s) => s.project_id === songId)
  const genres = useMemo(() => allGenres(curators), [curators])
  const filtered = useMemo(() => applyFilters(curators, filters), [curators, filters])
  const selectedCurators = useMemo(() => curators.filter((c) => selected.has(c.id)), [curators, selected])
  const sentCuratorIds = useMemo(() => {
    const set = new Set<string>()
    for (const s of submissions) if (s.curator_id && (!song || s.project_id === song.project_id)) set.add(s.curator_id)
    return set
  }, [submissions, song])

  function shareUrlFor(s: Song | undefined): string {
    if (!s?.share_token) return ''
    const origin = typeof window !== 'undefined' ? window.location.origin : ''
    return `${origin}/share/${s.share_token}`
  }

  async function refreshCurators() {
    const r = await fetch('/api/sb-curators')
    if (r.ok) setCurators(await r.json())
  }

  // ── selection ──
  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  function selectAllFiltered() {
    setSelected((prev) => {
      const next = new Set(prev)
      filtered.forEach((c) => next.add(c.id))
      return next
    })
  }

  function goReview() {
    if (!song) return showToast('Pick a song first.', 'warn')
    if (selected.size === 0) return showToast('Select at least one curator.', 'warn')
    const shareUrl = shareUrlFor(song)
    setMessages((prev) => {
      const next = { ...prev }
      for (const c of selectedCurators) {
        next[c.id] = renderTemplate(template, c, song, shareUrl, pitch)
      }
      return next
    })
    setStep('review')
    window.scrollTo({ top: 0 })
  }

  async function logSubmission(curator: Curator, message: string) {
    if (!song) return
    const { channel } = resolveSend(curator)
    const res = await fetch('/api/sb-submissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: song.project_id,
        version_id: song.latest_version_id,
        curator_id: curator.id,
        channel,
        message,
        share_url: shareUrlFor(song),
      }),
    })
    if (res.ok) {
      const row = await res.json()
      setSubmissions((prev) => [row, ...prev])
    } else {
      showToast(`Could not log ${curator.name}.`, 'warn')
    }
  }

  async function doAction(curator: Curator) {
    const message = messages[curator.id] ?? ''
    const { kind } = resolveSend(curator)
    const { subject, body } = splitSubjectBody(message)
    if (kind === 'email') {
      window.location.assign(buildMailto(curator.contact_value ?? '', subject, body))
    } else if (kind === 'spotify') {
      window.open(curator.contact_value ?? '', '_blank', 'noopener')
      showToast('Pitch ONE unreleased song 2–4 weeks early in Spotify for Artists.')
    } else {
      const ok = await copyToClipboard(message)
      window.open(curator.contact_value ?? '', '_blank', 'noopener')
      showToast(ok ? 'Message copied — paste it on the page.' : 'Open the page and paste your message.')
    }
    await logSubmission(curator, message)
  }

  // ── curator CRUD ──
  async function onImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const { rows, errors } = parseCuratorCsv(await file.text())
    e.target.value = ''
    if (rows.length === 0) return showToast(errors[0] ?? 'No valid rows.', 'warn')
    const res = await fetch('/api/sb-curators', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows }),
    })
    if (res.ok) {
      const { inserted } = await res.json()
      showToast(`Imported ${inserted} curators${errors.length ? ` (${errors.length} skipped)` : ''}.`, errors.length ? 'warn' : 'ok')
      refreshCurators()
    } else {
      showToast('Import failed.', 'warn')
    }
  }

  async function deleteCurator(c: Curator) {
    if (!confirm(`Delete "${c.name}"? (Only removes your own entry.)`)) return
    const res = await fetch(`/api/sb-curators/${c.id}`, { method: 'DELETE' })
    if (res.ok) { showToast('Deleted.'); setCurators((prev) => prev.filter((x) => x.id !== c.id)) }
    else showToast('Delete failed.', 'warn')
  }

  async function setStatus(id: string, status: string) {
    const res = await fetch(`/api/sb-submissions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    if (res.ok) {
      const row = await res.json()
      setSubmissions((prev) => prev.map((s) => (s.id === id ? row : s)))
    }
  }

  const curatorName = (id: string | null) => curators.find((c) => c.id === id)?.name ?? '—'
  const songTitle = (id: string | null) => songs.find((s) => s.project_id === id)?.title ?? '—'

  const stats = useMemo(() => {
    const total = submissions.length
    const sent = submissions.filter((s) => s.status !== 'draft').length
    const responses = submissions.filter((s) => RESPONDED.includes(s.status)).length
    const accepted = submissions.filter((s) => s.status === 'accepted').length
    return { total, sent, responses, accepted, rate: sent ? Math.round((responses / sent) * 100) : 0 }
  }, [submissions])

  const card: React.CSSProperties = { background: 'var(--card-bg)', borderColor: 'var(--border)' }
  const inputStyle: React.CSSProperties = { background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)' }

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 pb-36 md:pb-12 py-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2" style={{ color: 'var(--text)' }}>
            <Send size={18} style={{ color: 'var(--accent)' }} /> Submit to Curators
          </h1>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Pitch a mixBASE song to labels, blogs & playlist editors through each curator&apos;s own free channel.
          </p>
        </div>
        <div className="flex rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border)' }}>
          {(['compose', 'tracker'] as const).map((v) => (
            <button key={v} onClick={() => setView(v)}
              className="px-4 py-2 text-sm font-medium transition-colors"
              style={{ background: view === v ? 'var(--accent)' : 'var(--surface)', color: view === v ? '#0d0b08' : 'var(--text-muted)' }}>
              {v === 'compose' ? 'New submission' : `Tracker (${submissions.length})`}
            </button>
          ))}
        </div>
      </div>

      {/* ============ TRACKER ============ */}
      {view === 'tracker' ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            {[
              ['Total', stats.total], ['Sent', stats.sent], ['Responses', stats.responses],
              ['Accepted', stats.accepted], ['Response rate', `${stats.rate}%`],
            ].map(([label, val]) => (
              <div key={label} className="rounded-2xl border p-4" style={card}>
                <div className="text-2xl font-semibold" style={{ color: 'var(--text)' }}>{val}</div>
                <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>{label}</div>
              </div>
            ))}
          </div>

          {submissions.length === 0 ? (
            <div className="rounded-2xl border p-10 text-center text-sm" style={{ ...card, color: 'var(--text-muted)' }}>
              No submissions yet.
            </div>
          ) : (
            <div className="rounded-2xl border overflow-hidden" style={card}>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide border-b" style={{ color: 'var(--text-muted)', borderColor: 'var(--border)' }}>
                    <th className="px-4 py-2.5">Song</th>
                    <th className="px-4 py-2.5">Curator</th>
                    <th className="px-4 py-2.5 hidden sm:table-cell">Channel</th>
                    <th className="px-4 py-2.5 hidden sm:table-cell">Date</th>
                    <th className="px-4 py-2.5">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {submissions.map((s) => (
                    <tr key={s.id} className="border-b last:border-0" style={{ borderColor: 'var(--border)' }}>
                      <td className="px-4 py-2.5" style={{ color: 'var(--text)' }}>{songTitle(s.project_id)}</td>
                      <td className="px-4 py-2.5" style={{ color: 'var(--text-secondary)' }}>{curatorName(s.curator_id)}</td>
                      <td className="px-4 py-2.5 hidden sm:table-cell" style={{ color: 'var(--text-muted)' }}>{s.channel}</td>
                      <td className="px-4 py-2.5 hidden sm:table-cell" style={{ color: 'var(--text-muted)' }}>
                        {new Date(s.sent_at ?? s.created_at).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-2.5">
                        <select value={s.status} onChange={(e) => setStatus(s.id, e.target.value)}
                          className="rounded-lg border px-2 py-1 text-xs outline-none" style={inputStyle}>
                          {SUBMISSION_STATUSES.map((st) => <option key={st} value={st}>{st}</option>)}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : step === 'review' ? (
        /* ============ REVIEW ============ */
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button onClick={() => setStep('select')} className="inline-flex items-center gap-1 text-sm" style={{ color: 'var(--text-muted)' }}>
              <ChevronLeft size={15} /> Back to selection
            </button>
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              Pitching <span style={{ color: 'var(--text)' }}>{song?.title}</span> to {selectedCurators.length} curators
            </p>
          </div>

          {selectedCurators.map((c) => {
            const done = sentCuratorIds.has(c.id)
            return (
              <div key={c.id} className="rounded-2xl border p-4" style={{ ...card, opacity: done ? 0.6 : 1 }}>
                <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2">
                    <span className="font-medium" style={{ color: 'var(--text)' }}>{c.name}</span>
                    <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{c.contact_method}</span>
                    {done && <span className="text-[11px]" style={{ color: '#4ade80' }}>✓ logged</span>}
                  </div>
                  <ConfidenceBadge c={c} />
                </div>

                {c.confidence === 'UNVERIFIED' && (
                  <div className="mb-2 rounded-lg px-3 py-2 text-xs flex items-center gap-1.5" style={{ background: 'rgba(255,176,32,0.1)', color: '#ffb020' }}>
                    <AlertTriangle size={13} /> Unverified channel — confirm at{' '}
                    {c.source_url ? <a href={c.source_url} target="_blank" rel="noopener noreferrer" className="underline">the source</a> : 'the source'} before sending.
                  </div>
                )}
                {c.guidelines && (
                  <p className="mb-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>Guidelines:</span> {c.guidelines}
                  </p>
                )}

                <textarea value={messages[c.id] ?? ''} onChange={(e) => setMessages((m) => ({ ...m, [c.id]: e.target.value }))}
                  className="w-full rounded-xl border px-3 py-2 text-xs font-[family-name:var(--font-mono)] outline-none min-h-[140px]" style={inputStyle} />

                <div className="mt-2 flex items-center justify-between gap-2">
                  <span className="text-[11px] break-all" style={{ color: 'var(--text-muted)' }}>→ {c.contact_value}</span>
                  <button onClick={() => doAction(c)}
                    className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold whitespace-nowrap"
                    style={{ background: 'var(--accent)', color: '#0d0b08' }}>
                    {resolveSend(c).kind === 'email' ? <Send size={12} /> : <ExternalLink size={12} />}
                    {actionLabel(c)}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        /* ============ SELECT ============ */
        <div className="space-y-4">
          {/* Song picker */}
          <div className="rounded-2xl border p-4" style={card}>
            <label className="block text-[11px] uppercase tracking-wide mb-1" style={{ color: 'var(--text-muted)' }}>Song to pitch</label>
            {songs.length === 0 ? (
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                No projects yet — <Link href="/projects/new" className="underline" style={{ color: 'var(--accent)' }}>create one</Link> first.
              </p>
            ) : (
              <>
                <select value={songId} onChange={(e) => setSongId(e.target.value)}
                  className="w-full rounded-xl border px-3 py-2 text-sm outline-none" style={inputStyle}>
                  {songs.map((s) => <option key={s.project_id} value={s.project_id}>{s.title}{s.genre ? ` · ${s.genre}` : ''}</option>)}
                </select>
                <div className="mt-2 flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  <ListMusic size={12} />
                  {song?.share_token
                    ? <>Curators receive this private listening link: <span style={{ color: 'var(--text-secondary)' }}>/share/{song.share_token}</span></>
                    : <span style={{ color: '#ffb020' }}>This song has no share link yet — open the project once to generate one.</span>}
                </div>
                <textarea value={pitch} onChange={(e) => setPitch(e.target.value)} placeholder="Optional: a 2–3 sentence pitch for this song (fills {pitch} in the message)."
                  className="mt-3 w-full rounded-xl border px-3 py-2 text-sm outline-none min-h-[60px]" style={inputStyle} />
              </>
            )}
          </div>

          {/* Directory toolbar */}
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => setAddOpen(true)} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold" style={{ background: 'var(--accent)', color: '#0d0b08' }}><Plus size={13} /> Add curator</button>
            <label className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs cursor-pointer" style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}>
              <Upload size={13} /> Import CSV
              <input type="file" accept=".csv,text/csv" className="hidden" onChange={onImportFile} />
            </label>
            <button onClick={() => download('submitbase-curators.csv', curatorsToCsv(curators))} className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs" style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}><Download size={13} /> Export</button>
            <button onClick={() => download('submitbase-example.csv', EXAMPLE_CSV)} className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs" style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}><FileText size={13} /> Example</button>
            <button onClick={() => setTemplateOpen(true)} className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs" style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}><Pencil size={13} /> Template</button>
          </div>

          {/* Filters */}
          <div className="rounded-2xl border p-4 space-y-3" style={card}>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-[180px]">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
                <input value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} placeholder="Search by name…"
                  className="w-full rounded-xl border pl-9 pr-3 py-2 text-sm outline-none" style={inputStyle} />
              </div>
              <select value={filters.confidence} onChange={(e) => setFilters({ ...filters, confidence: e.target.value as Confidence | 'all' })}
                className="rounded-xl border px-3 py-2 text-sm outline-none" style={inputStyle}>
                <option value="all">All confidence</option>
                <option value="VERIFIED">Verified only</option>
                <option value="UNVERIFIED">Unverified only</option>
              </select>
              <select value={filters.sort} onChange={(e) => setFilters({ ...filters, sort: e.target.value as 'name' | 'type' })}
                className="rounded-xl border px-3 py-2 text-sm outline-none" style={inputStyle}>
                <option value="name">Sort: Name</option>
                <option value="type">Sort: Type</option>
              </select>
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{filtered.length} curators</span>
            </div>
            <PillRow label="Type" items={TYPES} active={filters.types} onToggle={(t) => setFilters({ ...filters, types: toggleArr(filters.types, t) })} />
            <PillRow label="Channel" items={METHODS} active={filters.methods} onToggle={(m) => setFilters({ ...filters, methods: toggleArr(filters.methods, m) })} />
            {genres.length > 0 && <PillRow label="Genre" items={genres} active={filters.genres} onToggle={(g) => setFilters({ ...filters, genres: toggleArr(filters.genres, g) })} />}
          </div>

          {/* Action bar */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex gap-2">
              <button onClick={selectAllFiltered} className="rounded-lg border px-3 py-1.5 text-xs" style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}>Select all filtered ({filtered.length})</button>
              <button onClick={() => setSelected(new Set())} className="rounded-lg border px-3 py-1.5 text-xs" style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}>Clear ({selected.size})</button>
            </div>
            <button onClick={goReview} disabled={!songId || selected.size === 0}
              className="inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-40"
              style={{ background: 'var(--accent)', color: '#0d0b08' }}>
              Review {selected.size} selected <ChevronLeft size={15} className="rotate-180" />
            </button>
          </div>

          {/* Curator list */}
          <div className="space-y-2">
            {filtered.map((c) => {
              const checked = selected.has(c.id)
              const owned = !!c.user_id
              return (
                <div key={c.id} className="rounded-xl border p-3 flex items-center gap-3" style={{ ...card, borderColor: checked ? 'var(--accent)' : 'var(--border)' }}>
                  <input type="checkbox" checked={checked} onChange={() => toggle(c.id)} className="h-4 w-4" style={{ accentColor: 'var(--accent)' }} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium" style={{ color: 'var(--text)' }}>{c.name}</span>
                      <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{c.type} · {c.contact_method}</span>
                      {owned && <span className="text-[10px] rounded-full px-1.5 py-0.5" style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}>yours</span>}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {(c.genres ?? []).slice(0, 5).map((g) => (
                        <span key={g} className="text-[10px] rounded-full px-1.5 py-0.5" style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}>{g}</span>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {c.confidence === 'UNVERIFIED' && c.source_url && (
                      <a href={c.source_url} target="_blank" rel="noopener noreferrer" title="Confirm source" style={{ color: '#ffb020' }}><ExternalLink size={13} /></a>
                    )}
                    <ConfidenceBadge c={c} />
                    {owned && (
                      <>
                        <button onClick={() => setEditing(c)} title="Edit" style={{ color: 'var(--text-muted)' }}><Pencil size={13} /></button>
                        <button onClick={() => deleteCurator(c)} title="Delete" style={{ color: '#f87171' }}><Trash2 size={13} /></button>
                      </>
                    )}
                  </div>
                </div>
              )
            })}
            {filtered.length === 0 && <p className="text-center py-10 text-sm" style={{ color: 'var(--text-muted)' }}>No curators match these filters.</p>}
          </div>
        </div>
      )}

      {/* Add / Edit modal */}
      {(addOpen || editing) && (
        <CuratorModal
          existing={editing}
          onClose={() => { setAddOpen(false); setEditing(null) }}
          onSaved={() => { setAddOpen(false); setEditing(null); refreshCurators() }}
          showToast={showToast}
        />
      )}

      {/* Template modal */}
      {templateOpen && (
        <Modal title="Message template" onClose={() => setTemplateOpen(false)}>
          <p className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
            Keep the first line as <code style={{ color: 'var(--text)' }}>Subject:</code>. Fields: {'{curator_name} {track_title} {genre} {pitch} {track_url} {platform}'}
          </p>
          <textarea value={template} onChange={(e) => setTemplate(e.target.value)}
            className="w-full rounded-xl border px-3 py-2 text-xs font-[family-name:var(--font-mono)] outline-none min-h-[260px]" style={inputStyle} />
          <div className="mt-3 flex justify-end gap-2">
            <button onClick={() => { resetTemplate(); setTemplate(DEFAULT_TEMPLATE); showToast('Reset to default.') }} className="rounded-lg border px-3 py-1.5 text-sm" style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}>Reset</button>
            <button onClick={() => { saveTemplate(template); setTemplateOpen(false); showToast('Template saved.') }} className="rounded-lg px-3 py-1.5 text-sm font-semibold" style={{ background: 'var(--accent)', color: '#0d0b08' }}>Save</button>
          </div>
        </Modal>
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed left-1/2 -translate-x-1/2 z-[60] rounded-xl border px-4 py-2.5 text-sm shadow-lg"
          style={{ bottom: 'calc(env(safe-area-inset-bottom) + 5rem)', background: 'var(--surface-2)', borderColor: toast.kind === 'warn' ? '#ffb020' : 'var(--border)', color: toast.kind === 'warn' ? '#ffb020' : 'var(--text)' }}>
          {toast.msg}
        </div>
      )}
    </div>
  )
}

function toggleArr<T>(arr: T[], v: T): T[] {
  return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]
}

function PillRow<T extends string>({ label, items, active, onToggle }: { label: string; items: T[]; active: T[]; onToggle: (v: T) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] uppercase tracking-wide mr-1" style={{ color: 'var(--text-muted)' }}>{label}</span>
      {items.map((it) => {
        const on = active.includes(it)
        return (
          <button key={it} onClick={() => onToggle(it)} className="rounded-full px-2.5 py-0.5 text-xs border transition-colors"
            style={{ borderColor: on ? 'var(--accent)' : 'var(--border)', background: on ? 'var(--accent-dim)' : 'var(--surface)', color: on ? 'var(--text)' : 'var(--text-muted)' }}>
            {it}
          </button>
        )
      })}
    </div>
  )
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-[55] flex items-start justify-center overflow-y-auto p-4 py-10" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl border p-5" style={{ background: 'var(--card-bg)', borderColor: 'var(--border)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold" style={{ color: 'var(--text)' }}>{title}</h2>
          <button onClick={onClose} style={{ color: 'var(--text-muted)' }}><X size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  )
}

function CuratorModal({ existing, onClose, onSaved, showToast }: {
  existing: Curator | null
  onClose: () => void
  onSaved: () => void
  showToast: (m: string, k?: 'ok' | 'warn') => void
}) {
  const [form, setForm] = useState<CuratorInsert>({
    name: existing?.name ?? '',
    type: existing?.type ?? 'label',
    platform: existing?.platform ?? '',
    genres: existing?.genres ?? [],
    contact_method: existing?.contact_method ?? 'form',
    contact_value: existing?.contact_value ?? '',
    audience_size: existing?.audience_size ?? null,
    accepts_submissions: existing?.accepts_submissions ?? true,
    guidelines: existing?.guidelines ?? '',
    confidence: existing?.confidence ?? 'VERIFIED',
    source_url: existing?.source_url ?? '',
  })
  const [genreText, setGenreText] = useState((existing?.genres ?? []).join(', '))
  const [saving, setSaving] = useState(false)
  const inputStyle: React.CSSProperties = { background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)' }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    const payload = { ...form, genres: genreText.split(',').map((g) => g.trim()).filter(Boolean) }
    const res = existing
      ? await fetch(`/api/sb-curators/${existing.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      : await fetch('/api/sb-curators', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    setSaving(false)
    if (res.ok) { showToast(existing ? 'Saved.' : 'Curator added.'); onSaved() }
    else showToast('Save failed.', 'warn')
  }

  const field = 'w-full rounded-xl border px-3 py-2 text-sm outline-none'
  const lbl = 'block text-[11px] uppercase tracking-wide mb-1'

  return (
    <Modal title={existing ? 'Edit curator' : 'Add curator'} onClose={onClose}>
      <form onSubmit={save} className="space-y-3">
        <div><label className={lbl} style={{ color: 'var(--text-muted)' }}>Name *</label>
          <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={field} style={inputStyle} /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className={lbl} style={{ color: 'var(--text-muted)' }}>Type</label>
            <select value={form.type ?? 'label'} onChange={(e) => setForm({ ...form, type: e.target.value as CuratorType })} className={field} style={inputStyle}>
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select></div>
          <div><label className={lbl} style={{ color: 'var(--text-muted)' }}>Channel</label>
            <select value={form.contact_method ?? 'form'} onChange={(e) => setForm({ ...form, contact_method: e.target.value as ContactMethod })} className={field} style={inputStyle}>
              {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select></div>
        </div>
        <div><label className={lbl} style={{ color: 'var(--text-muted)' }}>Contact value (email or URL)</label>
          <input value={form.contact_value ?? ''} onChange={(e) => setForm({ ...form, contact_value: e.target.value })} className={field} style={inputStyle} placeholder="demos@label.com or https://label.com/demos" /></div>
        <div><label className={lbl} style={{ color: 'var(--text-muted)' }}>Genres (comma-separated)</label>
          <input value={genreText} onChange={(e) => setGenreText(e.target.value)} className={field} style={inputStyle} placeholder="house, tech house" /></div>
        <div><label className={lbl} style={{ color: 'var(--text-muted)' }}>Guidelines</label>
          <textarea value={form.guidelines ?? ''} onChange={(e) => setForm({ ...form, guidelines: e.target.value })} className={field} style={inputStyle} /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className={lbl} style={{ color: 'var(--text-muted)' }}>Confidence</label>
            <select value={form.confidence} onChange={(e) => setForm({ ...form, confidence: e.target.value as Confidence })} className={field} style={inputStyle}>
              <option value="VERIFIED">VERIFIED</option>
              <option value="UNVERIFIED">UNVERIFIED</option>
            </select></div>
          <div><label className={lbl} style={{ color: 'var(--text-muted)' }}>Source URL</label>
            <input value={form.source_url ?? ''} onChange={(e) => setForm({ ...form, source_url: e.target.value })} className={field} style={inputStyle} /></div>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="rounded-lg border px-3 py-1.5 text-sm" style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}>Cancel</button>
          <button type="submit" disabled={saving} className="rounded-lg px-3 py-1.5 text-sm font-semibold disabled:opacity-50" style={{ background: 'var(--accent)', color: '#0d0b08' }}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  )
}
