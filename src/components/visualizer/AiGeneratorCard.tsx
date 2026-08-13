'use client'

import { useEffect, useState } from 'react'
import { Check, Download, Sparkles } from 'lucide-react'
import { pill, type VizSlot } from './shared'

type RatioOption = { value: string; label: string }
type RunwayModel = { id: string; label: string; durations: number[]; ratios: RatioOption[] }

type Props = {
  artworkUrl: string
  projectId?: string
  pinButton: (url: string | null, slot: VizSlot) => React.ReactNode
  download: (url: string, suffix: string, ext: 'webm' | 'mp4') => void
  downloadErr: string | null
  finishSave: (() => Promise<void>) | null
  onFinishSaveTap: () => void
}

// The paid Runway image-to-video generator — tier-gated server-side. Moved
// verbatim from the old Visualizer.tsx, with two deliberate diffs: the error
// line renders in the card (it used to sit at the page bottom), and a free-
// card format switch no longer clears the AI result (that reset was
// incidental to the old shared state, and Runway output is format-agnostic).
export default function AiGeneratorCard({
  artworkUrl, projectId, pinButton, download, downloadErr, finishSave, onFinishSaveTap,
}: Props) {
  const [aiStatus, setAiStatus] = useState<'idle' | 'generating' | 'done' | 'error'>('idle')
  const [aiVideoUrl, setAiVideoUrl] = useState<string | null>(null)
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiModelLabel, setAiModelLabel] = useState('')
  const [aiSaved, setAiSaved] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')

  // Runway model options (fetched from API so they stay current)
  const [models, setModels] = useState<RunwayModel[]>([])
  const [selectedModel, setSelectedModel] = useState('')
  const [selectedDuration, setSelectedDuration] = useState<number>(5)
  const [selectedRatio, setSelectedRatio] = useState('')

  useEffect(() => {
    fetch('/api/visualizer/runway')
      .then(r => r.json())
      .then((data: { models: RunwayModel[] }) => {
        setModels(data.models)
        if (data.models.length > 0) {
          const first = data.models[0]
          setSelectedModel(prev => prev || first.id)
          setSelectedDuration(prev => prev || first.durations[0])
          setSelectedRatio(prev => prev || (first.ratios[0]?.value ?? ''))
        }
      })
      .catch(() => {})
  }, [])

  const currentModel = models.find(m => m.id === selectedModel)

  // When model changes, reset duration and ratio to valid defaults
  function handleModelChange(modelId: string) {
    setSelectedModel(modelId)
    const m = models.find(x => x.id === modelId)
    if (m) {
      setSelectedDuration(m.durations[0])
      setSelectedRatio(m.ratios[0]?.value ?? '')
    }
  }

  async function generateAI() {
    if (!artworkUrl) return
    setAiStatus('generating')
    setAiVideoUrl(null)
    setAiModelLabel('')
    setAiSaved(false)
    setErrorMsg('')

    try {
      const res = await fetch('/api/visualizer/runway', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageUrl: artworkUrl,
          model: selectedModel || undefined,
          duration: selectedDuration,
          ratio: selectedRatio || undefined,
          promptText: aiPrompt.trim() || undefined,
          projectId,
        }),
      })

      if (res.status === 501) {
        setAiStatus('error')
        setErrorMsg('Add RUNWAY_API_KEY to your Railway environment variables to enable AI generation.')
        return
      }

      if (!res.ok) {
        const errData = await res.json().catch(() => null)
        setAiStatus('error')
        setErrorMsg(errData?.error || 'AI generation failed. Try again.')
        return
      }

      const data = await res.json()
      setAiVideoUrl(data.videoUrl)
      setAiModelLabel(data.model || currentModel?.label || '')
      setAiSaved(!!data.saved)
      setAiStatus('done')
    } catch {
      setAiStatus('error')
      setErrorMsg('Network error. Check your connection and try again.')
    }
  }

  // Orientation of the AI render, from the selected Runway ratio ('1280:720'
  // style). Wider-than-tall pins to the horizontal slot.
  const aiSlot: VizSlot = (() => {
    const [w, h] = selectedRatio.split(':').map(n => parseInt(n, 10))
    return Number.isFinite(w) && Number.isFinite(h) && w > h ? 'wide' : 'canvas'
  })()

  return (
    <div className="rounded-2xl p-5 space-y-5" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--surface-2)' }}>
      <div className="flex items-center gap-2">
        <Sparkles size={16} style={{ color: 'var(--text-muted)' }} />
        <p className="text-sm font-semibold" style={{ color: 'var(--text)' }}>AI Generator</p>
        <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ backgroundColor: 'var(--surface-2)', color: 'var(--text-muted)' }}>Runway</span>
      </div>

      {/* Model selector */}
      {models.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>Model</p>
          <div className="flex flex-wrap gap-2">
            {models.map(m => (
              <button
                key={m.id}
                onClick={() => handleModelChange(m.id)}
                className="px-3 py-2 rounded-xl text-sm font-medium transition-colors"
                style={pill(selectedModel === m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Duration + Ratio row */}
      {currentModel && (
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>Duration</p>
            <div className="flex flex-wrap gap-2">
              {currentModel.durations.map(d => (
                <button
                  key={d}
                  onClick={() => setSelectedDuration(d)}
                  className="px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
                  style={pill(selectedDuration === d)}
                >
                  {d}s
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>Aspect Ratio</p>
            <select
              value={selectedRatio}
              onChange={e => setSelectedRatio(e.target.value)}
              className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none transition-colors"
              style={{ backgroundColor: 'var(--bg-page)', border: '1px solid var(--surface-2)', color: 'var(--text)' }}
            >
              {currentModel.ratios.map(r => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* AI motion prompt */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>Motion Prompt</p>
        <textarea
          value={aiPrompt}
          onChange={e => setAiPrompt(e.target.value)}
          placeholder="e.g. Camera slowly pushes in, particles drift outward from the center, light flickers and pulses, clouds roll across the sky"
          rows={3}
          maxLength={1000}
          className="w-full rounded-xl px-4 py-3 text-sm focus:outline-none resize-none transition-colors"
          style={{ backgroundColor: 'var(--bg-page)', border: '1px solid var(--surface-2)', color: 'var(--text)' }}
        />
        <p className="text-[11px] mt-1.5" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>Describe <strong>only how things move</strong> — camera moves, what drifts, pulses, or flows. The artwork already sets the scene, so style words (&ldquo;moody&rdquo;, &ldquo;cinematic&rdquo;) are ignored, and it can&rsquo;t add things that aren&rsquo;t in the image. Leave blank for a slow push-in.</p>
      </div>

      <button
        onClick={generateAI}
        disabled={aiStatus === 'generating'}
        className="flex items-center gap-2 px-4 py-2.5 rounded-xl font-medium text-sm transition-colors disabled:opacity-50"
        style={{ backgroundColor: 'var(--accent)', color: 'var(--bg-page)' }}
      >
        <Sparkles size={16} />
        {aiStatus === 'generating' ? 'Generating with AI…' : 'Generate with AI'}
      </button>

      {/* AI video result */}
      {aiStatus === 'done' && aiVideoUrl && (
        <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--surface-2)' }}>
          <p className="text-xs px-3 pt-2 flex items-center gap-2" style={{ color: 'var(--text-muted)' }}>
            AI Generated · {aiModelLabel}
            {aiSaved && (
              <span className="flex items-center gap-1" style={{ color: 'var(--accent)' }}>
                <Check size={11} strokeWidth={3} /> Saved to Media
              </span>
            )}
          </p>
          <video src={aiVideoUrl} controls loop autoPlay muted playsInline className="w-full max-h-80 object-contain bg-black" />
          <div className="p-3 flex flex-wrap justify-between items-center gap-2" style={{ backgroundColor: 'var(--bg-page)' }}>
            <span className="text-sm" style={{ color: 'var(--text-muted)' }}>{selectedRatio} · {selectedDuration}s · {aiModelLabel}</span>
            {/* Only a persisted mf-video URL can be pinned — transient Runway URLs expire */}
            {aiSaved && pinButton(aiVideoUrl, aiSlot)}
            {downloadErr && <span className="text-[11px] w-full" style={{ color: '#f87171' }}>{downloadErr}</span>}
            {finishSave && (
              <button
                onClick={onFinishSaveTap}
                className="w-full flex items-center justify-center gap-1.5 text-sm font-semibold px-3 py-2 rounded-lg transition-colors"
                style={{ backgroundColor: 'var(--accent)', color: 'var(--bg-page)' }}
              >
                <Download size={14} />
                Ready — tap to save to Photos
              </button>
            )}
            <button
              onClick={() => download(aiVideoUrl, 'ai', 'mp4')}
              className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg transition-colors"
              style={{ backgroundColor: 'var(--accent)', color: 'var(--bg-page)' }}
            >
              <Download size={14} />
              Download
            </button>
          </div>
        </div>
      )}

      {/* Error message */}
      {errorMsg && (
        <p className="text-sm" style={{ color: '#f87171' }}>{errorMsg}</p>
      )}
    </div>
  )
}
