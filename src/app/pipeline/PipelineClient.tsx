'use client'

import { useState } from 'react'
import Image from 'next/image'
import { Plus, ChevronDown, ChevronUp, Trash2, CalendarRange, Terminal, RefreshCw } from 'lucide-react'
import type { Release } from '@/lib/supabase'

type ReleaseWithProject = Release & {
  mf_projects: { title: string; artwork_url: string | null } | null
  mf_versions?: { id: string; version_number: number; label: string | null; audio_url: string; status: string }[]
}

type Props = {
  initialReleases: ReleaseWithProject[]
  projects: { id: string; title: string }[]
}

const CHECKLIST_ITEMS = [
  { key: 'mixing_done', label: 'Mixing done' },
  { key: 'mastering_done', label: 'Mastering done' },
  { key: 'artwork_ready', label: 'Artwork ready' },
  { key: 'dsp_submitted', label: 'DSP submitted' },
  { key: 'social_posts_done', label: 'Social posts scheduled' },
  { key: 'press_release_done', label: 'Press release done' },
] as const

const DSP_PLATFORMS = [
  { key: 'dsp_spotify', label: 'Spotify' },
  { key: 'dsp_apple_music', label: 'Apple Music' },
  { key: 'dsp_tidal', label: 'Tidal' },
  { key: 'dsp_bandcamp', label: 'Bandcamp' },
  { key: 'dsp_soundcloud', label: 'SoundCloud' },
  { key: 'dsp_youtube', label: 'YouTube' },
  { key: 'dsp_amazon', label: 'Amazon Music' },
] as const

const DK_STATUS_LABEL: Record<string, { label: string; color: string }> = {
  not_started: { label: 'Not started', color: 'text-[#555]' },
  uploading:   { label: 'Uploading…',  color: 'text-yellow-400' },
  submitted:   { label: 'Submitted',   color: 'text-emerald-400' },
  error:       { label: 'Error',       color: 'text-red-400' },
}

