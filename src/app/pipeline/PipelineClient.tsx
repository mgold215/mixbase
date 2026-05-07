'use client'

import { useState, type FormEvent } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { Plus, ChevronDown, ChevronUp, Trash2, CalendarRange } from 'lucide-react'
import { displayArtworkUrl, type Release } from '@/lib/supabase'

type ReleaseWithProject = Release & {
  mb_projects: { title: string; artwork_url: string | null; finalized_artwork_url: string | null } | null
}
type VersionLite = { id: string; project_id: string; version_number: number; label: string | null; status: string }

type Props = {
  initialReleases: ReleaseWithProject[]
  projects: { id: string; title: string }[]
  versions: VersionLite[]
}

const CHECKLIST_ITEMS = [
  { key: 'mixing_done', label: 'Mixing done' },
  { key: 'mastering_done', label: 'Mastering done' },
  { key: 'artwork_ready', label: 'Artwork ready' },
  { key: 'press_release_done', label: 'Pre-save link live' },
  { key: 'dsp_submitted', label: 'DistroKid submitted' },
  { key: 'social_posts_done', label: 'Social posts scheduled' },
] as const

// Post-launch campaign steps — reuses dsp_* DB columns, no migration needed
const POST_LAUNCH_ITEMS = [
  { key: 'dsp_spotify',     label: 'Brazil Showcase launched', hint: '$100 · launch day' },
  { key: 'dsp_apple_music', label: 'US Showcase launched',     hint: '$100 · launch day' },
  { key: 'dsp_youtube',     label: 'Canvas uploaded to Spotify', hint: '+15% saves' },
  { key: 'dsp_tidal',       label: 'Save rate ≥6%? Add Marquee', hint: '$100 · check T+48h' },
  { key: 'dsp_soundcloud',  label: 'Curator emails sent',      hint: 'email-agents' },
  { key: 'dsp_amazon',      label: 'Meta ad live',             hint: 'Hypeddit · evergreen' },
  { key: 'dsp_bandcamp',    label: 'Release Radar fired?',     hint: 'check T+7' },
] as const

function completionPercent(release: Release): number {
  const allItems = [...CHECKLIST_ITEMS, ...POST_LAUNCH_ITEMS]
  const checks = allItems.filter(c => release[c.key as keyof Release]).length
  return Math.round((checks / allItems.length) * 100)
}

function daysUntil(dateStr: string | null): string | null {
  if (!dateStr) return null
  const diff = new Date(dateStr).getTime() - Date.now()
  const days = Math.ceil(diff / (1000 * 60 * 60 * 24))
  if (days < 0) return 'Released'
  if (days === 0) return 'Today'
  if (days === 1) return '1 day'
  return `${days} days`
}

