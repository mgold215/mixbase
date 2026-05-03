'use client'

import { useState, useRef, type ChangeEvent } from 'react'
import { usePlayer } from '@/contexts/PlayerContext'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { StatusBadge, StatusPipeline } from '@/components/StatusBadge'
import ArtworkGenerator from '@/components/ArtworkGenerator'
import { formatDuration, formatFileSize, STATUSES, STATUS_CONFIG, audioProxyUrl, type Project, type Version, type Feedback } from '@/lib/supabase'
import { analyzeFile } from '@/lib/audio-analysis'
import {
  ArrowLeft, Plus, Share2, Check, ChevronDown, ChevronUp,
  MessageSquare, Star, Trash2, Music, Upload, Pencil,
  CalendarRange, ExternalLink, Play, Pause, Download
} from 'lucide-react'
import AddToCollectionButton from '@/components/AddToCollectionButton'
import type { Release } from '@/lib/supabase'

const CHECKLIST_ITEMS = [
  { key: 'mixing_done' as const,       label: 'Mixing done' },
  { key: 'mastering_done' as const,    label: 'Mastering done' },
  { key: 'artwork_ready' as const,     label: 'Artwork ready' },
  { key: 'dsp_submitted' as const,     label: 'DSP submitted' },
  { key: 'social_posts_done' as const, label: 'Social posts scheduled' },
  { key: 'press_release_done' as const,label: 'Press release done' },
]

const Visualizer = dynamic(() => import('@/components/Visualizer'), { ssr: false })

type VersionWithFeedback = Version & { mb_feedback: Feedback[] }

type Props = {
  project: Project
  initialVersions: VersionWithFeedback[]
  initialRelease: Release | null
}

