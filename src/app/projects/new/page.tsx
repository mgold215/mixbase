'use client'

import { useState, useRef, type FormEvent, type ChangeEvent } from 'react'
import { useRouter } from 'next/navigation'
import Nav from '@/components/Nav'
import { ArrowLeft, Upload, Music, Trash2 } from 'lucide-react'
import Link from 'next/link'
import { analyzeFile } from '@/lib/audio-analysis'
import { audioProxyUrl } from '@/lib/supabase'

const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
               'Cm', 'C#m', 'Dm', 'D#m', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'A#m', 'Bm']

export default function NewProjectPage() {
  const router = useRouter()
  const [form, setForm] = useState({ title: '', genre: '', bpm: '', key_signature: '' })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Upload state
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [detectingMeta, setDetectingMeta] = useState(false)
  const [uploadPct, setUploadPct] = useState(0)
  const [uploadStatus, setUploadStatus] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  function set(field: string, value: string) {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  // When a file is picked, auto-detect BPM and key
  async function handleFileSelect(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setSelectedFile(file)
    setUploadStatus('')
    setDetectingMeta(true)
    const result = await analyzeFile(file)
    if (result) {
      setForm(p => ({
        ...p,
        bpm: result.bpm.toString(),
        key_signature: result.key,
      }))
    }
    setDetectingMeta(false)
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!form.title.trim()) return
    setLoading(true)
    setError('')
    setUploadPct(0)

    // Step 1: Create the project
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: form.title,
        genre: form.genre || null,
        bpm: form.bpm ? parseInt(form.bpm) : null,
        key_signature: form.key_signature || null,
      }),
    })

    const project = await res.json()
    if (!res.ok) {
      setError(project.error ?? 'Something went wrong')
      setLoading(false)
      return
    }

    // If no file selected, just redirect to the project page
    if (!selectedFile) {
      router.push(`/projects/${project.id}`)
      return
    }

    // Step 2: Upload the audio file directly to Supabase via signed URL
    if (selectedFile.size > 2 * 1024 * 1024 * 1024) {
      setError('File too large (max 2GB)')
      setLoading(false)
      return
    }

    setUploadStatus('Uploading...')

    const ext = selectedFile.name.split('.').pop()
    const filename = `${project.id}/${Date.now()}.${ext}`

    const mimeByExt: Record<string, string> = {
      wav: 'audio/wav', wave: 'audio/wav', aif: 'audio/aiff', aiff: 'audio/aiff',
      mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', ogg: 'audio/ogg',
    }
    const fileExt = (selectedFile.name.split('.').pop() ?? '').toLowerCase()
    const contentType = selectedFile.type || mimeByExt[fileExt] || 'application/octet-stream'

    const urlRes = await fetch('/api/upload-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, contentType, project_id: project.id }),
    })
    const urlData = await urlRes.json()
    if (!urlRes.ok) {
      setError(urlData.error ?? 'Could not get upload URL')
      setLoading(false)
      return
    }

    // Upload file directly to Supabase with progress tracking
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
      setError(putResult.error ?? 'Upload failed')
      setLoading(false)
      return
    }

    const audioUrl = urlData.publicUrl as string
    setUploadPct(85)
    setUploadStatus('Reading metadata...')

    // Read duration from the uploaded file
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

    // Step 3: Create the first version
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

    if (versionRes.ok) {
      setUploadPct(100)
      setUploadStatus('Done!')
      setTimeout(() => router.push(`/projects/${project.id}`), 400)
    } else {
      const err = await versionRes.json()
      setError(err.error ?? 'Failed to save version')
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen" style={{ backgroundColor: 'var(--bg-page)' }}>
      <Nav />
      <div className="pt-14">
        <div className="max-w-lg mx-auto px-6 py-12">
          <Link href="/dashboard" className="flex items-center gap-2 text-sm mb-8 transition-colors w-fit"
            style={{ color: 'var(--text-muted)' }}>
            <ArrowLeft size={14} />
            Back
          </Link>

          <h1 className="text-2xl font-bold mb-1" style={{ color: 'var(--text)' }}>New Project</h1>
          <p className="text-sm mb-8" style={{ color: 'var(--text-muted)' }}>Upload a track to start tracking your mix versions</p>

          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Audio file upload — first thing in the form */}
            <div>
              <label className="block text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>
                Audio File
              </label>
              {!selectedFile ? (
                <label className="block border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors"
                  style={{ borderColor: 'var(--border)' }}
                  onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
                  onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--border)')}>
                  <Upload size={24} className="mx-auto mb-2" style={{ color: 'var(--text-muted)' }} />
                  <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Tap to choose audio file</p>
                  <p className="text-xs mt-1" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>WAV, AIFF recommended · MP3 at 320kbps+ · Max 2GB</p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="audio/*,.wav,.mp3,.aiff,.aif,.flac,.m4a,.ogg"
                    className="sr-only"
                    onChange={handleFileSelect}
                  />
                </label>
              ) : (
                <div className="flex items-center gap-3 rounded-xl px-4 py-3"
                  style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)' }}>
                  <Music size={16} style={{ color: 'var(--accent)' }} className="flex-shrink-0" />
                  <span className="text-sm truncate flex-1" style={{ color: 'var(--text)' }}>{selectedFile.name}</span>
                  <span className="text-xs flex-shrink-0" style={{ color: 'var(--text-muted)' }}>{(selectedFile.size / (1024 * 1024)).toFixed(1)} MB</span>
                  {detectingMeta && <span className="text-[10px] animate-pulse flex-shrink-0" style={{ color: 'var(--accent)' }}>detecting BPM & key…</span>}
                  {!loading && (
                    <button
                      type="button"
                      onClick={() => { setSelectedFile(null); if (fileInputRef.current) fileInputRef.current.value = '' }}
                      className="flex-shrink-0 transition-colors hover:text-red-400"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              )}
            </div>

            <div>
              <label className="block text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>Track Title <span style={{ color: 'var(--accent)' }}>*</span></label>
              <input
                type="text"
                value={form.title}
                onChange={e => set('title', e.target.value)}
                placeholder="e.g. After Dark"
                autoFocus
                className="w-full rounded-xl px-4 py-3 focus:outline-none transition-colors"
                style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>Genre</label>
                <input
                  type="text"
                  value={form.genre}
                  onChange={e => set('genre', e.target.value)}
                  placeholder="e.g. R&B, Afrobeat"
                  className="w-full rounded-xl px-4 py-3 focus:outline-none transition-colors"
                  style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
                />
              </div>
              <div>
                <label className="block text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>BPM</label>
                <input
                  type="number"
                  value={form.bpm}
                  onChange={e => set('bpm', e.target.value)}
                  placeholder="e.g. 98"
                  min={40}
                  max={300}
                  className="w-full rounded-xl px-4 py-3 focus:outline-none transition-colors"
                  style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
                />
              </div>
            </div>

            <div>
              <label className="block text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>Key</label>
              <select
                value={form.key_signature}
                onChange={e => set('key_signature', e.target.value)}
                className="w-full rounded-xl px-4 py-3 focus:outline-none appearance-none transition-colors"
                style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
              >
                <option value="" style={{ backgroundColor: 'var(--input-bg)' }}>Select key</option>
                {KEYS.map(k => (
                  <option key={k} value={k} style={{ backgroundColor: 'var(--input-bg)' }}>{k}</option>
                ))}
              </select>
            </div>

            {/* Upload progress */}
            {uploadStatus && (
              <div>
                <div className="flex justify-between text-xs mb-1.5">
                  <span style={{ color: 'var(--accent)' }}>{uploadStatus}</span>
                  <span style={{ color: 'var(--text-muted)' }}>{uploadPct}%</span>
                </div>
                <div className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--surface-2)' }}>
                  <div
                    className="h-full rounded-full transition-all duration-300"
                    style={{ backgroundColor: uploadPct === 100 ? '#34d399' : 'var(--accent)', width: `${uploadPct}%` }}
                  />
                </div>
              </div>
            )}

            {error && <p className="text-red-400 text-sm">{error}</p>}

            <button
              type="submit"
              disabled={loading || !form.title.trim()}
              className="w-full font-semibold rounded-xl py-3 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ backgroundColor: 'var(--accent)', color: 'var(--bg)' }}
            >
              {loading
                ? (uploadStatus || 'Creating...')
                : selectedFile
                  ? 'Create Project & Upload'
                  : 'Create Project'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
