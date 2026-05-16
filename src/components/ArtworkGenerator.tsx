'use client'

import { useState, type ChangeEvent } from 'react'
import { Sparkles, Upload, X, Wand2, ChevronDown, ChevronUp } from 'lucide-react'
import Image from 'next/image'

type Props = {
  projectId: string
  projectTitle: string
  genre?: string | null
  currentArtwork?: string | null
  currentFinalized?: string | null
  onArtworkUpdated: (url: string) => void
  onFinalizedUpdated: (url: string | null) => void
  showFinalize?: boolean
}

function Slider({
  label, value, min, max, step, onChange, displayFn,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  displayFn?: (v: number) => string
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-[10px] text-[#666] w-20 shrink-0">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="flex-1 accent-[#2dd4bf] h-1 cursor-pointer"
      />
      <span className="text-[10px] text-[#888] w-10 text-right tabular-nums">
        {displayFn ? displayFn(value) : value.toFixed(2)}
      </span>
    </div>
  )
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

  // Finalize controls
  const [guidance, setGuidance] = useState('')
  const [position, setPosition] = useState<'auto' | 'top' | 'bottom'>('auto')
  const [showRule, setShowRule] = useState(true)
  const [showFilters, setShowFilters] = useState(false)

  // Photo adjustment filters
  const [brightness, setBrightness] = useState(1.0)
  const [contrast, setContrast] = useState(1.0)
  const [saturation, setSaturation] = useState(1.0)
  const [vignette, setVignette] = useState(false)

  const sourceUrl = currentArtwork ?? null
  const previewUrl = currentFinalized ?? sourceUrl

  const filtersAreDefault = brightness === 1.0 && contrast === 1.0 && saturation === 1.0 && !vignette

  function resetFilters() {
    setBrightness(1.0)
    setContrast(1.0)
    setSaturation(1.0)
    setVignette(false)
  }

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
        position: position !== 'auto' ? position : undefined,
        showRule,
        filters: {
          brightness,
          contrast,
          saturation,
          vignette,
        },
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

      {/* Finalize section — gated on showFinalize */}
      {showFinalize && mode === 'idle' && previewUrl && (
        <div className="space-y-2">

          {/* Text position row */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-[#555] shrink-0">Position</span>
            <div className="flex gap-1 flex-1">
              {(['auto', 'top', 'bottom'] as const).map(p => (
                <button
                  key={p}
                  onClick={() => setPosition(p)}
                  className={`flex-1 py-1 text-[10px] font-medium rounded-lg border transition-colors ${
                    position === p
                      ? 'bg-[#2dd4bf]/20 border-[#2dd4bf]/40 text-[#2dd4bf]'
                      : 'border-[#222] text-[#555] hover:text-[#888] hover:border-[#333]'
                  }`}
                >
                  {p.charAt(0).toUpperCase() + p.slice(1)}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-1.5 cursor-pointer shrink-0">
              <input
                type="checkbox"
                checked={showRule}
                onChange={e => setShowRule(e.target.checked)}
                className="accent-[#2dd4bf] w-3 h-3"
              />
              <span className="text-[10px] text-[#555]">Line</span>
            </label>
          </div>

          {/* Guidance / feedback textarea */}
          <textarea
            value={guidance}
            onChange={e => setGuidance(e.target.value)}
            maxLength={400}
            rows={2}
            placeholder="Describe what you want (e.g. &quot;text bottom right&quot;, &quot;smaller text&quot;, &quot;avoid the logo in the center&quot;)"
            className="w-full bg-[#0f0f0f] border border-[#222] rounded-xl px-3 py-2 text-xs text-white placeholder-[#444] focus:outline-none focus:border-[#2dd4bf]/40 resize-none"
          />

          {/* Photo adjustments — expandable */}
          <div className="border border-[#1e1e1e] rounded-xl overflow-hidden">
            <button
              onClick={() => setShowFilters(v => !v)}
              className="w-full flex items-center justify-between px-3 py-2 text-[10px] text-[#555] hover:text-[#888] transition-colors"
            >
              <span className="flex items-center gap-1.5">
                Photo Adjustments
                {!filtersAreDefault && (
                  <span className="w-1.5 h-1.5 rounded-full bg-[#2dd4bf]" />
                )}
              </span>
              {showFilters ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>

            {showFilters && (
              <div className="px-3 pb-3 space-y-2.5">
                <Slider
                  label="Brightness"
                  value={brightness}
                  min={0.5} max={1.5} step={0.05}
                  onChange={setBrightness}
                  displayFn={v => `${Math.round(v * 100)}%`}
                />
                <Slider
                  label="Contrast"
                  value={contrast}
                  min={0.5} max={1.5} step={0.05}
                  onChange={setContrast}
                  displayFn={v => `${Math.round(v * 100)}%`}
                />
                <Slider
                  label="Saturation"
                  value={saturation}
                  min={0} max={2} step={0.05}
                  onChange={setSaturation}
                  displayFn={v => `${Math.round(v * 100)}%`}
                />
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={vignette}
                    onChange={e => setVignette(e.target.checked)}
                    className="accent-[#2dd4bf] w-3 h-3"
                  />
                  <span className="text-[10px] text-[#666]">Vignette</span>
                </label>
                {!filtersAreDefault && (
                  <button
                    onClick={resetFilters}
                    className="text-[10px] text-[#444] hover:text-[#666] transition-colors"
                  >
                    Reset adjustments
                  </button>
                )}
              </div>
            )}
          </div>

          {error && <p className="text-red-400 text-xs">{error}</p>}

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
