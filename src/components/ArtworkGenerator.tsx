'use client'

import { useState, type ChangeEvent } from 'react'
import { Sparkles, Upload, X, Wand2 } from 'lucide-react'
import Image from 'next/image'

type Props = {
  projectId: string
  projectTitle: string
  genre?: string | null
  currentArtwork?: string | null
  currentFinalized?: string | null
  onArtworkUpdated: (url: string) => void
  onFinalizedUpdated: (url: string | null) => void
  // Finalize is a heavier action (Vision call + render) — keep it on the
  // dedicated Artwork tab, not on every embedded preview of this component.
  showFinalize?: boolean
}

export default function ArtworkGenerator({
  projectId, projectTitle, genre,
  currentArtwork, currentFinalized,
  onArtworkUpdated, onFinalizedUpdated,
  showFinalize = true,
}: Props) {
  const [mode, setMode] = useState<'idle' | 'generate' | 'upload'>('idle')
  const [prompt, setPrompt] = useState(`realistic tape cassette fused into futuristic dystopian techno infrastructure, Inception-style folding brutalist megastructures, dark neon-lit corridors, hyper-detailed photorealistic render, cinematic lighting, no text — ${projectTitle}${genre ? `, ${genre}` : ''}`)
  const [model, setModel] = useState<'flux' | 'imagen'>('flux')
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')
  const [finalizing, setFinalizing] = useState(false)
  const [guidance, setGuidance] = useState('')

  // Source artwork (Generate / Upload result) — what the renderer reads.
  const sourceUrl = currentArtwork ?? null
  // Preview prefers the finalized render when present so the user sees the
  // exported version. If they Generate or Upload again the parent clears
  // currentFinalized and we fall back to the new source.
  const previewUrl = currentFinalized ?? sourceUrl

  async function handleFinalize() {
    if (!sourceUrl) return
    setFinalizing(true)
    setError('')
    const res = await fetch('/api/finalize-artwork', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: projectId,
        artist: 'moodmixformat',
        guidance: guidance.trim() || undefined,
      }),
    })
    const data = await res.json()
    if (res.ok && data.finalized_artwork_url) {
      onFinalizedUpdated(data.finalized_artwork_url)
    } else {
      setError(data.error ?? 'Finalize failed. Try again.')
    }
    setFinalizing(false)
  }

  async function handleGenerate() {
    setGenerating(true)
    setError('')

    const res = await fetch('/api/generate-artwork', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, prompt, model, title: projectTitle }),
    })

    const data = await res.json()
    if (res.ok && data.artwork_url) {
      onArtworkUpdated(data.artwork_url)
      // Server cleared finalized_artwork_url; mirror that in client state.
      onFinalizedUpdated(null)
      setMode('idle')
    } else {
      setError(data.error ?? 'Generation failed. Try again.')
    }
    setGenerating(false)
  }

  async function handleUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    const formData = new FormData()
    formData.append('file', file)
    formData.append('project_id', projectId)
    formData.append('type', 'artwork')

    const res = await fetch('/api/upload-audio', { method: 'POST', body: formData })
    const data = await res.json()
    if (res.ok && data.url) {
      // Persist artwork URL to DB — PATCH also nulls finalized_artwork_url.
      await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ artwork_url: data.url }),
      })
      onArtworkUpdated(data.url)
      onFinalizedUpdated(null)
      setMode('idle')
    } else {
      setError(data.error ?? 'Upload failed. Try again.')
    }
    // Reset the file input so re-uploading the same filename still triggers onChange
    e.target.value = ''
  }

  return (
    <div className="space-y-3">
      {/* Current artwork preview */}
      <div className="relative w-full aspect-square rounded-xl overflow-hidden bg-[#111] border border-[#1e1e1e]">
        {previewUrl ? (
          <Image src={previewUrl} alt="Project artwork" fill className="object-cover" />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center">
              <div className="w-12 h-12 rounded-full bg-[#1a1a1a] flex items-center justify-center mx-auto mb-2">
                <Sparkles size={20} className="text-[#444]" />
              </div>
              <p className="text-xs text-[#444]">No artwork</p>
            </div>
          </div>
        )}
      </div>

      {/* Action buttons */}
      {mode === 'idle' && (
        <div className="flex gap-2">
          <button
            onClick={() => setMode('generate')}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 text-xs font-semibold bg-[#2dd4bf] text-[#0a0a0a] rounded-xl hover:bg-[#14b8a6] transition-colors"
          >
            <Sparkles size={13} />
            Generate with AI
          </button>
          <label className="flex-1 flex items-center justify-center gap-2 py-2.5 text-xs font-semibold bg-[#1e1e1e] border border-[#333] text-white rounded-xl hover:bg-[#2a2a2a] transition-colors cursor-pointer">
            <Upload size={13} />
            Upload
            <input type="file" accept="image/*" onChange={handleUpload} className="hidden" />
          </label>
        </div>
      )}


      {/* Finalize button + guidance — gated on showFinalize so the project
          header thumbnail doesn't expose this heavy action. */}
      {showFinalize && mode === 'idle' && previewUrl && (
        <div className="space-y-2">
          <textarea
            value={guidance}
            onChange={e => setGuidance(e.target.value)}
            rows={2}
            placeholder="Optional notes for placement (e.g. &quot;put text at the top&quot;, &quot;avoid the cassette&quot;, &quot;keep it minimal&quot;)"
            className="w-full bg-[#0f0f0f] border border-[#222] rounded-xl px-3 py-2 text-xs text-white placeholder-[#444] focus:outline-none focus:border-[#2dd4bf]/40 resize-none"
          />
          <button
            onClick={handleFinalize}
            disabled={finalizing}
            className="w-full flex items-center justify-center gap-2 py-2.5 text-xs font-semibold bg-[#0f0f0f] border border-[#2dd4bf]/40 text-[#2dd4bf] rounded-xl hover:bg-[#2dd4bf]/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {finalizing ? (
              <>
                <span className="w-3 h-3 border border-[#2dd4bf]/30 border-t-[#2dd4bf] rounded-full animate-spin" />
                Finalizing...
              </>
            ) : (
              <>
                <Wand2 size={13} />
                Finalize Artwork
              </>
            )}
          </button>
        </div>
      )}
      {/* Generate mode */}
      {mode === 'generate' && (
        <div className="space-y-2">
          {/* Model selector */}
          <div className="flex gap-1 p-0.5 bg-[#0f0f0f] border border-[#222] rounded-xl">
            {(['flux', 'imagen'] as const).map(m => (
              <button
                key={m}
                onClick={() => setModel(m)}
                className={`flex-1 py-1.5 text-[10px] font-medium rounded-lg transition-colors ${
                  model === m ? 'bg-[#2dd4bf]/20 text-[#2dd4bf]' : 'text-[#555] hover:text-[#888]'
                }`}
              >
                {m === 'flux' ? 'Flux 2 Pro' : 'Imagen 4'}
              </button>
            ))}
          </div>
          <textarea
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            rows={3}
            placeholder="Describe the artwork..."
            className="w-full bg-[#0f0f0f] border border-[#222] rounded-xl px-3 py-2 text-xs text-white placeholder-[#444] focus:outline-none focus:border-[#2dd4bf]/40 resize-none"
          />
          {error && <p className="text-red-400 text-xs">{error}</p>}
          <div className="flex gap-2">
            <button
              onClick={handleGenerate}
              disabled={generating || !prompt.trim()}
              className="flex-1 py-2 text-xs bg-[#2dd4bf] hover:bg-[#14b8a6] disabled:opacity-40 disabled:cursor-not-allowed text-[#0a0a0a] rounded-xl transition-colors font-medium"
            >
              {generating ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-3 h-3 border border-white/30 border-t-white rounded-full animate-spin" />
                  Generating...
                </span>
              ) : 'Generate'}
            </button>
            <button
              onClick={() => setMode('idle')}
              className="px-3 py-2 text-xs text-[#555] hover:text-white rounded-xl transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
