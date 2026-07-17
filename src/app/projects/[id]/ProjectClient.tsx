'use client'

import { useState, useRef, type ChangeEvent, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { usePlayer } from '@/contexts/PlayerContext'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { StatusBadge, StatusPipeline } from '@/components/StatusBadge'
import ArtworkGenerator from '@/components/ArtworkGenerator'
import { formatDuration, formatFileSize, STATUSES, STATUS_CONFIG, audioProxyUrl, type Project, type Version, type Feedback } from '@/lib/supabase'
import { trackShareUrl } from '@/lib/share-url'
import { buildPunchList, buildSummaryExport, buildMixReport } from '@/lib/punch-list'
import { analyzeFile } from '@/lib/audio-analysis'
import { copyToClipboard } from '@/lib/clipboard'
import {
  ArrowLeft, Plus, Share2, Check, MessageSquare, Star, Trash2, Music,
  Upload, Pencil, CalendarRange, ExternalLink, Play, Pause, Download,
  Sparkles, History, X, ClipboardList, Copy, FileText,
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
const VideoFinalizer = dynamic(() => import('@/components/VideoFinalizer'), { ssr: false })

type VersionWithFeedback = Version & { mb_feedback: Feedback[] }

type Props = {
  project: Project
  initialVersions: VersionWithFeedback[]
  initialRelease: Release | null
  inModal?: boolean
}

export default function ProjectClient({ project, initialVersions, initialRelease, inModal = false }: Props) {
  const [versions, setVersions] = useState(initialVersions)
  const [artwork, setArtwork] = useState(project.artwork_url)
  const [finalizedArtwork, setFinalizedArtwork] = useState(project.finalized_artwork_url)
  // ?? null: prod rows can predate the 015/020 migrations (columns self-heal on first write)
  const [visualizer, setVisualizer] = useState(project.visualizer_url ?? null)
  const [visualizerWide, setVisualizerWide] = useState(project.visualizer_wide_url ?? null)
  const [copied, setCopied] = useState(false)
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
  const [summaries, setSummaries] = useState<Record<string, string>>({})
  const [summaryLoading, setSummaryLoading] = useState<string | null>(null)
  const [summaryError, setSummaryError] = useState<Record<string, string>>({})
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [deletingProject, setDeletingProject] = useState(false)
  // Transient error toast so failed mutations surface instead of silently
  // no-op'ing and leaving the UI out of sync with the DB.
  const [actionError, setActionError] = useState<string | null>(null)
  function flashError(msg: string) {
    setActionError(msg)
    setTimeout(() => setActionError(null), 4000)
  }
  const router = useRouter()

  const { playUrl, currentUrl, currentTime, duration, isPlaying, seek, togglePlay, refreshTracks } = usePlayer()

  // Push edits to the rest of the app: the player's client-side track list
  // (refreshTracks) and the server-rendered pages cached by the router —
  // dashboard stage chips, pipeline, the dashboard visible under the modal.
  function syncAfterMutation() {
    refreshTracks()
    router.refresh()
  }

  function handleArtworkUpdated(url: string) {
    setArtwork(url)
    syncAfterMutation()
  }

  function handleFinalizedUpdated(url: string | null) {
    setFinalizedArtwork(url)
    syncAfterMutation()
  }

  function handleVisualizerUpdated(url: string | null) {
    setVisualizer(url)
    syncAfterMutation()
  }

  function handleWideVisualizerUpdated(url: string | null) {
    setVisualizerWide(url)
    syncAfterMutation()
  }

  // Tab state — persists in URL hash
  const [activeTab, setActiveTab] = useState<'versions' | 'artwork' | 'visualizer' | 'video'>(() => {
    if (typeof window === 'undefined') return 'versions'
    const hash = window.location.hash.replace('#', '')
    if (hash === 'artwork' || hash === 'visualizer' || hash === 'video') return hash
    return 'versions'
  })

  function switchTab(tab: 'versions' | 'artwork' | 'visualizer' | 'video') {
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

  async function copyShareLink() {
    if (!project.share_token) return
    const url = trackShareUrl(project.share_token)
    // copyToClipboard tries the async API then a hidden-textarea fallback, so we
    // only flash "Copied!" when the text actually made it to the clipboard.
    if (await copyToClipboard(url)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } else {
      flashError('Could not copy the link — long-press to copy it manually.')
    }
  }

  async function deleteProject() {
    if (!confirm('Delete this project and all its mixes? This cannot be undone.')) return
    setDeletingProject(true)
    try {
      const res = await fetch(`/api/projects/${project.id}`, { method: 'DELETE' })
      if (res.ok) {
        refreshTracks()
        if (inModal) router.back()
        else router.push('/dashboard')
        router.refresh()
      } else {
        setDeletingProject(false)
        flashError('Could not delete the project — please try again.')
      }
    } catch {
      setDeletingProject(false)
      flashError('Could not delete the project — check your connection.')
    }
  }

  async function updateStatus(versionId: string, newStatus: Version['status']) {
    const prevStatus = versions.find(v => v.id === versionId)?.status
    // Optimistic — revert on failure so the badge can't lie about the DB.
    setVersions(prev => prev.map(v => v.id === versionId ? { ...v, status: newStatus } : v))
    try {
      const res = await fetch(`/api/versions/${versionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      })
      if (res.ok) {
        syncAfterMutation()
      } else {
        if (prevStatus) setVersions(prev => prev.map(v => v.id === versionId ? { ...v, status: prevStatus } : v))
        flashError('Could not update the status — reverted.')
      }
    } catch {
      if (prevStatus) setVersions(prev => prev.map(v => v.id === versionId ? { ...v, status: prevStatus } : v))
      flashError('Could not update the status — check your connection.')
    }
  }

  async function updateNotes(versionId: string, field: 'private_notes' | 'public_notes', value: string) {
    try {
      const res = await fetch(`/api/versions/${versionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      })
      if (res.ok) {
        const key = `${versionId}-${field}`
        setSavedNoteKey(key)
        setTimeout(() => setSavedNoteKey(null), 2000)
      } else {
        flashError('Notes did not save — please retry before leaving the page.')
      }
    } catch {
      flashError('Notes did not save — check your connection and retry.')
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

  // TUS chunked upload for large files (bypasses Supabase's non-resumable size limit)
  async function tusUpload(file: File, filename: string, contentType: string): Promise<{ ok: boolean; error?: string }> {
    const { Upload } = await import('tus-js-client')
    const bucketName = 'mf-audio'
    return new Promise((resolve) => {
      const upload = new Upload(file, {
        endpoint: '/api/tus',
        chunkSize: 8 * 1024 * 1024, // 8 MB — under Railway's 10 MB wall
        retryDelays: [0, 1000, 3000, 5000],
        metadata: {
          bucketName,
          objectName: filename,
          contentType,
          cacheControl: '3600',
        },
        headers: { 'x-upsert': 'true' },
        onProgress: (bytesUploaded, bytesTotal) => {
          setUploadPct(Math.round((bytesUploaded / bytesTotal) * 80))
        },
        onSuccess: () => resolve({ ok: true }),
        onError: (err) => resolve({ ok: false, error: err.message }),
      })
      upload.start()
    })
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

    // Files > 50MB use TUS chunked upload (bypasses Supabase non-resumable size limit)
    const useTus = file.size > 50 * 1024 * 1024

    let audioUrl: string

    if (useTus) {
      setUploadStatus('Uploading (chunked)...')
      const tusResult = await tusUpload(file, filename, contentType)
      if (!tusResult.ok) {
        setUploadStatus(`Error: ${tusResult.error ?? 'Upload failed'}`)
        setUploadPct(0)
        setUploading(false)
        return
      }
      // Build the public URL from the bucket and filename
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://mdefkqaawrusoaojstpq.supabase.co'
      audioUrl = `${supabaseUrl}/storage/v1/object/public/mf-audio/${filename}`
    } else {
      // Small files: signed URL direct to Supabase (fast, no Railway in the path)
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
        // If signed URL fails with 413, retry with TUS
        if (putResult.error?.includes('413') || putResult.error?.includes('exceeded the maximum')) {
          setUploadStatus('Retrying with chunked upload...')
          setUploadPct(0)
          const tusResult = await tusUpload(file, filename, contentType)
          if (!tusResult.ok) {
            setUploadStatus(`Error: ${tusResult.error ?? 'Upload failed'}`)
            setUploadPct(0)
            setUploading(false)
            return
          }
          const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://mdefkqaawrusoaojstpq.supabase.co'
          audioUrl = `${supabaseUrl}/storage/v1/object/public/mf-audio/${filename}`
        } else {
          setUploadStatus(`Error: ${putResult.error ?? 'Upload failed'}`)
          setUploadPct(0)
          setUploading(false)
          return
        }
      } else {
        audioUrl = urlData.publicUrl as string
      }
    }

    setUploadPct(85)
    setUploadStatus('Reading metadata...')

    let audioDuration: number | null = null
    try {
      audioDuration = await new Promise((resolve) => {
        const audio = new Audio(audioProxyUrl(audioUrl))
        // Only need duration — don't buffer the whole file we just uploaded.
        audio.preload = 'metadata'
        audio.addEventListener('loadedmetadata', () => resolve(Math.round(audio.duration)))
        audio.addEventListener('error', () => resolve(null))
        setTimeout(() => resolve(null), 8000)
      })
    } catch {
      audioDuration = null
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
        duration_seconds: audioDuration,
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
        setUploadPct(0)
        setUploadStatus('')
        setUploading(false)
        syncAfterMutation()
      }, 600)
    } else {
      setUploadStatus(`Error: ${newVersion.error ?? 'Unknown error'}`)
      setUploadPct(0)
      setUploading(false)
    }
  }

  async function restoreVersion(archivedVersion: VersionWithFeedback) {
    setRestoring(true)
    try {
      const res = await fetch('/api/versions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: project.id,
          audio_url: archivedVersion.audio_url,
          audio_filename: archivedVersion.audio_filename,
          duration_seconds: archivedVersion.duration_seconds,
          file_size_bytes: archivedVersion.file_size_bytes,
          label: archivedVersion.label,
        }),
      })
      if (res.ok) {
        const newVersion = await res.json()
        setVersions(prev => [{ ...newVersion, mb_feedback: [] }, ...prev])
        setArchivedOpen(false)
        syncAfterMutation()
      } else {
        flashError('Could not restore that mix — please try again.')
      }
    } catch {
      flashError('Could not restore that mix — check your connection.')
    } finally {
      setRestoring(false)
    }
  }

  async function summarizeFeedback(versionId: string) {
    setSummaryLoading(versionId)
    setSummaryError(prev => { const next = { ...prev }; delete next[versionId]; return next })
    try {
      const res = await fetch('/api/chat/summarize-feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version_id: versionId }),
      })
      const data = await res.json()
      if (!res.ok) {
        setSummaryError(prev => ({ ...prev, [versionId]: data.error ?? 'Failed to summarize' }))
        return
      }
      setSummaries(prev => ({ ...prev, [versionId]: data.summary as string }))
    } catch (err) {
      setSummaryError(prev => ({ ...prev, [versionId]: err instanceof Error ? err.message : 'Network error' }))
    } finally {
      setSummaryLoading(null)
    }
  }

  async function saveProject() {
    try {
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
        syncAfterMutation()
      } else {
        flashError('Could not save project details — please try again.')
      }
    } catch {
      flashError('Could not save project details — check your connection.')
    }
  }

  async function startRelease() {
    setStartingRelease(true)
    try {
      const res = await fetch('/api/releases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: projectForm.title || project.title, project_id: project.id }),
      })
      if (res.ok) {
        const data = await res.json()
        setRelease(data)
        syncAfterMutation()
      } else {
        flashError('Could not start the release — please try again.')
      }
    } catch {
      flashError('Could not start the release — check your connection.')
    } finally {
      setStartingRelease(false)
    }
  }

  async function toggleReleaseCheck(field: string, current: boolean) {
    if (!release) return
    // Optimistic toggle with rollback so the checkbox reflects the DB truth.
    setRelease(prev => prev ? { ...prev, [field]: !current } : prev)
    try {
      const res = await fetch(`/api/releases/${release.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: !current }),
      })
      if (!res.ok) {
        setRelease(prev => prev ? { ...prev, [field]: current } : prev)
        flashError('Could not update the checklist — reverted.')
      }
    } catch {
      setRelease(prev => prev ? { ...prev, [field]: current } : prev)
      flashError('Could not update the checklist — check your connection.')
    }
  }

  const releaseProgress = release
    ? Math.round((CHECKLIST_ITEMS.filter(c => release[c.key]).length / CHECKLIST_ITEMS.length) * 100)
    : 0

  // Current mix = highest version_number (index 0, sorted desc). Everything else is archived.
  const currentMix = versions[0] ?? null
  const archivedVersions = versions.slice(1)

  return (
    <div className={inModal ? '' : 'pt-14'}>
      {actionError && (
        <div
          className="fixed bottom-24 md:bottom-6 left-1/2 -translate-x-1/2 z-[60] px-4 py-2.5 rounded-xl text-sm font-medium shadow-lg"
          style={{ backgroundColor: 'var(--surface)', color: '#f87171', border: '1px solid var(--surface-2)' }}
          role="alert"
        >
          {actionError}
        </div>
      )}
      <div className={inModal ? 'max-w-4xl mx-auto px-5 sm:px-6 py-6 pb-16' : 'max-w-4xl mx-auto px-6 py-8 pb-36 md:pb-10'}>
        {!inModal && (
          <Link href="/dashboard" className="flex items-center gap-2 text-[var(--text-muted)] hover:text-[var(--text)] text-sm mb-6 transition-colors w-fit">
            <ArrowLeft size={14} />
            Dashboard
          </Link>
        )}

        {/* Project header */}
        <div className="flex gap-6 mb-8">
          <div className="flex-shrink-0 w-32">
            <ArtworkGenerator
              projectId={project.id}
              projectTitle={project.title}
              genre={project.genre}
              currentArtwork={artwork}
              currentFinalized={finalizedArtwork}
              onArtworkUpdated={handleArtworkUpdated}
              onFinalizedUpdated={handleFinalizedUpdated}
              showFinalize={false}
              showActions={false}
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

                {/* Project actions row */}
                <div className="flex items-center gap-2 mb-3 flex-wrap">
                  <AddToCollectionButton projectId={project.id} />
                  {project.share_token && (
                    <button
                      onClick={copyShareLink}
                      className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                        copied
                          ? 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20'
                          : 'text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)] border-[var(--border)]'
                      }`}
                    >
                      {copied ? <Check size={12} /> : <Share2 size={12} />}
                      {copied ? 'Copied!' : 'Share'}
                    </button>
                  )}
                  <button
                    onClick={deleteProject}
                    disabled={deletingProject}
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-[var(--border)] text-[var(--text-muted)] hover:text-red-400 hover:border-red-400/30 transition-colors disabled:opacity-40"
                  >
                    <Trash2 size={12} />
                    {deletingProject ? 'Deleting…' : 'Delete'}
                  </button>
                </div>
              </>
            )}
            <StatusPipeline currentStatus={projectStatus} />
          </div>
        </div>

        {/* Tab bar */}
        <div className="flex gap-1 mb-6 border-b" style={{ borderColor: 'var(--surface-2)' }}>
          {(['versions', 'artwork', 'visualizer', 'video'] as const).map(tab => (
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
              {tab === 'artwork' ? 'Artwork' : tab === 'visualizer' ? 'Visualizer' : tab === 'video' ? 'Video' : 'Song Info'}
            </button>
          ))}
        </div>

        {/* Tab content — Mixes */}
        {activeTab === 'versions' && (
          <div>

            {/* Upload button */}
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
                aria-label="Upload a new mix audio file"
                onChange={handleFileSelect}
              />
            </div>

            {/* Current mix */}
            {currentMix === null ? (
              <div className="text-center py-16 text-[var(--text-muted)]">
                <Music size={32} className="mx-auto mb-3 text-[#2a2a2a]" />
                <p className="text-sm">No mixes yet — upload your first mix above</p>
              </div>
            ) : (
              <CurrentMixCard
                version={currentMix}
                projectTitle={projectForm.title || project.title}
                artwork={artwork}
                currentUrl={currentUrl}
                currentTime={currentTime}
                duration={duration}
                isPlaying={isPlaying}
                seek={seek}
                togglePlay={togglePlay}
                playUrl={playUrl}
                savedNoteKey={savedNoteKey}
                summaries={summaries}
                summaryLoading={summaryLoading}
                summaryError={summaryError}
                onUpdateStatus={updateStatus}
                onUpdateNotes={updateNotes}
                onSummarizeFeedback={summarizeFeedback}
                parseMixLabel={parseMixLabel}
              />
            )}

            {/* Restore older mix */}
            {archivedVersions.length > 0 && (
              <div className="mt-5">
                <button
                  onClick={() => setArchivedOpen(true)}
                  className="flex items-center gap-2 text-xs text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
                >
                  <History size={13} />
                  Restore older mix ({archivedVersions.length} archived)
                </button>
              </div>
            )}

            {/* Release Pipeline */}
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
                <button
                  onClick={startRelease}
                  disabled={startingRelease}
                  className="flex items-center gap-2 bg-[#2dd4bf] hover:bg-[#14b8a6] disabled:opacity-40 text-[#0a0a0a] text-sm font-semibold px-5 py-2.5 rounded-xl transition-colors"
                >
                  <Plus size={15} />
                  {startingRelease ? 'Creating…' : 'Start Release Pipeline'}
                </button>
              )}
            </div>

          </div>
        )}

        {/* Tab content — Artwork */}
        {activeTab === 'artwork' && (
          <div className="max-w-2xl">
            <ArtworkGenerator
              projectId={project.id}
              projectTitle={project.title}
              genre={project.genre}
              currentArtwork={artwork}
              currentFinalized={finalizedArtwork}
              onArtworkUpdated={handleArtworkUpdated}
              onFinalizedUpdated={handleFinalizedUpdated}
            />
          </div>
        )}

        {/* Tab content — Visualizer */}
        {activeTab === 'visualizer' && (
          <Visualizer
            projectId={project.id}
            projectTitle={project.title}
            artworkUrl={artwork}
            visualizerUrl={visualizer}
            onVisualizerUpdated={handleVisualizerUpdated}
            wideVisualizerUrl={visualizerWide}
            onWideVisualizerUpdated={handleWideVisualizerUpdated}
            onSwitchToArtwork={() => switchTab('artwork')}
          />
        )}

        {/* Tab content — Video (finished full-length / Short renders) */}
        {activeTab === 'video' && (
          <VideoFinalizer
            projectId={project.id}
            visualizerUrl={visualizer}
            wideVisualizerUrl={visualizerWide}
            hasAudio={versions.length > 0}
            audioDurationSec={versions[0]?.duration_seconds ?? null}
            onSwitchToVisualizer={() => switchTab('visualizer')}
          />
        )}

      </div>

      {/* Archived mixes modal */}
      {archivedOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0,0,0,0.75)' }}
          onClick={e => { if (e.target === e.currentTarget) setArchivedOpen(false) }}
        >
          <div className="w-full max-w-md rounded-2xl overflow-hidden" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}>
            <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
              <h3 className="text-sm font-semibold text-[var(--text)]">Archived Mixes</h3>
              <button onClick={() => setArchivedOpen(false)} className="text-[var(--text-muted)] hover:text-[var(--text)] transition-colors">
                <X size={16} />
              </button>
            </div>
            <div className="overflow-y-auto max-h-96 divide-y" style={{ borderColor: 'var(--border)' }}>
              {archivedVersions.map(av => (
                <div key={av.id} className="flex items-center gap-4 px-5 py-4 hover:bg-[var(--surface-2)] transition-colors">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-[var(--text)]">
                      {av.label || parseMixLabel(av.audio_filename ?? '') || `Mix ${av.version_number}`}
                    </p>
                    <div className="flex items-center gap-2 mt-0.5 text-xs text-[var(--text-muted)]">
                      <span>{new Date(av.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                      {av.duration_seconds && <span>{formatDuration(av.duration_seconds)}</span>}
                      {av.file_size_bytes && <span>{formatFileSize(av.file_size_bytes)}</span>}
                    </div>
                  </div>
                  <StatusBadge status={av.status} size="sm" />
                  <a
                    href={`${audioProxyUrl(av.audio_url)}?download=1&filename=${encodeURIComponent(av.audio_filename ?? 'mix.wav')}`}
                    download={av.audio_filename ?? 'mix.wav'}
                    className="text-[var(--text-muted)] hover:text-[var(--text)] transition-colors flex-shrink-0"
                    title={`Download original file${av.audio_filename ? ` (${av.audio_filename})` : ''}`}
                  >
                    <Download size={13} />
                  </a>
                  <button
                    onClick={() => restoreVersion(av)}
                    disabled={restoring}
                    className="text-xs font-medium text-[#2dd4bf] hover:text-[#5eead4] disabled:opacity-50 disabled:cursor-wait transition-colors flex-shrink-0"
                  >
                    {restoring ? 'Restoring…' : 'Restore'}
                  </button>
                </div>
              ))}
            </div>
            <div className="px-5 py-3 border-t" style={{ borderColor: 'var(--border)' }}>
              <p className="text-[11px] text-[var(--text-muted)]">Restoring a mix makes it the current version. The old one stays in this archive.</p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Current mix card ─────────────────────────────────────────────────────────

type CurrentMixCardProps = {
  version: VersionWithFeedback
  projectTitle: string
  artwork: string | null
  currentUrl: string | null
  currentTime: number
  duration: number
  isPlaying: boolean
  seek: (t: number) => void
  togglePlay: () => void
  playUrl: (url: string, title: string, artist?: string, artwork?: string, label?: string, startAt?: number) => void
  savedNoteKey: string | null
  summaries: Record<string, string>
  summaryLoading: string | null
  summaryError: Record<string, string>
  onUpdateStatus: (id: string, status: Version['status']) => void
  onUpdateNotes: (id: string, field: 'private_notes' | 'public_notes', value: string) => void
  onSummarizeFeedback: (id: string) => void
  parseMixLabel: (filename: string) => string | null
}

function CurrentMixCard({
  version, projectTitle, artwork,
  currentUrl, currentTime, duration, isPlaying, seek, togglePlay, playUrl,
  savedNoteKey, summaries, summaryLoading, summaryError,
  onUpdateStatus, onUpdateNotes, onSummarizeFeedback, parseMixLabel,
}: CurrentMixCardProps) {
  const vUrl = audioProxyUrl(version.audio_url)
  const isActive = currentUrl === vUrl
  const vPct = isActive && duration > 0 ? (currentTime / duration) * 100 : 0
  const displayDuration = isActive ? duration : (version.duration_seconds ?? 0)
  const feedback = version.mb_feedback ?? []
  const ratedFeedback = feedback.filter(f => f.rating)
  const avgRating = ratedFeedback.length > 0
    ? (ratedFeedback.reduce((s, f) => s + f.rating!, 0) / ratedFeedback.length).toFixed(1)
    : null
  const label = version.label || parseMixLabel(version.audio_filename ?? '') || `Mix ${version.version_number}`

  // Jump the shared player to a timestamped piece of feedback. If this mix is
  // already playing, seek in place; otherwise start it at that position.
  const goToTimestamp = (t: number) => {
    if (isActive) seek(t)
    else playUrl(vUrl, projectTitle, undefined, artwork ?? undefined, label, t)
  }

  // Copy Markdown to the clipboard, flashing a "Copied!" confirmation; where the
  // Clipboard API is unavailable (some webviews / non-secure contexts) fall back
  // to downloading it as a .md file so the export still works inside the iOS
  // wrapper. Shared by all three feedback exports below.
  const copyMarkdown = async (md: string, filename: string, onCopied: () => void) => {
    try {
      await navigator.clipboard.writeText(md)
      onCopied()
    } catch {
      const blob = new Blob([md], { type: 'text/markdown' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
    }
  }
  const flash = (set: (v: boolean) => void) => () => {
    set(true)
    setTimeout(() => set(false), 2000)
  }

  // Export feedback as a Markdown "punch list" (timestamped notes first, ordered
  // by their moment in the track) the musician can paste straight into a DAW
  // session or a doc.
  const [copiedPunch, setCopiedPunch] = useState(false)
  const copyPunchList = () =>
    copyMarkdown(buildPunchList(`${projectTitle} — ${label}`, feedback), `${label} — punch list.md`, flash(setCopiedPunch))

  // Export the AI feedback summary as Markdown so the model's read of the room
  // can leave the app (session doc, message to a collaborator, release notes).
  const [copiedSummary, setCopiedSummary] = useState(false)
  const copySummary = () => {
    const summary = summaries[version.id]
    if (!summary) return
    copyMarkdown(buildSummaryExport(`${projectTitle} — ${label}`, summary, feedback), `${label} — AI summary.md`, flash(setCopiedSummary))
  }

  // Export the combined "mix report" — AI summary + punch list in one document —
  // the single thing a musician carries into a session or hands a collaborator.
  // Degrades to a plain punch list when no summary has been generated yet.
  const [copiedReport, setCopiedReport] = useState(false)
  const copyMixReport = () =>
    copyMarkdown(buildMixReport(`${projectTitle} — ${label}`, summaries[version.id] ?? '', feedback), `${label} — mix report.md`, flash(setCopiedReport))

  // Pinned-feedback markers on the scrubber. Each timestamped comment becomes a
  // dot on the timeline (orange ≤3★, cyan ≥4★, muted if unrated) — hover for the
  // note, click to seek. Needs a known duration to place dots, so it's hidden
  // until the mix is active or we have its stored length.
  const markerColor = (rating: number | null | undefined) =>
    rating == null ? 'var(--text-muted)' : rating <= 3 ? '#fb923c' : '#2dd4bf'
  const markers = displayDuration > 0
    ? feedback
        .filter(f => f.timestamp_seconds != null)
        .map(f => ({ f, pct: Math.min(100, Math.max(0, (f.timestamp_seconds! / displayDuration) * 100)) }))
    : []

  return (
    <div className="rounded-2xl overflow-hidden" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}>

      {/* ── Header row ── */}
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-[var(--text)]">{label}</span>
          <span className="text-[10px] text-[#2dd4bf] bg-[#2dd4bf]/10 px-1.5 py-0.5 rounded-full leading-none">Current</span>
          <span className="text-[var(--border)]">·</span>
          <span className="text-xs text-[var(--text-muted)]">
            {new Date(version.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          </span>
          {version.duration_seconds != null && (
            <><span className="text-[var(--border)]">·</span><span className="text-xs text-[var(--text-muted)]">{formatDuration(version.duration_seconds)}</span></>
          )}
          {version.file_size_bytes != null && (
            <><span className="text-[var(--border)]">·</span><span className="text-xs text-[var(--text-muted)]">{formatFileSize(version.file_size_bytes)}</span></>
          )}
          {feedback.length > 0 && (
            <><span className="text-[var(--border)]">·</span>
            <span className="text-xs text-[var(--text-muted)] flex items-center gap-1">
              <MessageSquare size={10} />{feedback.length}{avgRating ? ` · ★ ${avgRating}` : ''}
            </span></>
          )}
        </div>
        <StatusBadge status={version.status} size="sm" />
      </div>

      {/* ── Body ── */}
      <div className="px-4 pb-4 pt-3 space-y-4" style={{ borderTop: '1px solid var(--border)' }}>

        {/* Player */}
        <div>
          <div
            className="relative w-full h-8 rounded-lg overflow-hidden mb-2"
            style={{ backgroundColor: 'var(--input-bg)' }}
          >
            <div
              className="absolute bottom-0 left-0 h-0.5 transition-all duration-100"
              style={{ backgroundColor: 'var(--accent)', width: `${vPct}%` }}
            />
            <input
              type="range" min={0} max={displayDuration || 1} step={0.1}
              value={isActive ? currentTime : 0}
              onChange={e => {
                if (isActive) seek(Number(e.target.value))
                else playUrl(vUrl, projectTitle, undefined, artwork ?? undefined, label)
              }}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
            {markers.map(({ f, pct }) => (
              <button
                key={f.id}
                type="button"
                onClick={e => { e.stopPropagation(); goToTimestamp(f.timestamp_seconds!) }}
                aria-label={`${f.reviewer_name} at ${formatDuration(f.timestamp_seconds)}: ${f.comment}`}
                title={`${f.reviewer_name}${f.rating ? ` · ${f.rating}★` : ''} @ ${formatDuration(f.timestamp_seconds)}\n${f.comment}`}
                className="absolute bottom-0 z-10 w-2 h-2 -translate-x-1/2 rounded-full ring-1 ring-black/40 hover:scale-150 transition-transform cursor-pointer"
                style={{ left: `${pct}%`, backgroundColor: markerColor(f.rating) }}
              />
            ))}
          </div>
          <div className="flex items-center gap-2.5">
            <button
              onClick={() => {
                if (isActive) togglePlay()
                else playUrl(vUrl, projectTitle, undefined, artwork ?? undefined, label)
              }}
              className="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-full transition-colors"
              style={{ backgroundColor: 'var(--surface-2)', border: '1px solid var(--surface-3)', color: 'var(--text)' }}
            >
              {isActive && isPlaying ? <Pause size={12} /> : <Play size={12} />}
            </button>
            <span className="text-xs tabular-nums text-[var(--text-muted)]">
              {formatDuration(isActive ? currentTime : 0)} / {formatDuration(displayDuration || null)}
            </span>
            <div className="flex-1" />
            {/* Owner can always re-download the original upload (e.g. to submit
                the WAV to a distributor) — ?download=1 makes the audio proxy
                stream it as an attachment under its original filename. */}
            <a
              href={`${vUrl}?download=1&filename=${encodeURIComponent(version.audio_filename ?? 'mix.wav')}`}
              download={version.audio_filename ?? 'mix.wav'}
              className="flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
              title={`Download original file${version.audio_filename ? ` (${version.audio_filename})` : ''}`}
            >
              <Download size={13} />
              Original
            </a>
          </div>
        </div>

        {version.change_log && (
          <p className="text-xs text-[var(--text-muted)] px-3 py-2 rounded-lg" style={{ backgroundColor: 'var(--surface-2)' }}>
            {version.change_log}
          </p>
        )}

        {/* Status */}
        <div className="flex gap-1.5 flex-wrap">
          {STATUSES.map(s => {
            const conf = STATUS_CONFIG[s]
            const active = version.status === s
            return (
              <button key={s} onClick={() => onUpdateStatus(version.id, s)}
                className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${
                  active
                    ? `${conf.color} ${conf.bg} ${conf.border}`
                    : 'text-[var(--text-muted)] border-[var(--border)] hover:text-[var(--text-secondary)]'
                }`}
              >{conf.label}</button>
            )
          })}
        </div>

        {/* Notes */}
        <div className="grid grid-cols-2 gap-3">
          {(['private_notes', 'public_notes'] as const).map(field => (
            <div key={field}>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[11px] text-[var(--text-muted)]">
                  {field === 'private_notes' ? 'Private notes' : 'Public notes'}
                </label>
                {savedNoteKey === `${version.id}-${field}` && (
                  <span className="text-[10px] text-emerald-400 flex items-center gap-0.5"><Check size={9} /> Saved</span>
                )}
              </div>
              <textarea
                defaultValue={version[field] ?? ''}
                onBlur={e => onUpdateNotes(version.id, field, e.target.value)}
                placeholder={field === 'private_notes' ? 'Your notes…' : 'Visible to listeners…'}
                aria-label={field === 'private_notes' ? 'Private notes' : 'Public notes'}
                rows={2}
                className="w-full rounded-lg px-3 py-2 text-xs text-[var(--text)] focus:outline-none resize-none"
                style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)' }}
              />
            </div>
          ))}
        </div>

        {/* Feedback */}
        {feedback.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] text-[var(--text-muted)]">Feedback</span>
              <div className="flex items-center gap-3">
                <button
                  onClick={copyPunchList}
                  title="Copy feedback as a timestamp-ordered punch list"
                  className="flex items-center gap-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
                >
                  {copiedPunch ? <Check size={10} /> : <ClipboardList size={10} />}
                  {copiedPunch ? 'Copied!' : 'Punch list'}
                </button>
                {summaries[version.id] && (
                  <button
                    onClick={copyMixReport}
                    title="Copy the AI summary and punch list together as one mix report"
                    className="flex items-center gap-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
                  >
                    {copiedReport ? <Check size={10} /> : <FileText size={10} />}
                    {copiedReport ? 'Copied!' : 'Mix report'}
                  </button>
                )}
                <button
                  onClick={() => onSummarizeFeedback(version.id)}
                  disabled={summaryLoading === version.id}
                  className="flex items-center gap-1 text-[11px] text-[#2dd4bf] hover:text-[#5eead4] disabled:opacity-50 transition-colors"
                >
                  <Sparkles size={10} />
                  {summaryLoading === version.id ? 'Summarizing…' : summaries[version.id] ? 'Re-summarize' : 'Summarize with AI'}
                </button>
              </div>
            </div>
            {summaryError[version.id] && <p className="text-xs text-red-400 mb-2">{summaryError[version.id]}</p>}
            {summaries[version.id] && (
              <div className="rounded-xl p-3 mb-2" style={{ backgroundColor: 'var(--surface-2)', border: '1px solid #2dd4bf22' }}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-1.5">
                    <Sparkles size={10} className="text-[#2dd4bf]" />
                    <span className="text-[10px] uppercase tracking-wide text-[#2dd4bf]">AI Summary</span>
                  </div>
                  <button
                    onClick={copySummary}
                    title="Copy the AI summary as Markdown"
                    className="flex items-center gap-1 text-[10px] text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
                  >
                    {copiedSummary ? <Check size={10} /> : <Copy size={10} />}
                    {copiedSummary ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <SummaryView markdown={summaries[version.id]} />
              </div>
            )}
            <div className="space-y-1.5">
              {feedback.map(f => (
                <div key={f.id} className="rounded-xl px-3 py-2.5" style={{ backgroundColor: 'var(--surface-2)' }}>
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-xs font-medium text-[var(--text-secondary)] truncate">{f.reviewer_name}</span>
                      {f.timestamp_seconds != null && (
                        <button
                          type="button"
                          onClick={() => goToTimestamp(f.timestamp_seconds!)}
                          title={`Play from ${formatDuration(f.timestamp_seconds)}`}
                          className="inline-flex items-center gap-1 text-[10px] text-[#2dd4bf] bg-[#2dd4bf]/10 hover:bg-[#2dd4bf]/20 rounded-full px-1.5 py-0.5 leading-none transition-colors flex-shrink-0"
                        >
                          <Play size={8} className="fill-[#2dd4bf]" />
                          {formatDuration(f.timestamp_seconds)}
                        </button>
                      )}
                    </div>
                    {f.rating && (
                      <div className="flex gap-0.5">
                        {[1,2,3,4,5].map(s => (
                          <Star key={s} size={9} className={s <= f.rating! ? 'text-[#2dd4bf] fill-[#2dd4bf]' : 'text-[var(--text-muted)]'} />
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
      </div>
    </div>
  )
}

// ── Lightweight Markdown renderer for AI summaries ────────────────────────────

function SummaryView({ markdown }: { markdown: string }) {
  const lines = markdown.split('\n')
  const blocks: ReactNode[] = []
  let bulletGroup: string[] = []

  function flushBullets() {
    if (bulletGroup.length === 0) return
    blocks.push(
      <ul key={`ul-${blocks.length}`} className="list-disc pl-4 space-y-1 mb-2">
        {bulletGroup.map((b, i) => (
          <li key={i} className="text-xs text-[var(--text-secondary)]">{renderInline(b)}</li>
        ))}
      </ul>,
    )
    bulletGroup = []
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) { flushBullets(); continue }
    if (line.startsWith('## ')) {
      flushBullets()
      blocks.push(
        <p key={`h-${blocks.length}`} className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text)] mt-2 mb-1">
          {line.slice(3)}
        </p>,
      )
    } else if (line.startsWith('- ')) {
      bulletGroup.push(line.slice(2))
    } else {
      flushBullets()
      blocks.push(
        <p key={`p-${blocks.length}`} className="text-xs text-[var(--text-secondary)] mb-2">
          {renderInline(line)}
        </p>,
      )
    }
  }
  flushBullets()
  return <>{blocks}</>
}

function renderInline(text: string): ReactNode {
  const parts = text.split(/(_[^_]+_)/g)
  return parts.map((part, i) => {
    if (part.startsWith('_') && part.endsWith('_') && part.length > 2) {
      return <em key={i} className="text-[var(--text-muted)]">{part.slice(1, -1)}</em>
    }
    return <span key={i}>{part}</span>
  })
}