export default function ProjectClient({ project, initialVersions, initialRelease }: Props) {
  const [versions, setVersions] = useState(initialVersions)
  const [artwork, setArtwork] = useState(project.artwork_url)
  const [expandedVersion, setExpandedVersion] = useState<string | null>(versions[0]?.id ?? null)
  const [copiedToken, setCopiedToken] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadPct, setUploadPct] = useState(0)
  const [uploadStatus, setUploadStatus] = useState('')
  const [savedNoteKey, setSavedNoteKey] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [editingProject, setEditingProject] = useState(false)
  const [projectForm, setProjectForm] = useState({
    title: project.title,
    genre: project.genre ?? '',
    bpm: project.bpm?.toString() ?? '',
    key_signature: project.key_signature ?? '',
  })
  const [projectSaved, setProjectSaved] = useState(false)
  const [release, setRelease] = useState<Release | null>(initialRelease)
  const [startingRelease, setStartingRelease] = useState(false)

  const { playUrl, currentUrl, currentTime, duration, isPlaying, seek, togglePlay } = usePlayer()

  // Tab state — persists in URL hash
  const [activeTab, setActiveTab] = useState<'versions' | 'artwork' | 'visualizer'>(() => {
    if (typeof window === 'undefined') return 'versions'
    const hash = window.location.hash.replace('#', '')
    if (hash === 'artwork' || hash === 'visualizer') return hash
    return 'versions'
  })

  function switchTab(tab: 'versions' | 'artwork' | 'visualizer') {
    setActiveTab(tab)
    if (typeof window !== 'undefined') {
      history.replaceState(null, '', `#${tab}`)
    }
  }

  const projectStatus = versions.reduce((best, v) => {
    const current = STATUS_CONFIG[best as keyof typeof STATUS_CONFIG]?.step ?? 0
    const candidate = STATUS_CONFIG[v.status as keyof typeof STATUS_CONFIG]?.step ?? 0
    return candidate > current ? v.status : best
  }, 'WIP' as string)

  function copyShareLink(token: string) {
    const url = `${window.location.origin}/share/${token}`
    navigator.clipboard.writeText(url)
    setCopiedToken(token)
    setTimeout(() => setCopiedToken(null), 2000)
  }

  async function updateStatus(versionId: string, newStatus: Version['status']) {
    const res = await fetch(`/api/versions/${versionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    })
    if (res.ok) {
      setVersions(prev => prev.map(v => v.id === versionId ? { ...v, status: newStatus } : v))
    }
  }

  async function updateNotes(versionId: string, field: 'private_notes' | 'public_notes', value: string) {
    const res = await fetch(`/api/versions/${versionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: value }),
    })
    if (res.ok) {
      const key = `${versionId}-${field}`
      setSavedNoteKey(key)
      setTimeout(() => setSavedNoteKey(null), 2000)
    }
  }

  function parseMixLabel(filename: string): string | null {
    const nameWithoutExt = filename.replace(/\.[^.]+$/, '')
    const match = nameWithoutExt.match(/mix\s+[\d]+(?:\.[\d]+)*/i)
    return match ? match[0].toUpperCase().replace(/\s+/, ' ') : null
  }

  async function handleFileSelect(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (fileInputRef.current) fileInputRef.current.value = ''

    // Detect BPM/key in background — only fill in fields the user hasn't set manually
    analyzeFile(file).then(result => {
      if (result) {
        setProjectForm(p => ({
          ...p,
          bpm: p.bpm || result.bpm.toString(),
          key_signature: p.key_signature || result.key,
        }))
      }
    })

    await handleUpload(file)
  }

  async function handleUpload(file: File) {
    if (file.size > 2 * 1024 * 1024 * 1024) {
      setUploadStatus('Error: File too large (max 2GB)')
      return
    }
    setUploading(true)
    setUploadPct(0)
    setUploadStatus('Uploading...')

    const ext = file.name.split('.').pop()
    const filename = `${project.id}/${Date.now()}.${ext}`

    const mimeByExt: Record<string, string> = {
      wav: 'audio/wav', wave: 'audio/wav', aif: 'audio/aiff', aiff: 'audio/aiff',
      mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', ogg: 'audio/ogg',
    }
    const fileExt = (file.name.split('.').pop() ?? '').toLowerCase()
    const contentType = file.type || mimeByExt[fileExt] || 'application/octet-stream'

    const urlRes = await fetch('/api/upload-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, contentType }),
    })
    const urlData = await urlRes.json()
    if (!urlRes.ok) {
      setUploadStatus(`Error: ${urlData.error ?? 'Could not get upload URL'}`)
      setUploadPct(0)
      setUploading(false)
      return
    }

    const putResult = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const xhr = new XMLHttpRequest()
      xhr.upload.addEventListener('progress', (ev) => {
        if (ev.lengthComputable) setUploadPct(Math.round((ev.loaded / ev.total) * 80))
      })
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve({ ok: true })
        else resolve({ ok: false, error: xhr.responseText || `HTTP ${xhr.status}` })
      })
      xhr.addEventListener('error', () => resolve({ ok: false, error: 'Network error' }))
      xhr.open('PUT', urlData.signedUrl)
      xhr.setRequestHeader('Content-Type', contentType)
      xhr.setRequestHeader('x-upsert', 'true')
      xhr.send(file)
    })

    if (!putResult.ok) {
      setUploadStatus(`Error: ${putResult.error ?? 'Upload failed'}`)
      setUploadPct(0)
      setUploading(false)
      return
    }

    const audioUrl = urlData.publicUrl as string

    setUploadPct(85)
    setUploadStatus('Reading metadata...')

    let duration: number | null = null
    try {
      duration = await new Promise((resolve) => {
        const audio = new Audio(audioProxyUrl(audioUrl))
        audio.addEventListener('loadedmetadata', () => resolve(Math.round(audio.duration)))
        audio.addEventListener('error', () => resolve(null))
        setTimeout(() => resolve(null), 8000)
      })
    } catch {
      duration = null
    }

    setUploadPct(92)
    setUploadStatus('Saving mix...')

    const versionRes = await fetch('/api/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: project.id,
        audio_url: audioUrl,
        audio_filename: file.name,
        duration_seconds: duration,
        file_size_bytes: file.size,
        label: parseMixLabel(file.name),
      }),
    })

    const newVersion = await versionRes.json()
    if (versionRes.ok) {
      setUploadPct(100)
      setUploadStatus('Done!')
      setTimeout(() => {
        setVersions(prev => [{ ...newVersion, mb_feedback: [] }, ...prev])
        setExpandedVersion(newVersion.id)
        setUploadPct(0)
        setUploadStatus('')
        setUploading(false)
      }, 600)
    } else {
      setUploadStatus(`Error: ${newVersion.error ?? 'Unknown error'}`)
      setUploadPct(0)
      setUploading(false)
    }
  }

  async function deleteVersion(versionId: string) {
    if (!confirm('Delete this mix? This cannot be undone.')) return
    const res = await fetch(`/api/versions/${versionId}`, { method: 'DELETE' })
    if (res.ok) setVersions(prev => prev.filter(v => v.id !== versionId))
  }

  async function saveProject() {
    const res = await fetch(`/api/projects/${project.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: projectForm.title.trim() || project.title,
        genre: projectForm.genre.trim() || null,
        bpm: projectForm.bpm ? parseInt(projectForm.bpm) : null,
        key_signature: projectForm.key_signature.trim() || null,
      }),
    })
    if (res.ok) {
      setProjectSaved(true)
      setEditingProject(false)
      setTimeout(() => setProjectSaved(false), 2000)
    }
  }

  async function startRelease() {
    setStartingRelease(true)
    const res = await fetch('/api/releases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: projectForm.title || project.title, project_id: project.id }),
    })
    if (res.ok) {
      const data = await res.json()
      setRelease(data)
    }
    setStartingRelease(false)
  }

  async function toggleReleaseCheck(field: string, current: boolean) {
    if (!release) return
    const res = await fetch(`/api/releases/${release.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: !current }),
    })
    if (res.ok) {
      setRelease(prev => prev ? { ...prev, [field]: !current } : prev)
    }
  }

  const releaseProgress = release
    ? Math.round((CHECKLIST_ITEMS.filter(c => release[c.key]).length / CHECKLIST_ITEMS.length) * 100)
    : 0

  return (
    <div className="pt-14">
      <div className="max-w-4xl mx-auto px-6 py-8 pb-36 md:pb-10">
        <Link href="/dashboard" className="flex items-center gap-2 text-[var(--text-muted)] hover:text-[var(--text)] text-sm mb-6 transition-colors w-fit">
          <ArrowLeft size={14} />
          Dashboard
        </Link>

        {/* Project header */}
        <div className="flex gap-6 mb-8">
          <div className="flex-shrink-0 w-32">
            <ArtworkGenerator
              projectId={project.id}
              projectTitle={project.title}
              genre={project.genre}
              currentArtwork={artwork}
              onArtworkUpdated={setArtwork}
            />
          </div>

          <div className="flex-1 min-w-0 pt-1">
            {editingProject ? (
              <div className="space-y-3 mb-4">
                <input
                  type="text"
                  value={projectForm.title}
                  onChange={e => setProjectForm(p => ({ ...p, title: e.target.value }))}
                  className="w-full bg-[var(--input-bg)] border border-[#2dd4bf]/30 rounded-xl px-3 py-2 text-lg font-bold text-[var(--text)] focus:outline-none focus:border-[#2dd4bf]/60"
                />
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="block text-[10px] text-[var(--text-muted)] mb-1">Genre</label>
                    <input type="text" value={projectForm.genre} onChange={e => setProjectForm(p => ({ ...p, genre: e.target.value }))} placeholder="e.g. Techno" className="w-full bg-[var(--input-bg)] rounded-lg px-2 py-1.5 text-xs text-[var(--text)] focus:outline-none" style={{ border: '1px solid var(--border)' }} />
                  </div>
                  <div>
                    <label className="block text-[10px] text-[var(--text-muted)] mb-1">BPM</label>
                    <input type="number" value={projectForm.bpm} onChange={e => setProjectForm(p => ({ ...p, bpm: e.target.value }))} placeholder="e.g. 140" className="w-full bg-[var(--input-bg)] rounded-lg px-2 py-1.5 text-xs text-[var(--text)] focus:outline-none" style={{ border: '1px solid var(--border)' }} />
                  </div>
                  <div>
                    <label className="block text-[10px] text-[var(--text-muted)] mb-1">Key</label>
                    <input type="text" value={projectForm.key_signature} onChange={e => setProjectForm(p => ({ ...p, key_signature: e.target.value }))} placeholder="e.g. Am" className="w-full bg-[var(--input-bg)] rounded-lg px-2 py-1.5 text-xs text-[var(--text)] focus:outline-none" style={{ border: '1px solid var(--border)' }} />
                  </div>
                </div>
                <div className="flex gap-2">
                  <button onClick={saveProject} className="bg-[#2dd4bf] hover:bg-[#14b8a6] text-[#0a0a0a] text-xs font-semibold px-4 py-1.5 rounded-lg transition-colors">Save</button>
                  <button onClick={() => setEditingProject(false)} className="text-[var(--text-muted)] hover:text-[var(--text)] text-xs px-3 py-1.5 rounded-lg transition-colors">Cancel</button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 mb-1">
                  <h1 className="text-2xl font-bold text-[var(--text)]">{projectForm.title || project.title}</h1>
                  <button onClick={() => setEditingProject(true)} className="text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors" title="Edit project details">
                    <Pencil size={13} />
                  </button>
                  {projectSaved && <span className="text-[10px] text-emerald-400 flex items-center gap-1"><Check size={10} /> Saved</span>}
                </div>
                <div className="flex items-center gap-3 text-sm text-[var(--text-muted)] mb-3">
                  {(projectForm.genre || project.genre) && <span>{projectForm.genre || project.genre}</span>}
                  {(projectForm.bpm || project.bpm) && <span>{projectForm.bpm || project.bpm} BPM</span>}
                  {(projectForm.key_signature || project.key_signature) && <span>{projectForm.key_signature || project.key_signature}</span>}
                  <span>{versions.length} mix{versions.length !== 1 ? 'es' : ''}</span>
                </div>
                <AddToCollectionButton projectId={project.id} />
              </>
            )}
            <StatusPipeline currentStatus={projectStatus} />
          </div>
        </div>

        {/* Tab bar */}
        <div className="flex gap-1 mb-6 border-b" style={{ borderColor: 'var(--surface-2)' }}>
          {(['versions', 'artwork', 'visualizer'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => switchTab(tab)}
              className="px-4 py-2.5 text-sm font-medium capitalize transition-colors relative"
              style={{
                color: activeTab === tab ? 'var(--accent)' : 'var(--text-muted)',
                borderBottom: activeTab === tab ? '2px solid var(--accent)' : '2px solid transparent',
                marginBottom: '-1px',
              }}
            >
              {tab === 'artwork' ? 'Artwork' : tab === 'visualizer' ? 'Visualizer' : 'Mixes'}
            </button>
          ))}
        </div>

        {/* Tab content — Versions */}
        {activeTab === 'versions' && (
        <div>

        {/* Action buttons */}
        <div className="flex items-center gap-3 mb-6">
          {uploading ? (
            <div className="flex items-center gap-3 rounded-xl px-4 py-2.5" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}>
              <span className="text-xs text-[var(--text-secondary)] flex-shrink-0">{uploadStatus}</span>
              <div className="w-32 h-1 bg-[var(--surface-2)] rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{ backgroundColor: uploadPct === 100 ? '#34d399' : '#2dd4bf', width: `${uploadPct}%` }}
                />
              </div>
              <span className="text-xs text-[var(--text-muted)] flex-shrink-0">{uploadPct}%</span>
            </div>
          ) : (
            <>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-2 bg-[#2dd4bf] hover:bg-[#14b8a6] text-[#0a0a0a] text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
              >
                <Upload size={15} />
                Update Mix
              </button>
              {uploadStatus.startsWith('Error') && (
                <span className="text-xs text-red-400">{uploadStatus}</span>
              )}
            </>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*,.wav,.mp3,.aiff,.aif,.flac,.m4a,.ogg"
            className="sr-only"
            onChange={handleFileSelect}
          />
        </div>

        {/* Release Pipeline section */}
        <div className="mt-10 mb-2">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <CalendarRange size={16} className="text-[#2dd4bf]" />
              <h2 className="text-sm font-semibold text-[var(--text)]">Release Pipeline</h2>
            </div>
            {release && (
              <Link
                href="/pipeline"
                className="flex items-center gap-1 text-xs text-[#555] hover:text-[#2dd4bf] transition-colors"
              >
                View in Pipeline
                <ExternalLink size={11} />
              </Link>
            )}
          </div>

          {release ? (
            <div className="rounded-2xl p-5" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}>
              {/* Progress bar */}
              <div className="flex items-center gap-3 mb-5">
                <div className="flex-1 h-1.5 bg-[var(--surface-2)] rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${releaseProgress}%`,
                      backgroundColor: releaseProgress === 100 ? '#34d399' : releaseProgress >= 50 ? '#2dd4bf' : '#555',
                    }}
                  />
                </div>
                <span className="text-xs text-[var(--text-muted)] flex-shrink-0">{releaseProgress}%</span>
              </div>

              {/* Checklist */}
              <div className="grid grid-cols-2 gap-x-6 gap-y-2.5">
                {CHECKLIST_ITEMS.map(item => (
                  <label key={item.key} className="flex items-center gap-2.5 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={release[item.key]}
                      onChange={() => toggleReleaseCheck(item.key, release[item.key])}
                      className="accent-[#2dd4bf] w-3.5 h-3.5 flex-shrink-0"
                    />
                    <span className={`text-sm transition-colors ${release[item.key] ? 'text-[var(--text-muted)] line-through' : 'text-[var(--text-secondary)] group-hover:text-[var(--text)]'}`}>
                      {item.label}
                    </span>
                  </label>
                ))}
              </div>

              {release.release_date && (
                <p className="text-xs text-[var(--text-muted)] mt-4">
                  Target date: {new Date(release.release_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                </p>
              )}
            </div>
          ) : (
            <div className="rounded-2xl p-6 flex flex-col items-center text-center gap-4" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}>
              <CalendarRange size={28} className="text-[var(--text-muted)]" />
              <div>
                <p className="text-sm text-[var(--text-secondary)]">Ready to plan your release?</p>
                <p className="text-xs text-[var(--text-muted)] mt-1">Track mixing, mastering, artwork, and DSP distribution from one place.</p>
              </div>
              <button
                onClick={startRelease}
                disabled={startingRelease}
                className="flex items-center gap-2 bg-[#2dd4bf] hover:bg-[#14b8a6] disabled:opacity-40 text-[#0a0a0a] text-sm font-semibold px-5 py-2.5 rounded-xl transition-colors"
              >
                <Plus size={15} />
                {startingRelease ? 'Creating…' : 'Start Release Pipeline'}
              </button>
            </div>
          )}
        </div>

        {/* Version list */}
        <div className="space-y-3">
          {versions.length === 0 ? (
            <div className="text-center py-16 text-[var(--text-muted)]">
              <Music size={32} className="mx-auto mb-3 text-[#2a2a2a]" />
              <p className="text-sm">No mixes yet — upload your first mix above</p>
            </div>
          ) : (
            versions.map((version, index) => {
              const isExpanded = expandedVersion === version.id
              const vUrl = audioProxyUrl(version.audio_url)
              const isActive = currentUrl === vUrl
              const vPct = isActive && duration > 0 ? (currentTime / duration) * 100 : 0
              const displayDuration = isActive ? duration : (version.duration_seconds ?? 0)
              const feedback = version.mb_feedback ?? []
              const ratedFeedback = feedback.filter(f => f.rating)
              const avgRating = ratedFeedback.length > 0
                ? (ratedFeedback.reduce((s, f) => s + f.rating!, 0) / ratedFeedback.length).toFixed(1)
                : null

              return (
                <div key={version.id} className="rounded-2xl overflow-hidden" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}>
                  <div
                    className="flex items-center gap-4 p-4 cursor-pointer hover:bg-[var(--surface-2)] transition-colors"
                    onClick={() => setExpandedVersion(isExpanded ? null : version.id)}
                  >
                    <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-[var(--surface-2)] flex items-center justify-center">
                      <Music size={16} className="text-[var(--text-secondary)]" />
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-[var(--text)]">
                          {version.label || parseMixLabel(version.audio_filename ?? '') || `Mix ${version.version_number}`}
                        </span>
                        {index === 0 && (
                          <span className="text-[10px] text-[var(--text-muted)] bg-[var(--surface-2)] px-1.5 py-0.5 rounded-full">Latest</span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-0.5 text-xs text-[var(--text-muted)]">
                        <span>{new Date(version.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                        {version.duration_seconds && <span>{formatDuration(version.duration_seconds)}</span>}
                        {version.file_size_bytes && <span>{formatFileSize(version.file_size_bytes)}</span>}
                        {feedback.length > 0 && (
                          <span className="flex items-center gap-1">
                            <MessageSquare size={10} />
                            {feedback.length} feedback
                            {avgRating && <span>· ★ {avgRating}</span>}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 flex-shrink-0">
                      <StatusBadge status={version.status} size="sm" />
                      {version.share_token && (
                        <button
                          onClick={e => { e.stopPropagation(); copyShareLink(version.share_token!) }}
                          className={`p-1.5 rounded-lg transition-colors ${
                            copiedToken === version.share_token
                              ? 'text-emerald-400 bg-emerald-400/10'
                              : 'text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)]'
                          }`}
                          title="Copy share link"
                        >
                          {copiedToken === version.share_token ? <Check size={14} /> : <Share2 size={14} />}
                        </button>
                      )}
                      {isExpanded ? <ChevronUp size={14} className="text-[var(--text-muted)]" /> : <ChevronDown size={14} className="text-[var(--text-muted)]" />}
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="px-4 pb-5 pt-1 space-y-5" style={{ borderTop: '1px solid var(--border)' }}>
                      {/* Per-version player — routes through shared PlayerContext audio element */}
                      <div className="w-full">
                        <div
                          className="relative w-full h-10 rounded-lg overflow-hidden mb-2"
                          style={{ backgroundColor: 'var(--input-bg)' }}
                        >
                          <div
                            className="absolute bottom-0 left-0 h-1 transition-all duration-100"
                            style={{ backgroundColor: 'var(--accent)', width: `${vPct}%` }}
                          />
                          <input
                            type="range"
                            min={0}
                            max={displayDuration || 1}
                            step={0.1}
                            value={isActive ? currentTime : 0}
                            onChange={(e) => {
                              if (isActive) seek(Number(e.target.value))
                              else playUrl(vUrl, projectForm.title || project.title, undefined, artwork ?? undefined, version.label || `v${version.version_number}`)
                            }}
                            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                          />
                        </div>
                        <div className="flex items-center gap-3">
                          <button
                            onClick={() => {
                              if (isActive) togglePlay()
                              else playUrl(vUrl, projectForm.title || project.title, undefined, artwork ?? undefined, version.label || `v${version.version_number}`)
                            }}
                            className="flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-full transition-colors"
                            style={{ backgroundColor: 'var(--surface-2)', border: '1px solid var(--surface-3)', color: 'var(--text)' }}
                          >
                            {isActive && isPlaying ? <Pause size={14} /> : <Play size={14} />}
                          </button>
                          <span className="text-xs tabular-nums flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
                            {formatDuration(isActive ? currentTime : 0)} / {formatDuration(displayDuration || null)}
                          </span>
                          <div className="flex-1" />
                          {version.allow_download && (
                            <a
                              href={vUrl}
                              download={version.audio_filename ?? 'mix.wav'}
                              className="flex items-center gap-1 transition-colors"
                              style={{ color: 'var(--text-muted)' }}
                              title="Download"
                              onClick={e => e.stopPropagation()}
                            >
                              <Download size={13} />
                            </a>
                          )}
                        </div>
                      </div>

                      {version.change_log && (
                        <div className="rounded-xl p-3" style={{ backgroundColor: 'var(--surface-2)' }}>
                          <p className="text-xs text-[var(--text-muted)] mb-1">What changed</p>
                          <p className="text-sm text-[var(--text-secondary)]">{version.change_log}</p>
                        </div>
                      )}

                      {/* Status changer */}
                      <div>
                        <p className="text-xs text-[var(--text-muted)] mb-2">Status</p>
                        <div className="flex gap-2 flex-wrap">
                          {STATUSES.map(s => {
                            const conf = STATUS_CONFIG[s]
                            const isActive = version.status === s
                            return (
                              <button
                                key={s}
                                onClick={() => updateStatus(version.id, s)}
                                className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                                  isActive
                                    ? `${conf.color} ${conf.bg} ${conf.border}`
                                    : 'text-[var(--text-muted)] border-[var(--border)] hover:text-[var(--text-secondary)]'
                                }`}
                              >
                                {conf.label}
                              </button>
                            )
                          })}
                        </div>
                      </div>

                      {/* Notes */}
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <div className="flex items-center justify-between mb-1.5">
                            <label className="block text-xs text-[var(--text-muted)]">Private notes</label>
                            {savedNoteKey === `${version.id}-private_notes` && (
                              <span className="text-[10px] text-emerald-400 flex items-center gap-1"><Check size={10} /> Saved</span>
                            )}
                          </div>
                          <textarea
                            defaultValue={version.private_notes ?? ''}
                            onBlur={e => updateNotes(version.id, 'private_notes', e.target.value)}
                            placeholder="Notes only you can see..."
                            rows={3}
                            className="w-full rounded-xl px-3 py-2 text-sm text-[var(--text)] focus:outline-none resize-none"
                            style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)' }}
                          />
                        </div>
                        <div>
                          <div className="flex items-center justify-between mb-1.5">
                            <label className="block text-xs text-[var(--text-muted)]">Public notes (share page)</label>
                            {savedNoteKey === `${version.id}-public_notes` && (
                              <span className="text-[10px] text-emerald-400 flex items-center gap-1"><Check size={10} /> Saved</span>
                            )}
                          </div>
                          <textarea
                            defaultValue={version.public_notes ?? ''}
                            onBlur={e => updateNotes(version.id, 'public_notes', e.target.value)}
                            placeholder="Notes visible to listeners..."
                            rows={3}
                            className="w-full rounded-xl px-3 py-2 text-sm text-[var(--text)] focus:outline-none resize-none"
                            style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)' }}
                          />
                        </div>
                      </div>

                      {/* Feedback */}
                      {feedback.length > 0 && (
                        <div>
                          <p className="text-xs text-[var(--text-muted)] mb-2">Listener Feedback</p>
                          <div className="space-y-2">
                            {feedback.map(f => (
                              <div key={f.id} className="rounded-xl p-3" style={{ backgroundColor: 'var(--surface-2)' }}>
                                <div className="flex items-center justify-between mb-1">
                                  <span className="text-xs font-medium text-[var(--text-secondary)]">{f.reviewer_name}</span>
                                  {f.rating && (
                                    <div className="flex gap-0.5">
                                      {[1,2,3,4,5].map(s => (
                                        <Star key={s} size={10} className={s <= f.rating! ? 'text-[#2dd4bf] fill-[#2dd4bf]' : 'text-[var(--text-muted)]'} />
                                      ))}
                                    </div>
                                  )}
                                </div>
                                <p className="text-xs text-[var(--text-secondary)]">{f.comment}</p>
                                <p className="text-[10px] text-[var(--text-muted)] mt-1">{new Date(f.created_at).toLocaleDateString()}</p>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      <div className="flex justify-end">
                        <button
                          onClick={() => deleteVersion(version.id)}
                          className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-red-400 transition-colors"
                        >
                          <Trash2 size={12} />
                          Delete mix
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>

        </div>
        )} {/* end activeTab === 'versions' */}

        {/* Tab content — Artwork */}
        {activeTab === 'artwork' && (
          <div className="max-w-2xl">
            <ArtworkGenerator
              projectId={project.id}
              projectTitle={project.title}
              genre={project.genre}
              currentArtwork={artwork}
              onArtworkUpdated={setArtwork}
            />
          </div>
        )}

        {/* Tab content — Visualizer */}
        {activeTab === 'visualizer' && (
          <Visualizer
            projectTitle={project.title}
            artworkUrl={artwork}
            onSwitchToArtwork={() => switchTab('artwork')}
          />
        )}

      </div>
    </div>
  )
}