function completionPercent(release: Release): number {
  const checks = CHECKLIST_ITEMS.filter(c => release[c.key]).length
  return Math.round((checks / CHECKLIST_ITEMS.length) * 100)
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

const GENRES = [
  'Alternative', 'Ambient', 'Afrobeats', 'Blues', 'Classical', 'Country', 'Dance',
  'Electronic', 'Folk', 'Hip-Hop/Rap', 'House', 'Indie', 'Jazz', 'Latin', 'Metal',
  'Pop', 'R&B/Soul', 'Reggae', 'Rock', 'Techno', 'Trap', 'World',
]

export default function PipelineClient({ initialReleases, projects }: Props) {
  const [releases, setReleases] = useState(initialReleases)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<Record<string, 'setup' | 'checklist' | 'log'>>({})
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ title: '', release_date: '', project_id: '', genre: '', label: '', isrc: '', notes: '' })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [setupSaving, setSetupSaving] = useState<Record<string, boolean>>({})

  function getTab(id: string) { return activeTab[id] ?? 'setup' }
  function setTab(id: string, tab: 'setup' | 'checklist' | 'log') {
    setActiveTab(prev => ({ ...prev, [id]: tab }))
  }

  function setField(field: string, value: string) {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  async function handleCreate(e: React.FormEvent) {
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
          genre: form.genre || null,
          label: form.label || null,
          isrc: form.isrc || null,
          notes: form.notes || null,
        }),
      })
      const data = await res.json()
      if (res.ok) {
        const proj = projects.find(p => p.id === data.project_id)
        setReleases(prev => [{ ...data, mf_projects: proj ? { title: proj.title, artwork_url: null } : null, mf_versions: [] }, ...prev])
        setShowForm(false)
        setForm({ title: '', release_date: '', project_id: '', genre: '', label: '', isrc: '', notes: '' })
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

  async function saveSetup(releaseId: string, fields: Partial<Release>) {
    setSetupSaving(prev => ({ ...prev, [releaseId]: true }))
    const res = await fetch(`/api/releases/${releaseId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    })
    if (res.ok) {
      const updated = await res.json()
      setReleases(prev => prev.map(r => r.id === releaseId ? { ...r, ...updated } : r))
    }
    setSetupSaving(prev => ({ ...prev, [releaseId]: false }))
  }

  async function refreshLog(releaseId: string) {
    const res = await fetch(`/api/releases/${releaseId}`)
    if (res.ok) {
      const data = await res.json()
      setReleases(prev => prev.map(r => r.id === releaseId ? { ...r, agent_log: data.agent_log, distrokid_status: data.distrokid_status } : r))
    }
  }

  async function deleteRelease(id: string) {
    if (!confirm('Delete this release?')) return
    await fetch(`/api/releases/${id}`, { method: 'DELETE' })
    setReleases(prev => prev.filter(r => r.id !== id))
  }

  const upcoming = releases.filter(r => !r.release_date || new Date(r.release_date) >= new Date())
  const past = releases.filter(r => r.release_date && new Date(r.release_date) < new Date())

  function ReleaseCard({ release }: { release: ReleaseWithProject }) {
    const isExpanded = expandedId === release.id
    const pct = completionPercent(release)
    const countdown = daysUntil(release.release_date)
    const tab = getTab(release.id)
    const dkStatus = DK_STATUS_LABEL[release.distrokid_status ?? 'not_started']
    const versions = release.mf_versions ?? []

    // Local editable setup state (flushed on blur)
    const [setup, setSetup] = useState({
      artist_name: release.artist_name ?? '',
      featured_artists: release.featured_artists ?? '',
      release_type: release.release_type ?? 'single',
      genre: release.genre ?? '',
      secondary_genre: release.secondary_genre ?? '',
      explicit: release.explicit ?? false,
      isrc: release.isrc ?? '',
      upc: release.upc ?? '',
      songwriter_name: release.songwriter_name ?? '',
      producer_name: release.producer_name ?? '',
      label: release.label ?? '',
      notes: release.notes ?? '',
      final_version_id: release.final_version_id ?? '',
      spotify_pitch_copy: release.spotify_pitch_copy ?? '',
    })

    function flush(field: string, value: unknown) {
      saveSetup(release.id, { [field]: value || null } as Partial<Release>)
    }

    return (
      <div className="bg-[#111] border border-[#1a1a1a] rounded-2xl overflow-hidden">
        {/* Header */}
        <div
          className="flex items-center gap-4 p-4 cursor-pointer hover:bg-[#141414] transition-colors"
          onClick={() => setExpandedId(isExpanded ? null : release.id)}
        >
          <div className="relative w-12 h-12 rounded-xl overflow-hidden bg-[#1a1a1a] flex-shrink-0">
            {release.mf_projects?.artwork_url ? (
              <Image src={release.mf_projects.artwork_url} alt={release.title} fill className="object-cover" />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-[#333] text-lg">♪</div>
            )}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-white truncate">{release.title}</span>
              {release.mf_projects && (
                <span className="text-xs text-[#444] truncate">← {release.mf_projects.title}</span>
              )}
            </div>
            <div className="flex items-center gap-3 mt-1 text-xs text-[#444]">
              {release.release_date && (
                <span>{new Date(release.release_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
              )}
              {release.label && <span>{release.label}</span>}
              {release.genre && <span>{release.genre}</span>}
              <span className={dkStatus.color}>DistroKid: {dkStatus.label}</span>
            </div>
          </div>

          <div className="flex items-center gap-3 flex-shrink-0">
            {countdown && (
              <span className={`text-xs px-2 py-0.5 rounded-full ${
                countdown === 'Today' ? 'text-[#a78bfa] bg-[#a78bfa]/10' :
                countdown === 'Released' ? 'text-emerald-400 bg-emerald-400/10' :
                'text-[#555] bg-[#1a1a1a]'
              }`}>
                {countdown}
              </span>
            )}
            <div className="flex items-center gap-1.5">
              <div className="w-16 h-1.5 bg-[#1a1a1a] rounded-full overflow-hidden">
                <div className="h-full rounded-full transition-all" style={{
                  width: `${pct}%`,
                  backgroundColor: pct === 100 ? '#34d399' : pct >= 50 ? '#a78bfa' : '#555'
                }} />
              </div>
              <span className="text-xs text-[#444]">{pct}%</span>
            </div>
            {isExpanded ? <ChevronUp size={14} className="text-[#444]" /> : <ChevronDown size={14} className="text-[#444]" />}
          </div>
        </div>

        {/* Expanded */}
        {isExpanded && (
          <div className="border-t border-[#1a1a1a]">
            {/* Tabs */}
            <div className="flex border-b border-[#1a1a1a]">
              {(['setup', 'checklist', 'log'] as const).map(t => (
                <button
                  key={t}
                  onClick={() => setTab(release.id, t)}
                  className={`px-4 py-2.5 text-xs font-medium capitalize transition-colors ${
                    tab === t ? 'text-white border-b-2 border-[#a78bfa] -mb-px' : 'text-[#555] hover:text-[#888]'
                  }`}
                >
                  {t === 'log' ? 'Agent Log' : t === 'setup' ? 'Release Setup' : 'Checklist'}
                </button>
              ))}
            </div>

            {/* Setup tab */}
            {tab === 'setup' && (
              <div className="p-5 space-y-5">

                {/* Agent launch */}
                <div className="bg-[#0a0a0a] border border-[#1e1e1e] rounded-xl p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <p className="text-sm font-semibold text-white">Release Agent</p>
                      <p className="text-xs text-[#555] mt-0.5">Automates DistroKid upload + Spotify pitch on your Mac</p>
                    </div>
                    <span className={`text-xs px-2 py-1 rounded-full bg-[#1a1a1a] ${dkStatus.color}`}>
                      {dkStatus.label}
                    </span>
                  </div>
                  <div className="bg-[#0f0f0f] border border-[#1a1a1a] rounded-xl px-4 py-3 font-mono text-xs text-[#a78bfa] mb-3">
                    <span className="text-[#555]"># Run this on your Mac once setup is complete</span><br />
                    <span className="text-emerald-400">cd</span> mixfolio/agent<br />
                    <span className="text-emerald-400">python</span> release_agent.py {release.id}
                  </div>
                  <p className="text-[10px] text-[#444]">
                    Requires: Python 3.11+, cliclick (<code className="text-[#666]">brew install cliclick</code>), credentials in <code className="text-[#666]">agent/.env</code>
                  </p>
                </div>

                {/* Core metadata */}
                <div>
                  <p className="text-xs text-[#555] mb-3 uppercase tracking-wider">Metadata</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-[#666] mb-1.5">Artist name <span className="text-[#a78bfa]">*</span></label>
                      <input
                        value={setup.artist_name}
                        onChange={e => setSetup(p => ({ ...p, artist_name: e.target.value }))}
                        onBlur={e => flush('artist_name', e.target.value)}
                        placeholder="Your artist name"
                        className="w-full bg-[#0f0f0f] border border-[#222] rounded-xl px-3 py-2 text-sm text-white placeholder-[#333] focus:outline-none focus:border-[#a78bfa]/40"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-[#666] mb-1.5">Featured artists</label>
                      <input
                        value={setup.featured_artists}
                        onChange={e => setSetup(p => ({ ...p, featured_artists: e.target.value }))}
                        onBlur={e => flush('featured_artists', e.target.value)}
                        placeholder="e.g. Artist A, Artist B"
                        className="w-full bg-[#0f0f0f] border border-[#222] rounded-xl px-3 py-2 text-sm text-white placeholder-[#333] focus:outline-none focus:border-[#a78bfa]/40"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-[#666] mb-1.5">Release type</label>
                      <select
                        value={setup.release_type}
                        onChange={e => { setSetup(p => ({ ...p, release_type: e.target.value as 'single' | 'album' | 'ep' })); flush('release_type', e.target.value) }}
                        className="w-full bg-[#0f0f0f] border border-[#222] rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-[#a78bfa]/40 appearance-none"
                      >
                        <option value="single">Single</option>
                        <option value="ep">EP</option>
                        <option value="album">Album</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-[#666] mb-1.5">Primary genre</label>
                      <select
                        value={setup.genre}
                        onChange={e => { setSetup(p => ({ ...p, genre: e.target.value })); flush('genre', e.target.value) }}
                        className="w-full bg-[#0f0f0f] border border-[#222] rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-[#a78bfa]/40 appearance-none"
                      >
                        <option value="">Select genre</option>
                        {GENRES.map(g => <option key={g} value={g}>{g}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-[#666] mb-1.5">Secondary genre</label>
                      <select
                        value={setup.secondary_genre}
                        onChange={e => { setSetup(p => ({ ...p, secondary_genre: e.target.value })); flush('secondary_genre', e.target.value) }}
                        className="w-full bg-[#0f0f0f] border border-[#222] rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-[#a78bfa]/40 appearance-none"
                      >
                        <option value="">None</option>
                        {GENRES.map(g => <option key={g} value={g}>{g}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-[#666] mb-1.5">Label</label>
                      <input
                        value={setup.label}
                        onChange={e => setSetup(p => ({ ...p, label: e.target.value }))}
                        onBlur={e => flush('label', e.target.value)}
                        placeholder="e.g. Independent"
                        className="w-full bg-[#0f0f0f] border border-[#222] rounded-xl px-3 py-2 text-sm text-white placeholder-[#333] focus:outline-none focus:border-[#a78bfa]/40"
                      />
                    </div>
                  </div>

                  <div className="mt-3 flex items-center gap-2">
                    <input
                      type="checkbox"
                      id={`explicit-${release.id}`}
                      checked={setup.explicit}
                      onChange={e => { setSetup(p => ({ ...p, explicit: e.target.checked })); flush('explicit', e.target.checked) }}
                      className="accent-[#a78bfa]"
                    />
                    <label htmlFor={`explicit-${release.id}`} className="text-xs text-[#666]">Explicit content</label>
                  </div>
                </div>

                {/* Credits */}
                <div>
                  <p className="text-xs text-[#555] mb-3 uppercase tracking-wider">Credits</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-[#666] mb-1.5">Songwriter</label>
                      <input
                        value={setup.songwriter_name}
                        onChange={e => setSetup(p => ({ ...p, songwriter_name: e.target.value }))}
                        onBlur={e => flush('songwriter_name', e.target.value)}
                        placeholder="Legal name"
                        className="w-full bg-[#0f0f0f] border border-[#222] rounded-xl px-3 py-2 text-sm text-white placeholder-[#333] focus:outline-none focus:border-[#a78bfa]/40"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-[#666] mb-1.5">Producer</label>
                      <input
                        value={setup.producer_name}
                        onChange={e => setSetup(p => ({ ...p, producer_name: e.target.value }))}
                        onBlur={e => flush('producer_name', e.target.value)}
                        placeholder="Producer name"
                        className="w-full bg-[#0f0f0f] border border-[#222] rounded-xl px-3 py-2 text-sm text-white placeholder-[#333] focus:outline-none focus:border-[#a78bfa]/40"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-[#666] mb-1.5">ISRC</label>
                      <input
                        value={setup.isrc}
                        onChange={e => setSetup(p => ({ ...p, isrc: e.target.value }))}
                        onBlur={e => flush('isrc', e.target.value)}
                        placeholder="Auto-assigned if blank"
                        className="w-full bg-[#0f0f0f] border border-[#222] rounded-xl px-3 py-2 text-sm text-white placeholder-[#333] focus:outline-none focus:border-[#a78bfa]/40"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-[#666] mb-1.5">UPC</label>
                      <input
                        value={setup.upc}
                        onChange={e => setSetup(p => ({ ...p, upc: e.target.value }))}
                        onBlur={e => flush('upc', e.target.value)}
                        placeholder="Auto-assigned if blank"
                        className="w-full bg-[#0f0f0f] border border-[#222] rounded-xl px-3 py-2 text-sm text-white placeholder-[#333] focus:outline-none focus:border-[#a78bfa]/40"
                      />
                    </div>
                  </div>
                </div>

                {/* Final version selector */}
                {versions.length > 0 && (
                  <div>
                    <p className="text-xs text-[#555] mb-3 uppercase tracking-wider">Audio</p>
                    <div>
                      <label className="block text-xs text-[#666] mb-1.5">Final version to release</label>
                      <select
                        value={setup.final_version_id}
                        onChange={e => { setSetup(p => ({ ...p, final_version_id: e.target.value })); flush('final_version_id', e.target.value) }}
                        className="w-full bg-[#0f0f0f] border border-[#222] rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-[#a78bfa]/40 appearance-none"
                      >
                        <option value="">Latest version</option>
                        {versions.map(v => (
                          <option key={v.id} value={v.id}>
                            v{v.version_number}{v.label ? ` — ${v.label}` : ''} ({v.status})
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}

                {/* Spotify pitch copy */}
                <div>
                  <p className="text-xs text-[#555] mb-3 uppercase tracking-wider">Spotify Pitch</p>
                  <textarea
                    value={setup.spotify_pitch_copy}
                    onChange={e => setSetup(p => ({ ...p, spotify_pitch_copy: e.target.value }))}
                    onBlur={e => flush('spotify_pitch_copy', e.target.value)}
                    rows={4}
                    placeholder="Write your Spotify editorial pitch here. Describe the song's sound, mood, influences, and why it should be playlisted..."
                    className="w-full bg-[#0f0f0f] border border-[#222] rounded-xl px-3 py-2 text-sm text-white placeholder-[#333] focus:outline-none focus:border-[#a78bfa]/40 resize-none"
                  />
                  <p className="text-[10px] text-[#444] mt-1">The agent will use this when submitting your Spotify for Artists pitch.</p>
                </div>

                {setupSaving[release.id] && (
                  <p className="text-xs text-[#555]">Saving…</p>
                )}
              </div>
            )}

            {/* Checklist tab */}
            {tab === 'checklist' && (
              <div className="p-5">
                <div className="grid grid-cols-2 gap-6">
                  <div>
                    <p className="text-xs text-[#555] mb-3 uppercase tracking-wider">Pre-release checklist</p>
                    <div className="space-y-2">
                      {CHECKLIST_ITEMS.map(item => (
                        <label key={item.key} className="flex items-center gap-2.5 cursor-pointer group">
                          <input
                            type="checkbox"
                            checked={release[item.key]}
                            onChange={() => toggleCheck(release.id, item.key, release[item.key])}
                            className="accent-[#a78bfa] w-3.5 h-3.5"
                          />
                          <span className={`text-sm transition-colors ${release[item.key] ? 'text-[#555] line-through' : 'text-[#888] group-hover:text-white'}`}>
                            {item.label}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="text-xs text-[#555] mb-3 uppercase tracking-wider">Distribution</p>
                    <div className="space-y-2">
                      {DSP_PLATFORMS.map(dsp => (
                        <label key={dsp.key} className="flex items-center gap-2.5 cursor-pointer group">
                          <input
                            type="checkbox"
                            checked={release[dsp.key]}
                            onChange={() => toggleCheck(release.id, dsp.key, release[dsp.key])}
                            className="accent-[#a78bfa] w-3.5 h-3.5"
                          />
                          <span className={`text-sm transition-colors ${release[dsp.key] ? 'text-[#555] line-through' : 'text-[#888] group-hover:text-white'}`}>
                            {dsp.label}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Agent log tab */}
            {tab === 'log' && (
              <div className="p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Terminal size={13} className="text-[#555]" />
                    <p className="text-xs text-[#555] uppercase tracking-wider">Agent Log</p>
                  </div>
                  <button
                    onClick={() => refreshLog(release.id)}
                    className="flex items-center gap-1.5 text-xs text-[#444] hover:text-white transition-colors"
                  >
                    <RefreshCw size={11} />
                    Refresh
                  </button>
                </div>
                {release.agent_log ? (
                  <pre className="bg-[#0a0a0a] border border-[#1a1a1a] rounded-xl p-4 text-xs text-[#888] font-mono whitespace-pre-wrap overflow-auto max-h-64">
                    {release.agent_log}
                  </pre>
                ) : (
                  <div className="bg-[#0a0a0a] border border-[#1a1a1a] rounded-xl p-4 text-xs text-[#444] font-mono">
                    No agent activity yet. Run the agent script to start.
                  </div>
                )}
              </div>
            )}

            <div className="px-5 pb-4 flex justify-end">
              <button
                onClick={() => deleteRelease(release.id)}
                className="flex items-center gap-1.5 text-xs text-[#333] hover:text-red-400 transition-colors"
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
    <div className="max-w-4xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">Release Pipeline</h1>
          <p className="text-[#555] text-sm mt-0.5">Plan, configure, and automate your releases</p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-2 bg-[#a78bfa] hover:bg-[#9370f0] text-white text-sm font-semibold px-4 py-2.5 rounded-xl transition-colors"
        >
          <Plus size={16} />
          Add Release
        </button>
      </div>

      {/* Create form */}
      {showForm && (
        <div className="bg-[#111] border border-[#1e1e1e] rounded-2xl p-6 mb-6">
          <h2 className="text-sm font-semibold text-white mb-4">New Release</h2>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-[#666] mb-1.5">Title <span className="text-[#a78bfa]">*</span></label>
                <input
                  type="text"
                  value={form.title}
                  onChange={e => setField('title', e.target.value)}
                  placeholder="e.g. After Dark"
                  autoFocus
                  className="w-full bg-[#0f0f0f] border border-[#222] rounded-xl px-3 py-2 text-sm text-white placeholder-[#333] focus:outline-none focus:border-[#a78bfa]/40"
                />
              </div>
              <div>
                <label className="block text-xs text-[#666] mb-1.5">Release Date</label>
                <input
                  type="date"
                  value={form.release_date}
                  onChange={e => setField('release_date', e.target.value)}
                  className="w-full bg-[#0f0f0f] border border-[#222] rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-[#a78bfa]/40 [color-scheme:dark]"
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-xs text-[#666] mb-1.5">Linked Project</label>
                <select
                  value={form.project_id}
                  onChange={e => setField('project_id', e.target.value)}
                  className="w-full bg-[#0f0f0f] border border-[#222] rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-[#a78bfa]/40 appearance-none"
                >
                  <option value="" className="bg-[#111]">None</option>
                  {projects.map(p => (
                    <option key={p.id} value={p.id} className="bg-[#111]">{p.title}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-[#666] mb-1.5">Genre</label>
                <input type="text" value={form.genre} onChange={e => setField('genre', e.target.value)}
                  placeholder="e.g. Afrobeats"
                  className="w-full bg-[#0f0f0f] border border-[#222] rounded-xl px-3 py-2 text-sm text-white placeholder-[#333] focus:outline-none focus:border-[#a78bfa]/40" />
              </div>
              <div>
                <label className="block text-xs text-[#666] mb-1.5">Label</label>
                <input type="text" value={form.label} onChange={e => setField('label', e.target.value)}
                  placeholder="e.g. Independent"
                  className="w-full bg-[#0f0f0f] border border-[#222] rounded-xl px-3 py-2 text-sm text-white placeholder-[#333] focus:outline-none focus:border-[#a78bfa]/40" />
              </div>
            </div>
            {saveError && (
              <p className="text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded-xl px-3 py-2">{saveError}</p>
            )}
            <div className="flex gap-3">
              <button type="submit" disabled={saving || !form.title.trim()}
                className="flex-1 bg-[#a78bfa] hover:bg-[#9370f0] disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-xl py-2.5 transition-colors">
                {saving ? 'Creating...' : 'Create Release'}
              </button>
              <button type="button" onClick={() => { setShowForm(false); setSaveError(null) }}
                className="px-5 py-2.5 text-sm text-[#555] hover:text-white rounded-xl transition-colors">
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {upcoming.length === 0 && past.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="w-16 h-16 rounded-2xl bg-[#111] border border-[#1e1e1e] flex items-center justify-center mb-4">
            <CalendarRange size={24} className="text-[#333]" />
          </div>
          <p className="text-[#555] mb-4">No releases planned yet</p>
          <button onClick={() => setShowForm(true)}
            className="flex items-center gap-2 text-[#a78bfa] text-sm hover:text-[#9370f0] transition-colors">
            <Plus size={14} />
            Add your first release
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          {upcoming.length > 0 && (
            <div>
              <h2 className="text-xs font-semibold text-[#444] uppercase tracking-wider mb-3">Upcoming</h2>
              <div className="space-y-3">
                {upcoming.map(r => <ReleaseCard key={r.id} release={r} />)}
              </div>
            </div>
          )}
          {past.length > 0 && (
            <div>
              <h2 className="text-xs font-semibold text-[#333] uppercase tracking-wider mb-3">Past</h2>
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
