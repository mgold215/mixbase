'use client'

import { useState, useRef, type ChangeEvent } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { StatusBadge, StatusPipeline } from '@/components/StatusBadge'
import ArtworkGenerator from '@/components/ArtworkGenerator'
import { formatDuration, formatFileSize, STATUSES, STATUS_CONFIG, audioProxyUrl, type Project, type Version, type Feedback } from '@/lib/supabase'
import { analyzeFile } from '@/lib/audio-analysis'
import {
  ArrowLeft, Plus, Share2, Check, ChevronDown, ChevronUp,
  MessageSquare, Star, ArrowLeftRight, Trash2, Music, Upload, Pencil,
  CalendarRange, ExternalLink
} from 'lucide-react'
import type { Release } from '@/lib/supabase'

const CHECKLIST_ITEMS = [
  { key: 'mixing_done' as const,       label: 'Mixing done' },
  { key: 'mastering_done' as const,    label: 'Mastering done' },
  { key: 'artwork_ready' as const,     label: 'Artwork ready' },
  { key: 'dsp_submitted' as const,     label: 'DSP submitted' },
  { key: 'social_posts_done' as const, label: 'Social posts scheduled' },
  { key: 'press_release_done' as const,label: 'Press release done' },
]

const WaveformPlayer = dynamic(() => import('@/components/WaveformPlayer'), { ssr: false })
const ABCompare = dynamic(() => import('@/components/ABCompare'), { ssr: false })

type VersionWithFeedback = Version & { mb_feedback: Feedback[] }

type Props = {
  project: Project
  initialVersions: VersionWithFeedback[]
  initialRelease: Release | null
}

