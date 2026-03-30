'use client'

import { useState } from 'react'
import { Sparkles, Upload, X } from 'lucide-react'
import Image from 'next/image'

type Props = {
  projectId: string
  projectTitle: string
  genre?: string | null
  currentArtwork?: string | null
  onArtworkUpdated: (url: string) => void
}

export default function ArtworkGenerator({ projectId, projectTitle, genre, currentArtwork, onArtworkUpdated }: Props) {
  const [mode, setMode] = useState<'idle' | 'generate' | 'upload'>('idle')
  const [prompt, setPrompt] = useState(`${projectTitle}${genre ? `, ${genre}` : ''} — abstract music artwork, dark moody aesthetic, no text`)
  const [model, setModel] = useState<'flux' | 'imagen'>('flux')
  const [generating, setGenerating] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(currentArtwork ?? null)
  const [error, setError] = useState('')

  async function handleGenerate() {
    setGenerating(true)
    setError('')

    const res = await fetch('/api/generate-artwork', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, prompt, model }),
    })

    const data = await res.json()
    if (res.ok && data.artwork_url) {
      setPreviewUrl(data.artwork_url)
      onArtworkUpdated(data.artwork_url)
      setMode('idle')
    } else {
      setError(data.error ?? 'Generation failed. Try again.')
    }
    setGenerating(false)
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    const formData = new FormData()
    formData.append('file', file)
    formData.append('project_id', projectId)
    formData.append('type', 'artwork')

    const res = await fetch('/api/upload-audio', { method: 'POST', body: formData })
    const data = await res.json()
    if (res.ok && data.url) {
      // Persist artwork URL to DB
      await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ artwork_url: data.url }),
      })
      setPreviewUrl(data.url)
      onArtworkUpdated(data.url)
      setMode('idle')
    }
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
            className="flex-1 flex items-center justify-center gap-2 py-2 text-xs bg-[#a78bfa]/10 border border-[#a78bfa]/20 text-[#a78bfa] rounded-xl hover:bg-[#a78bfa]/20 transition-colors"
          >
            <Sparkles size={13} />
            Generate with AI
          </button>
          <label className="flex-1 flex items-center justify-center gap-2 py-2 text-xs bg-[#1a1a1a] border border-[#222] text-[#888] rounded-xl hover:bg-[#222] transition-colors cursor-pointer">
            <Upload size={13} />
            Upload
            <input type="file" accept="image/*" onChange={handleUpload} className="hidden" />
          </label>
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
                  model === m ? 'bg-[#a78bfa]/20 text-[#a78bfa]' : 'text-[#555] hover:text-[#888]'
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
            className="w-full bg-[#0f0f0f] border border-[#222] rounded-xl px-3 py-2 text-xs text-white placeholder-[#444] focus:outline-none focus:border-[#a78bfa]/40 resize-none"
          />
          {error && <p className="text-red-400 text-xs">{error}</p>}
          <div className="flex gap-2">
            <button
              onClick={handleGenerate}
              disabled={generating || !prompt.trim()}
              className="flex-1 py-2 text-xs bg-[#a78bfa] hover:bg-[#9370f0] disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl transition-colors font-medium"
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
