'use client'

import { useState, useRef } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { StatusBadge, StatusPipeline } from '@/components/StatusBadge'
import ArtworkGenerator from '@/components/ArtworkGenerator'
import { formatDuration, formatFileSize, STATUSES, STATUS_CONFIG, type Project, type Version, type Feedback } from '@/lib/supabase'
import {
  ArrowLeft, Plus, Share2, Check, ChevronDown, ChevronUp,
  MessageSquare, Star, ArrowLeftRight, Trash2, Music, Upload
} from 'lucide-react'

// WaveformPlayer is browser-only — import dynamically
const WaveformPlayer = dynamic(() => import('@/components/WaveformPlayer'), { ssr: false })
const ABCompare = dynamic(() => import('@/components/ABCompare'), { ssr: false })

type VersionWithFeedback = Version & { mf_feedback: Feedback[] }

type Props = {
  project: Project
  initialVersions: VersionWithFeedback[]
}

export default function ProjectClient({ project, initialVersions }: Props) {
  const [versions, setVersions] = useState(initialVersions)
  const [artwork, setArtwork] = useState(project.artwork_url)
  const [showUpload, setShowUpload] = useState(false)
  const [showAB, setShowAB] = useState(false)
  const [expandedVersion, setExpandedVersion] = useState<string | null>(versions[0]?.id ?? null)
  const [copiedToken, setCopiedToken] = useState<string | null>(null)
  const [uploadForm, setUploadForm] = useState({
    label: '', change_log: '', private_notes: '', public_notes: '',
    status: 'WIP' as Version['status'], allow_download: false,
  })
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState('')
  const [savingNotes, setSavingNotes] = useState<string | null>(null)
  const [notesError, setNotesError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Get the highest status across all versions (for the project-level pipeline)
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
    const key = `${versionId}:${field}`
    setSavingNotes(key)
    setNotesError(null)
    try {
      const res = await fetch(`/api/versions/${versionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setNotesError(data.error ?? 'Failed to save notes')
      }
    } catch {
      setNotesError('Network error — notes not saved')
    }
    setSavingNotes(null)
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setUploadProgress('Uploading audio...')

    const formData = new FormData()
    formData.append('file', file)
    formData.append('project_id', project.id)
    formData.append('type', 'audio')

    const uploadRes = await fetch('/api/upload-audio', { method: 'POST', body: formData })
    const uploadData = await uploadRes.json()

    if (!uploadRes.ok) {
      setUploadProgress(`Error: ${uploadData.error}`)
      setUploading(false)
      return
    }

    setUploadProgress('Creating version...')

    // Get audio duration via a temporary Audio element
    let duration: number | null = null
    try {
      duration = await new Promise((resolve) => {
        const audio = new Audio(uploadData.url)
        audio.addEventListener('loadedmetadata', () => resolve(Math.round(audio.duration)))
        audio.addEventListener('error', () => resolve(null))
        setTimeout(() => resolve(null), 10000)
      })
    } catch {
      duration = null
    }

    const versionRes = await fetch('/api/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: project.id,
        audio_url: uploadData.url,
        audio_filename: file.name,
        duration_seconds: duration,
        file_size_bytes: file.size,
        ...uploadForm,
      }),
    })

    const newVersion = await versionRes.json()
    if (versionRes.ok) {
      setVersions(prev => [{ ...newVersion, mf_feedback: [] }, ...prev])
      setExpandedVersion(newVersion.id)
      setShowUpload(false)
      setUploadForm({ label: '', change_log: '', private_notes: '', public_notes: '', status: 'WIP', allow_download: false })
      setUploadProgress('')
    } else {
      // Clean up the orphaned audio file from storage
      fetch('/api/upload-audio', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: uploadData.path, bucket: 'mf-audio' }),
      }).catch(() => {})
      setUploadProgress(`Error saving version: ${newVersion.error ?? 'Unknown error'}`)
    }

    setUploading(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  async function deleteVersion(versionId: string) {
    if (!confirm('Delete this version? This cannot be undone.')) return
    const res = await fetch(`/api/versions/${versionId}`, { method: 'DELETE' })
    if (res.ok) setVersions(prev => prev.filter(v => v.id !== versionId))
  }

  return (
    <div className="pt-14">
      <div className="max-w-4xl mx-auto px-6 py-8">
        {/* Back */}
        <Link href="/dashboard" className="flex items-center gap-2 text-[#555] hover:text-white text-sm mb-6 transition-colors w-fit">
          <ArrowLeft size={14} />
          Dashboard
        </Link>

        {/* Project header */}
        <div className="flex gap-6 mb-8">
          {/* Artwork */}
          <div className="flex-shrink-0 w-32">
            <ArtworkGenerator
              projectId={project.id}
              projectTitle={project.title}
              genre={project.genre}
              currentArtwork={artwork}
              onArtworkUpdated={setArtwork}
            />
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0 pt-1">
            <h1 className="text-2xl font-bold text-white mb-1">{project.title}</h1>
            <div className="flex items-center gap-3 text-sm text-[#555] mb-4">
              {project.genre && <span>{project.genre}</span>}
              {project.bpm && <span>{project.bpm} BPM</span>}
              {project.key_signature && <span>Key of {project.key_signature}</span>}
              <span>{versions.length} version{versions.length !== 1 ? 's' : ''}</span>
            </div>

            {/* Status pipeline */}
            <StatusPipeline currentStatus={projectStatus} />
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={() => setShowUpload(!showUpload)}
            className="flex items-center gap-2 bg-[#a78bfa] hover:bg-[#9370f0] text-white text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
          >
            <Plus size={15} />
            Add Version
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
            <h2 className="text-sm font-semibold text-white mb-4">Upload New Version</h2>
            <div className="space-y-4">
              {/* File picker */}
              <div
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-[#222] hover:border-[#a78bfa]/30 rounded-xl p-6 text-center cursor-pointer transition-colors"
              >
                <Upload size={24} className="mx-auto text-[#444] mb-2" />
                <p className="text-sm text-[#555]">Click to choose audio file</p>
                <p className="text-xs text-[#333] mt-1">WAV, MP3, AIFF · Max 50MB</p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="audio/*"
                  className="hidden"
                  onChange={handleFileUpload}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-[#666] mb-1.5">Version label</label>
                  <input
                    type="text"
                    placeholder="e.g. More low end"
                    value={uploadForm.label}
                    onChange={e => setUploadForm(p => ({ ...p, label: e.target.value }))}
                    className="w-full bg-[#0f0f0f] border border-[#222] rounded-xl px-3 py-2 text-sm text-white placeholder-[#333] focus:outline-none focus:border-[#a78bfa]/40"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[#666] mb-1.5">Status</label>
                  <select
                    value={uploadForm.status}
                    onChange={e => setUploadForm(p => ({ ...p, status: e.target.value as Version['status'] }))}
                    className="w-full bg-[#0f0f0f] border border-[#222] rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-[#a78bfa]/40 appearance-none"
                  >
                    {STATUSES.map(s => <option key={s} value={s} className="bg-[#111]">{s}</option>)}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs text-[#666] mb-1.5">What changed from last version?</label>
                <textarea
                  placeholder="e.g. Boosted the sub, tightened the reverb tail on the snare..."
                  value={uploadForm.change_log}
                  onChange={e => setUploadForm(p => ({ ...p, change_log: e.target.value }))}
                  rows={2}
                  className="w-full bg-[#0f0f0f] border border-[#222] rounded-xl px-3 py-2 text-sm text-white placeholder-[#333] focus:outline-none focus:border-[#a78bfa]/40 resize-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-[#666] mb-1.5">Private notes (only you)</label>
                  <textarea
                    placeholder="Internal notes..."
                    value={uploadForm.private_notes}
                    onChange={e => setUploadForm(p => ({ ...p, private_notes: e.target.value }))}
                    rows={2}
                    className="w-full bg-[#0f0f0f] border border-[#222] rounded-xl px-3 py-2 text-sm text-white placeholder-[#333] focus:outline-none focus:border-[#a78bfa]/40 resize-none"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[#666] mb-1.5">Public notes (visible on share page)</label>
                  <textarea
                    placeholder="Notes for listener..."
                    value={uploadForm.public_notes}
                    onChange={e => setUploadForm(p => ({ ...p, public_notes: e.target.value }))}
                    rows={2}
                    className="w-full bg-[#0f0f0f] border border-[#222] rounded-xl px-3 py-2 text-sm text-white placeholder-[#333] focus:outline-none focus:border-[#a78bfa]/40 resize-none"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="allow_download"
                  checked={uploadForm.allow_download}
                  onChange={e => setUploadForm(p => ({ ...p, allow_download: e.target.checked }))}
                  className="accent-[#a78bfa]"
                />
                <label htmlFor="allow_download" className="text-xs text-[#666]">Allow download on share page</label>
              </div>

              {uploadProgress && (
                <p className="text-xs text-[#a78bfa]">{uploadProgress}</p>
              )}
            </div>
          </div>
        )}

        {/* A/B Compare */}
        {showAB && versions.length >= 2 && (
          <div className="bg-[#111] border border-[#1e1e1e] rounded-2xl p-6 mb-6">
            <ABCompare versions={versions} />
          </div>
        )}

        {/* Version timeline */}
        <div className="space-y-3">
          {versions.length === 0 ? (
            <div className="text-center py-16 text-[#444]">
              <Music size={32} className="mx-auto mb-3 text-[#2a2a2a]" />
              <p className="text-sm">No versions yet — upload your first mix above</p>
            </div>
          ) : (
            versions.map((version, index) => {
              const isExpanded = expandedVersion === version.id
              const feedback = version.mf_feedback ?? []
              const avgRating = feedback.length > 0
                ? (feedback.reduce((s, f) => s + (f.rating ?? 0), 0) / feedback.filter(f => f.rating).length).toFixed(1)
                : null

              return (
                <div key={version.id} className="bg-[#111] border border-[#1a1a1a] rounded-2xl overflow-hidden">
                  {/* Version header */}
                  <div
                    className="flex items-center gap-4 p-4 cursor-pointer hover:bg-[#141414] transition-colors"
                    onClick={() => setExpandedVersion(isExpanded ? null : version.id)}
                  >
                    {/* Version number */}
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

                      {/* Share button */}
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

                  {/* Expanded content */}
                  {isExpanded && (
                    <div className="px-4 pb-5 pt-1 border-t border-[#1a1a1a] space-y-5">
                      {/* Waveform player */}
                      <WaveformPlayer
                        audioUrl={version.audio_url}
                        allowDownload={version.allow_download}
                        filename={version.audio_filename ?? undefined}
                      />

                      {/* Change log */}
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
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                          <p className="text-xs text-[#555]">Notes</p>
                          {savingNotes?.startsWith(version.id) && (
                            <span className="text-[10px] text-[#555]">Saving...</span>
                          )}
                          {notesError && !savingNotes?.startsWith(version.id) && (
                            <span className="text-[10px] text-red-400">{notesError}</span>
                          )}
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <label className="block text-xs text-[#555] mb-1.5">Private (only you)</label>
                            <textarea
                              defaultValue={version.private_notes ?? ''}
                              onBlur={e => updateNotes(version.id, 'private_notes', e.target.value)}
                              placeholder="Notes only you can see..."
                              rows={3}
                              className="w-full bg-[#0f0f0f] border border-[#1e1e1e] rounded-xl px-3 py-2 text-sm text-white placeholder-[#333] focus:outline-none focus:border-[#a78bfa]/30 resize-none"
                            />
                          </div>
                          <div>
                            <label className="block text-xs text-[#555] mb-1.5">Public (share page)</label>
                            <textarea
                              defaultValue={version.public_notes ?? ''}
                              onBlur={e => updateNotes(version.id, 'public_notes', e.target.value)}
                              placeholder="Notes visible to listeners..."
                              rows={3}
                              className="w-full bg-[#0f0f0f] border border-[#1e1e1e] rounded-xl px-3 py-2 text-sm text-white placeholder-[#333] focus:outline-none focus:border-[#a78bfa]/30 resize-none"
                            />
                          </div>
                        </div>
                      </div>

                      {/* Feedback list */}
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
                                <p className="text-[10px] text-[#333] mt-1">
                                  {new Date(f.created_at).toLocaleDateString()}
                                </p>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Delete */}
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