export default function PipelineClient({ initialReleases, projects, versions }: Props) {
  const [releases, setReleases] = useState(initialReleases)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ title: '', release_date: '', project_id: '', final_version_id: '', genre: '', label: '', isrc: '', notes: '' })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  function setField(field: string, value: string) {
    setForm(prev => {
      const next = { ...prev, [field]: value }
      // Clear the picked version whenever the project changes.
      if (field === 'project_id') next.final_version_id = ''
      return next
    })
  }

  // Only show the versions belonging to the currently-selected project.
  const projectVersions = form.project_id
    ? versions.filter(v => v.project_id === form.project_id)
    : []

  async function handleCreate(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setSaveError(null)
    try {
      const res = await fetch('/api/releases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: form.title,
          release_date: form.release_date || null,
          project_id: form.project_id || null,
          final_version_id: form.final_version_id || null,
          genre: form.genre || null,
          label: form.label || null,
          isrc: form.isrc || null,
          notes: form.notes || null,
        }),
      })
      const data = await res.json()
      if (res.ok) {
        setReleases(prev => [{ ...data, mb_projects: projects.find(p => p.id === data.project_id) ? { title: projects.find(p => p.id === data.project_id)!.title, artwork_url: null, finalized_artwork_url: null } : null }, ...prev])
        setShowForm(false)
        setForm({ title: '', release_date: '', project_id: '', final_version_id: '', genre: '', label: '', isrc: '', notes: '' })
      } else {
        setSaveError(data.error ?? 'Failed to create release')
      }
    } catch {
      setSaveError('Network error — please try again')
    }
    setSaving(false)
  }

  async function toggleCheck(releaseId: string, field: string, current: boolean) {
    const res = await fetch(`/api/releases/${releaseId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: !current }),
    })
    if (res.ok) {
      setReleases(prev => prev.map(r => r.id === releaseId ? { ...r, [field]: !current } : r))
    }
  }

  async function updateReleaseDate(releaseId: string, value: string) {
    const next = value || null
    setReleases(prev => prev.map(r => r.id === releaseId ? { ...r, release_date: next } : r))
    await fetch(`/api/releases/${releaseId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ release_date: next }),
    })
  }

  async function deleteRelease(id: string) {
    if (!confirm('Delete this release?')) return
    await fetch(`/api/releases/${id}`, { method: 'DELETE' })
    setReleases(prev => prev.filter(r => r.id !== id))
  }

  // Separate upcoming vs past, then order each group chronologically.
  // Upcoming: nearest first, undated releases at the end.
  // Past: most recent first, so the latest release sits at the top.
  const todayMs = new Date().setHours(0, 0, 0, 0)
  const upcoming = releases
    .filter(r => !r.release_date || new Date(r.release_date).getTime() >= todayMs)
    .sort((a, b) => {
      if (!a.release_date && !b.release_date) return 0
      if (!a.release_date) return 1
      if (!b.release_date) return -1
      return new Date(a.release_date).getTime() - new Date(b.release_date).getTime()
    })
  const past = releases
    .filter(r => r.release_date && new Date(r.release_date).getTime() < todayMs)
    .sort((a, b) => new Date(b.release_date!).getTime() - new Date(a.release_date!).getTime())

  function ReleaseCard({ release }: { release: ReleaseWithProject }) {
    const isExpanded = expandedId === release.id
    const pct = completionPercent(release)
    const countdown = daysUntil(release.release_date)

    return (
      <div className="rounded-2xl overflow-hidden" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}>
        {/* Header */}
        <div
          className="flex items-center gap-4 p-4 cursor-pointer hover:bg-[var(--surface-2)] transition-colors"
          onClick={() => setExpandedId(isExpanded ? null : release.id)}
        >
          {/* Artwork / icon */}
          <div className="relative w-12 h-12 rounded-xl overflow-hidden bg-[var(--surface-2)] flex-shrink-0">
            {displayArtworkUrl(release.mb_projects ?? {}) ? (
              <Image src={displayArtworkUrl(release.mb_projects ?? {})!} alt={release.title} fill className="object-cover" />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-[var(--text-muted)] text-lg">♪</div>
            )}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-[var(--text)] truncate">{release.title}</span>
              {release.mb_projects && (
                release.project_id
                  ? <Link href={`/projects/${release.project_id}`} onClick={e => e.stopPropagation()} className="text-xs text-[var(--text-muted)] hover:text-[var(--accent)] truncate transition-colors">← {release.mb_projects.title}</Link>
                  : <span className="text-xs text-[var(--text-muted)] truncate">← {release.mb_projects.title}</span>
              )}
            </div>
            <div className="flex items-center gap-3 mt-1 text-xs text-[var(--text-muted)]">
              {release.release_date && (
                <span>{new Date(release.release_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
              )}
              {release.label && <span>{release.label}</span>}
              {release.genre && <span>{release.genre}</span>}
            </div>
          </div>

          <div className="flex items-center gap-3 flex-shrink-0">
            {/* Countdown */}
            {countdown && (
              <span className={`text-xs px-2 py-0.5 rounded-full ${
                countdown === 'Today' ? 'text-[var(--accent)] bg-[var(--accent-dim)]' :
                countdown === 'Released' ? 'text-emerald-400 bg-emerald-400/10' :
                'text-[var(--text-muted)] bg-[var(--surface-2)]'
              }`}>
                {countdown}
              </span>
            )}

            {/* Health score */}
            <div className="flex items-center gap-1.5">
              <div className="w-16 h-1.5 bg-[var(--surface-2)] rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${pct}%`,
                    backgroundColor: pct === 100 ? '#34d399' : pct >= 50 ? '#2dd4bf' : '#555'
                  }}
                />
              </div>
              <span className="text-xs text-[var(--text-muted)]">{pct}%</span>
            </div>

            {isExpanded ? <ChevronUp size={14} className="text-[var(--text-muted)]" /> : <ChevronDown size={14} className="text-[var(--text-muted)]" />}
          </div>
        </div>

        {/* Expanded */}
        {isExpanded && (
          <div className="px-4 pb-5 pt-2 space-y-5" style={{ borderTop: '1px solid var(--border)' }}>
            {/* Release date — editable inline so undated releases can be scheduled later */}
            <div className="flex items-center gap-3">
              <label className="text-xs text-[var(--text-muted)] uppercase tracking-wider">Release Date</label>
              <input
                type="date"
                value={release.release_date ?? ''}
                onChange={e => updateReleaseDate(release.id, e.target.value)}
                className="rounded-xl px-3 py-1.5 text-sm text-[var(--text)] focus:outline-none [color-scheme:dark]"
                style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)' }}
              />
              {!release.release_date && (
                <span className="text-xs text-[var(--text-muted)]">Set a date to organize this release</span>
              )}
            </div>

            <div className="grid grid-cols-2 gap-6">
              {/* Pre-Launch checklist */}
              <div>
                <p className="text-xs text-[var(--text-muted)] mb-3 uppercase tracking-wider">Pre-Launch</p>
                <div className="space-y-2">
                  {CHECKLIST_ITEMS.map(item => (
                    <label key={item.key} className="flex items-center gap-2.5 cursor-pointer group">
                      <input
                        type="checkbox"
                        checked={!!release[item.key as keyof Release]}
                        onChange={() => toggleCheck(release.id, item.key, !!release[item.key as keyof Release])}
                        className="accent-[#2dd4bf] w-3.5 h-3.5 flex-shrink-0"
                      />
                      <span className={`text-sm transition-colors ${release[item.key as keyof Release] ? 'text-[var(--text-muted)] line-through' : 'text-[var(--text-secondary)] group-hover:text-[var(--text)]'}`}>
                        {item.label}
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Post-Launch campaign */}
              <div>
                <p className="text-xs text-[var(--text-muted)] mb-3 uppercase tracking-wider">Launch Campaign</p>
                <div className="space-y-2">
                  {POST_LAUNCH_ITEMS.map(item => (
                    <label key={item.key} className="flex items-center gap-2.5 cursor-pointer group">
                      <input
                        type="checkbox"
                        checked={!!release[item.key as keyof Release]}
                        onChange={() => toggleCheck(release.id, item.key, !!release[item.key as keyof Release])}
                        className="accent-[#2dd4bf] w-3.5 h-3.5 flex-shrink-0"
                      />
                      <span className="flex flex-col min-w-0">
                        <span className={`text-sm transition-colors ${release[item.key as keyof Release] ? 'text-[var(--text-muted)] line-through' : 'text-[var(--text-secondary)] group-hover:text-[var(--text)]'}`}>
                          {item.label}
                        </span>
                        <span className="text-[10px] text-[var(--text-muted)] opacity-50 leading-tight">{item.hint}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            {/* Notes */}
            {release.notes && (
              <div className="rounded-xl p-3" style={{ backgroundColor: 'var(--surface-2)' }}>
                <p className="text-xs text-[var(--text-muted)] mb-1">Notes</p>
                <p className="text-sm text-[var(--text-secondary)]">{release.notes}</p>
              </div>
            )}

            {/* Metadata */}
            <div className="flex gap-4 text-xs text-[var(--text-muted)]">
              {release.isrc && <span>ISRC: {release.isrc}</span>}
            </div>

            <div className="flex justify-end">
              <button
                onClick={() => deleteRelease(release.id)}
                className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-red-400 transition-colors"
              >
                <Trash2 size={12} />
                Delete release
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 pb-36 md:pb-10">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text)]">Release Pipeline</h1>
          <p className="text-[var(--text-muted)] text-sm mt-0.5">Track every step — from mix to campaign</p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-2 bg-[#2dd4bf] hover:bg-[#14b8a6] text-[#0a0a0a] text-sm font-semibold px-4 py-2.5 rounded-xl transition-colors"
        >
          <Plus size={16} />
          Add Release
        </button>
      </div>

      {/* Create form */}
      {showForm && (
        <div className="rounded-2xl p-6 mb-6" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}>
          <h2 className="text-sm font-semibold text-[var(--text)] mb-4">New Release</h2>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-[var(--text-muted)] mb-1.5">Title <span className="text-[#2dd4bf]">*</span></label>
                <input
                  type="text"
                  value={form.title}
                  onChange={e => setField('title', e.target.value)}
                  placeholder="e.g. After Dark"
                  autoFocus
                  className="w-full rounded-xl px-3 py-2 text-sm text-[var(--text)] focus:outline-none"
                  style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)' }}
                />
              </div>
              <div>
                <label className="block text-xs text-[var(--text-muted)] mb-1.5">Release Date</label>
                <input
                  type="date"
                  value={form.release_date}
                  onChange={e => setField('release_date', e.target.value)}
                  className="w-full rounded-xl px-3 py-2 text-sm text-[var(--text)] focus:outline-none [color-scheme:dark]"
                  style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)' }}
                />
              </div>
            </div>

            {/* Project + Version pickers */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-[var(--text-muted)] mb-1.5">Linked Project</label>
                <select
                  value={form.project_id}
                  onChange={e => setField('project_id', e.target.value)}
                  className="w-full rounded-xl px-3 py-2 text-sm text-[var(--text)] focus:outline-none appearance-none"
                  style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)' }}
                >
                  <option value="" style={{ backgroundColor: 'var(--surface)' }}>None</option>
                  {projects.map(p => (
                    <option key={p.id} value={p.id} style={{ backgroundColor: 'var(--surface)' }}>{p.title}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-[var(--text-muted)] mb-1.5">
                  Final Track Version
                  {!form.project_id && <span className="text-[var(--text-muted)] ml-1">(pick project first)</span>}
                </label>
                <select
                  value={form.final_version_id}
                  onChange={e => setField('final_version_id', e.target.value)}
                  disabled={!form.project_id || projectVersions.length === 0}
                  className="w-full rounded-xl px-3 py-2 text-sm text-[var(--text)] focus:outline-none appearance-none disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)' }}
                >
                  <option value="" style={{ backgroundColor: 'var(--surface)' }}>
                    {form.project_id && projectVersions.length === 0 ? 'No versions yet' : 'Latest / none'}
                  </option>
                  {projectVersions.map(v => (
                    <option key={v.id} value={v.id} style={{ backgroundColor: 'var(--surface)' }}>
                      {v.label ? v.label : `Version ${v.version_number}`} — {v.status}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-[var(--text-muted)] mb-1.5">Genre</label>
                <input
                  type="text"
                  value={form.genre}
                  onChange={e => setField('genre', e.target.value)}
                  placeholder="e.g. Afrobeats"
                  className="w-full rounded-xl px-3 py-2 text-sm text-[var(--text)] focus:outline-none"
                  style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)' }}
                />
              </div>
              <div>
                <label className="block text-xs text-[var(--text-muted)] mb-1.5">Label</label>
                <input
                  type="text"
                  value={form.label}
                  onChange={e => setField('label', e.target.value)}
                  placeholder="e.g. Independent"
                  className="w-full rounded-xl px-3 py-2 text-sm text-[var(--text)] focus:outline-none"
                  style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)' }}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-[var(--text-muted)] mb-1.5">ISRC</label>
                <input
                  type="text"
                  value={form.isrc}
                  onChange={e => setField('isrc', e.target.value)}
                  placeholder="e.g. USABC1234567"
                  className="w-full rounded-xl px-3 py-2 text-sm text-[var(--text)] focus:outline-none"
                  style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)' }}
                />
              </div>
              <div>
                <label className="block text-xs text-[var(--text-muted)] mb-1.5">Notes</label>
                <input
                  type="text"
                  value={form.notes}
                  onChange={e => setField('notes', e.target.value)}
                  placeholder="Any notes..."
                  className="w-full rounded-xl px-3 py-2 text-sm text-[var(--text)] focus:outline-none"
                  style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)' }}
                />
              </div>
            </div>

            {saveError && (
              <p className="text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded-xl px-3 py-2">{saveError}</p>
            )}
            <div className="flex gap-3">
              <button
                type="submit"
                disabled={saving || !form.title.trim()}
                className="flex-1 bg-[#2dd4bf] hover:bg-[#14b8a6] disabled:opacity-40 disabled:cursor-not-allowed text-[#0a0a0a] text-sm font-semibold rounded-xl py-2.5 transition-colors"
              >
                {saving ? 'Creating...' : 'Create Release'}
              </button>
              <button
                type="button"
                onClick={() => { setShowForm(false); setSaveError(null) }}
                className="px-5 py-2.5 text-sm text-[var(--text-muted)] hover:text-[var(--text)] rounded-xl transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Upcoming releases */}
      {upcoming.length === 0 && past.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}>
            <CalendarRange size={24} className="text-[var(--text-muted)]" />
          </div>
          <p className="text-[var(--text-muted)] mb-4">No releases planned yet</p>
          <button
            onClick={() => setShowForm(true)}
            className="flex items-center gap-2 text-[#2dd4bf] text-sm hover:text-[#14b8a6] transition-colors"
          >
            <Plus size={14} />
            Add your first release
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          {upcoming.length > 0 && (
            <div>
              <h2 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3">Upcoming</h2>
              <div className="space-y-3">
                {upcoming.map(r => <ReleaseCard key={r.id} release={r} />)}
              </div>
            </div>
          )}
          {past.length > 0 && (
            <div>
              <h2 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3">Past</h2>
              <div className="space-y-3 opacity-60">
                {past.map(r => <ReleaseCard key={r.id} release={r} />)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