export default function ProjectClient({ project, initialVersions, initialRelease }: Props) {
  const [versions, setVersions] = useState(initialVersions)
  const [artwork, setArtwork] = useState(project.artwork_url)
  const [showUpload, setShowUpload] = useState(false)
  const [showAB, setShowAB] = useState(false)
  const [expandedVersion, setExpandedVersion] = useState<string | null>(versions[0]?.id ?? null)
  const [copiedToken, setCopiedToken] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadPct, setUploadPct] = useState(0)
  const [uploadStatus, setUploadStatus] = useState('')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [detectingMeta, setDetectingMeta] = useState(false)
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

  async function handleFileSelect(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setSelectedFile(file); setUploadStatus('')
    // Auto-detect BPM and key from the selected file
    setDetectingMeta(true)
    const result = await analyzeFile(file)
    if (result) {
      setProjectForm(p => ({
        ...p,
        bpm: result.bpm.toString(),
        key_signature: result.key,
      }))
    }
    setDetectingMeta(false)
  }

  async function handleUploadSubmit() {
    if (!selectedFile) return
    if (selectedFile.size > 2 * 1024 * 1024 * 1024) {
      setUploadStatus('Error: File too large (max 2GB)')
      return
    }
    setUploading(true)
    setUploadPct(0)
    setUploadStatus('Uploading...')

    const ext = selectedFile.name.split('.').pop()
    const filename = `${project.id}/${Date.now()}.${ext}`

    const mimeByExt: Record<string, string> = {
      wav: 'audio/wav', wave: 'audio/wav', aif: 'audio/aiff', aiff: 'audio/aiff',
      mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', ogg: 'audio/ogg',
    }
    const fileExt = (selectedFile.name.split('.').pop() ?? '').toLowerCase()
    const contentType = selectedFile.type || mimeByExt[fileExt] || 'application/octet-stream'

    // Direct browser → Supabase upload using a short-lived signed URL.
    // Railway is completely out of the byte path, so its 10 MB edge-proxy
    // cap (which was silently truncating files to exactly 10 MiB) is gone.
    setUploadStatus('Uploading...')

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
      xhr.send(selectedFile)
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
    setUploadStatus('Saving version...')

    const versionRes = await fetch('/api/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: project.id,
        audio_url: audioUrl,
        audio_filename: selectedFile.name,
        duration_seconds: duration,
        file_size_bytes: selectedFile.size,
      }),
    })

    const newVersion = await versionRes.json()
    if (versionRes.ok) {
      setUploadPct(100)
      setUploadStatus('Done!')
      setTimeout(() => {
        setVersions(prev => [{ ...newVersion, mb_feedback: [] }, ...prev])
        setExpandedVersion(newVersion.id)
        setShowUpload(false)
        setSelectedFile(null)
        setUploadPct(0)
        setUploadStatus('')
        setUploading(false)
      }, 600)
    } else {
      setUploadStatus(`Error: ${newVersion.error ?? 'Unknown error'}`)
      setUploadPct(0)
      setUploading(false)
    }

    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  async function deleteVersion(versionId: string) {
    if (!confirm('Delete this version? This cannot be undone.')) return
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
      <div className="max-w-4xl mx-auto px-6 py-8">
        <Link href="/dashboard" className="flex items-center gap-2 text-[#555] hover:text-white text-sm mb-6 transition-colors w-fit">
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
                  className="w-full bg-[#0f0f0f] border border-[#a78bfa]/30 rounded-xl px-3 py-2 text-lg font-bold text-white focus:outline-none focus:border-[#a78bfa]/60"
                />
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="block text-[10px] text-[#555] mb-1">Genre</label>
                    <input type="text" value={projectForm.genre} onChange={e => setProjectForm(p => ({ ...p, genre: e.target.value }))} placeholder="e.g. Techno" className="w-full bg-[#0f0f0f] border border-[#222] rounded-lg px-2 py-1.5 text-xs text-white placeholder-[#333] focus:outline-none focus:border-[#a78bfa]/40" />
                  </div>
                  <div>
                    <label className="block text-[10px] text-[#555] mb-1">BPM</label>
                    <input type="number" value={projectForm.bpm} onChange={e => setProjectForm(p => ({ ...p, bpm: e.target.value }))} placeholder="e.g. 140" className="w-full bg-[#0f0f0f] border border-[#222] rounded-lg px-2 py-1.5 text-xs text-white placeholder-[#333] focus:outline-none focus:border-[#a78bfa]/40" />
                  </div>
                  <div>
                    <label className="block text-[10px] text-[#555] mb-1">Key</label>
                    <input type="text" value={projectForm.key_signature} onChange={e => setProjectForm(p => ({ ...p, key_signature: e.target.value }))} placeholder="e.g. Am" className="w-full bg-[#0f0f0f] border border-[#222] rounded-lg px-2 py-1.5 text-xs text-white placeholder-[#333] focus:outline-none focus:border-[#a78bfa]/40" />
                  </div>
                </div>
                <div className="flex gap-2">
                  <button onClick={saveProject} className="bg-[#a78bfa] hover:bg-[#9370f0] text-white text-xs font-semibold px-4 py-1.5 rounded-lg transition-colors">Save</button>
                  <button onClick={() => setEditingProject(false)} className="text-[#444] hover:text-white text-xs px-3 py-1.5 rounded-lg transition-colors">Cancel</button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 mb-1">
                  <h1 className="text-2xl font-bold text-white">{projectForm.title || project.title}</h1>
                  <button onClick={() => setEditingProject(true)} className="text-[#333] hover:text-[#666] transition-colors" title="Edit project details">
                    <Pencil size={13} />
                  </button>
                  {projectSaved && <span className="text-[10px] text-emerald-400 flex items-center gap-1"><Check size={10} /> Saved</span>}
                </div>
                <div className="flex items-center gap-3 text-sm text-[#555] mb-4">
                  {(projectForm.genre || project.genre) && <span>{projectForm.genre || project.genre}</span>}
                  {(projectForm.bpm || project.bpm) && <span>{projectForm.bpm || project.bpm} BPM</span>}
                  {(projectForm.key_signature || project.key_signature) && <span>Key of {projectForm.key_signature || project.key_signature}</span>}
                  <span>{versions.length} version{versions.length !== 1 ? 's' : ''}</span>
                </div>
              </>
            )}
            <StatusPipeline currentStatus={projectStatus} />
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={() => setShowUpload(!showUpload)}
            className="flex items-center gap-2 bg-[#a78bfa] hover:bg-[#9370f0] text-white text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
          >
            <Upload size={15} />
            Update Track
          </button>

          {versions.length >= 2 && (
            <button
              onClick={() => setShowAB(!showAB)}
              className={`flex items-center gap-2 text-sm px-4 py-2 rounded-xl border transition-colors ${
                showAB ? 'bg-[#a78bfa]/10 border-[#a78bfa]/30 text-[#a78bfa]' : 'border-[#222] text-[#666] hover:text-white hover:border-[#333]'
              }`}
            >
              <ArrowLeftRight size={14} />
              A/B Compare
            </button>
          )}
        </div>

        {/* Upload form */}
        {showUpload && (
          <div className="bg-[#111] border border-[#1e1e1e] rounded-2xl p-6 mb-6">
            <div className="space-y-4">
              {!selectedFile ? (
                <label className="block border-2 border-dashed border-[#222] hover:border-[#a78bfa]/30 active:border-[#a78bfa]/50 rounded-xl p-6 text-center cursor-pointer transition-colors">
                  <Upload size={24} className="mx-auto text-[#444] mb-2" />
                  <p className="text-sm text-[#555]">Tap to choose audio file</p>
                  <p className="text-xs text-[#333] mt-1">WAV, AIFF recommended · MP3 at 320kbps+ · Max 2GB</p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="audio/*,.wav,.mp3,.aiff,.aif,.flac,.m4a,.ogg"
                    className="sr-only"
                    onChange={handleFileSelect}
                  />
                </label>
              ) : (
                <div className="flex items-center gap-3 bg-[#0f0f0f] border border-[#222] rounded-xl px-4 py-3">
                  <Music size={16} className="text-[#a78bfa] flex-shrink-0" />
                  <span className="text-sm text-white truncate flex-1">{selectedFile.name}</span>
                  <span className="text-xs text-[#555] flex-shrink-0">{(selectedFile.size / (1024 * 1024)).toFixed(1)} MB</span>
                  {detectingMeta && <span className="text-[10px] text-[#a78bfa] animate-pulse flex-shrink-0">detecting BPM & key…</span>}
                  {!uploading && (
                    <button
                      onClick={() => { setSelectedFile(null); if (fileInputRef.current) fileInputRef.current.value = '' }}
                      className="text-[#444] hover:text-red-400 flex-shrink-0 transition-colors"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              )}

              {(uploading || uploadStatus) && (
                <div>
                  <div className="flex justify-between text-xs mb-1.5">
                    <span className={uploadStatus.startsWith('Error') ? 'text-red-400' : 'text-[#a78bfa]'}>{uploadStatus}</span>
                    {!uploadStatus.startsWith('Error') && <span className="text-[#555]">{uploadPct}%</span>}
                  </div>
                  {!uploadStatus.startsWith('Error') && (
                    <div className="h-1.5 bg-[#1a1a1a] rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-300 ${
                          uploadPct === 100 ? 'bg-emerald-400' : 'bg-[#a78bfa]'
                        }`}
                        style={{ width: `${uploadPct}%` }}
                      />
                    </div>
                  )}
                </div>
              )}

              <button
                onClick={handleUploadSubmit}
                disabled={!selectedFile || uploading}
                className="w-full bg-[#a78bfa] hover:bg-[#9370f0] disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-xl py-3 transition-colors"
              >
                {uploading ? (uploadStatus.startsWith('Error') ? 'Upload' : uploadStatus) : uploadStatus.startsWith('Error') ? 'Try Again' : 'Upload'}
              </button>
            </div>
          </div>
        )}

        {/* A/B Compare */}
        {showAB && versions.length >= 2 && (
          <div className="bg-[#111] border border-[#1e1e1e] rounded-2xl p-6 mb-6">
            <ABCompare versions={versions} />
          </div>
        )}

        {/* Release Pipeline section */}
        <div className="mt-10 mb-2">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <CalendarRange size={16} className="text-[#a78bfa]" />
              <h2 className="text-sm font-semibold text-white">Release Pipeline</h2>
            </div>
            {release && (
              <Link
                href="/pipeline"
                className="flex items-center gap-1 text-xs text-[#555] hover:text-[#a78bfa] transition-colors"
              >
                View in Pipeline
                <ExternalLink size={11} />
              </Link>
            )}
          </div>

          {release ? (
            <div className="bg-[#111] border border-[#1a1a1a] rounded-2xl p-5">
              {/* Progress bar */}
              <div className="flex items-center gap-3 mb-5">
                <div className="flex-1 h-1.5 bg-[#1a1a1a] rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${releaseProgress}%`,
                      backgroundColor: releaseProgress === 100 ? '#34d399' : releaseProgress >= 50 ? '#a78bfa' : '#555',
                    }}
                  />
                </div>
                <span className="text-xs text-[#444] flex-shrink-0">{releaseProgress}%</span>
              </div>

              {/* Checklist */}
              <div className="grid grid-cols-2 gap-x-6 gap-y-2.5">
                {CHECKLIST_ITEMS.map(item => (
                  <label key={item.key} className="flex items-center gap-2.5 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={release[item.key]}
                      onChange={() => toggleReleaseCheck(item.key, release[item.key])}
                      className="accent-[#a78bfa] w-3.5 h-3.5 flex-shrink-0"
                    />
                    <span className={`text-sm transition-colors ${release[item.key] ? 'text-[#555] line-through' : 'text-[#888] group-hover:text-white'}`}>
                      {item.label}
                    </span>
                  </label>
                ))}
              </div>

              {release.release_date && (
                <p className="text-xs text-[#444] mt-4">
                  Target date: {new Date(release.release_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                </p>
              )}
            </div>
          ) : (
            <div className="bg-[#111] border border-[#1a1a1a] rounded-2xl p-6 flex flex-col items-center text-center gap-4">
              <CalendarRange size={28} className="text-[#2a2a2a]" />
              <div>
                <p className="text-sm text-[#666]">Ready to plan your release?</p>
                <p className="text-xs text-[#444] mt-1">Track mixing, mastering, artwork, and DSP distribution from one place.</p>
              </div>
              <button
                onClick={startRelease}
                disabled={startingRelease}
                className="flex items-center gap-2 bg-[#a78bfa] hover:bg-[#9370f0] disabled:opacity-40 text-white text-sm font-semibold px-5 py-2.5 rounded-xl transition-colors"
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
            <div className="text-center py-16 text-[#444]">
              <Music size={32} className="mx-auto mb-3 text-[#2a2a2a]" />
              <p className="text-sm">No versions yet — upload your first mix above</p>
            </div>
          ) : (
            versions.map((version, index) => {
              const isExpanded = expandedVersion === version.id
              const feedback = version.mb_feedback ?? []
              const ratedFeedback = feedback.filter(f => f.rating)
              const avgRating = ratedFeedback.length > 0
                ? (ratedFeedback.reduce((s, f) => s + f.rating!, 0) / ratedFeedback.length).toFixed(1)
                : null

              return (
                <div key={version.id} className="bg-[#111] border border-[#1a1a1a] rounded-2xl overflow-hidden">
                  <div
                    className="flex items-center gap-4 p-4 cursor-pointer hover:bg-[#141414] transition-colors"
                    onClick={() => setExpandedVersion(isExpanded ? null : version.id)}
                  >
                    <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-[#1a1a1a] flex items-center justify-center">
                      <span className="text-sm font-bold text-[#888]">v{version.version_number}</span>
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-white">
                          {version.label || `Version ${version.version_number}`}
                        </span>
                        {index === 0 && (
                          <span className="text-[10px] text-[#555] bg-[#1a1a1a] px-1.5 py-0.5 rounded-full">Latest</span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-0.5 text-xs text-[#444]">
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
                      <button
                        onClick={e => { e.stopPropagation(); copyShareLink(version.share_token) }}
                        className={`p-1.5 rounded-lg transition-colors ${
                          copiedToken === version.share_token
                            ? 'text-emerald-400 bg-emerald-400/10'
                            : 'text-[#444] hover:text-white hover:bg-[#1e1e1e]'
                        }`}
                        title="Copy share link"
                      >
                        {copiedToken === version.share_token ? <Check size={14} /> : <Share2 size={14} />}
                      </button>
                      {isExpanded ? <ChevronUp size={14} className="text-[#444]" /> : <ChevronDown size={14} className="text-[#444]" />}
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="px-4 pb-5 pt-1 border-t border-[#1a1a1a] space-y-5">
                      <WaveformPlayer
                        audioUrl={audioProxyUrl(version.audio_url)}
                        allowDownload={version.allow_download}
                        filename={version.audio_filename ?? undefined}
                      />

                      {version.change_log && (
                        <div className="bg-[#0f0f0f] rounded-xl p-3">
                          <p className="text-xs text-[#555] mb-1">What changed</p>
                          <p className="text-sm text-[#888]">{version.change_log}</p>
                        </div>
                      )}

                      {/* Status changer */}
                      <div>
                        <p className="text-xs text-[#555] mb-2">Status</p>
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
                                    : 'text-[#444] border-[#222] hover:border-[#333] hover:text-[#888]'
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
                            <label className="block text-xs text-[#555]">Private notes</label>
                            {savedNoteKey === `${version.id}-private_notes` && (
                              <span className="text-[10px] text-emerald-400 flex items-center gap-1"><Check size={10} /> Saved</span>
                            )}
                          </div>
                          <textarea
                            defaultValue={version.private_notes ?? ''}
                            onBlur={e => updateNotes(version.id, 'private_notes', e.target.value)}
                            placeholder="Notes only you can see..."
                            rows={3}
                            className="w-full bg-[#0f0f0f] border border-[#1e1e1e] rounded-xl px-3 py-2 text-sm text-white placeholder-[#333] focus:outline-none focus:border-[#a78bfa]/30 resize-none"
                          />
                        </div>
                        <div>
                          <div className="flex items-center justify-between mb-1.5">
                            <label className="block text-xs text-[#555]">Public notes (share page)</label>
                            {savedNoteKey === `${version.id}-public_notes` && (
                              <span className="text-[10px] text-emerald-400 flex items-center gap-1"><Check size={10} /> Saved</span>
                            )}
                          </div>
                          <textarea
                            defaultValue={version.public_notes ?? ''}
                            onBlur={e => updateNotes(version.id, 'public_notes', e.target.value)}
                            placeholder="Notes visible to listeners..."
                            rows={3}
                            className="w-full bg-[#0f0f0f] border border-[#1e1e1e] rounded-xl px-3 py-2 text-sm text-white placeholder-[#333] focus:outline-none focus:border-[#a78bfa]/30 resize-none"
                          />
                        </div>
                      </div>

                      {/* Feedback */}
                      {feedback.length > 0 && (
                        <div>
                          <p className="text-xs text-[#555] mb-2">Listener Feedback</p>
                          <div className="space-y-2">
                            {feedback.map(f => (
                              <div key={f.id} className="bg-[#0f0f0f] rounded-xl p-3">
                                <div className="flex items-center justify-between mb-1">
                                  <span className="text-xs font-medium text-[#888]">{f.reviewer_name}</span>
                                  {f.rating && (
                                    <div className="flex gap-0.5">
                                      {[1,2,3,4,5].map(s => (
                                        <Star key={s} size={10} className={s <= f.rating! ? 'text-[#a78bfa] fill-[#a78bfa]' : 'text-[#333]'} />
                                      ))}
                                    </div>
                                  )}
                                </div>
                                <p className="text-xs text-[#666]">{f.comment}</p>
                                <p className="text-[10px] text-[#333] mt-1">{new Date(f.created_at).toLocaleDateString()}</p>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      <div className="flex justify-end">
                        <button
                          onClick={() => deleteVersion(version.id)}
                          className="flex items-center gap-1.5 text-xs text-[#333] hover:text-red-400 transition-colors"
                        >
                          <Trash2 size={12} />
                          Delete version
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
    </div>
  )
}
