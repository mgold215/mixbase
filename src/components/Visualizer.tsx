'use client'

import { useState, useRef, useEffect } from 'react'
import Image from 'next/image'
import { Download, Film, Sparkles } from 'lucide-react'

type Format = 'canvas' | 'youtube' | 'square' | 'story'
type Effect = 'kenburns' | 'breathe' | 'glitch'

const EFFECT_CONFIG: Record<Effect, { label: string; description: string }> = {
  kenburns: { label: 'Ken Burns', description: 'Zoom & drift' },
  breathe:  { label: 'Breathe',   description: 'Gentle pulse' },
  glitch:   { label: 'Glitch',    description: 'Digital noise' },
}

const FORMAT_CONFIG: Record<Format, { label: string; width: number; height: number; duration: number; description: string }> = {
  canvas:  { label: 'Spotify Canvas', width: 1080, height: 1920, duration: 6,  description: '9:16 · 6s loop' },
  youtube: { label: 'YouTube',        width: 1920, height: 1080, duration: 30, description: '16:9 · 30s loop' },
  square:  { label: 'Square',         width: 1080, height: 1080, duration: 6,  description: '1:1 · 6s loop' },
  story:   { label: 'Story',          width: 1080, height: 1920, duration: 6,  description: '9:16 · 6s loop' },
}

type RatioOption = { value: string; label: string }
type RunwayModel = { id: string; label: string; durations: number[]; ratios: RatioOption[] }

type Props = {
  projectTitle: string
  artworkUrl: string | null
  onSwitchToArtwork: () => void
}

export default function Visualizer({ projectTitle, artworkUrl, onSwitchToArtwork }: Props) {
  const [format, setFormat] = useState<Format>('canvas')
  const [effect, setEffect] = useState<Effect>('kenburns')
  const [status, setStatus] = useState<'idle' | 'rendering' | 'done' | 'error'>('idle')
  const [progress, setProgress] = useState(0)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState('')
  const [aiStatus, setAiStatus] = useState<'idle' | 'generating' | 'done' | 'error'>('idle')
  const [aiVideoUrl, setAiVideoUrl] = useState<string | null>(null)
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiModelLabel, setAiModelLabel] = useState('')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const cancelledRef = useRef(false)

  // Runway model options (fetched from API so they stay current)
  const [models, setModels] = useState<RunwayModel[]>([])
  const [selectedModel, setSelectedModel] = useState('')
  const [selectedDuration, setSelectedDuration] = useState<number>(5)
  const [selectedRatio, setSelectedRatio] = useState('')

  // Fetch available models on mount
  useEffect(() => {
    fetch('/api/visualizer/runway')
      .then(r => r.json())
      .then((data: { models: RunwayModel[] }) => {
        setModels(data.models)
        if (data.models.length > 0 && !selectedModel) {
          const first = data.models[0]
          setSelectedModel(first.id)
          setSelectedDuration(first.durations[0])
          setSelectedRatio(first.ratios[0]?.value ?? '')
        }
      })
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

  async function generateFree() {
    if (!artworkUrl) return

    // Guard: MediaRecorder is not available in Safari on iOS
    if (typeof MediaRecorder === 'undefined' || typeof (canvasRef.current?.captureStream) === 'undefined') {
      setStatus('error')
      setErrorMsg('Video recording is not supported in this browser. Try Chrome or Firefox.')
      return
    }

    cancelledRef.current = false

    setStatus('rendering')
    setProgress(0)
    setVideoUrl(null)
    setErrorMsg('')

    const cfg = FORMAT_CONFIG[format]

    // Render at 1/4 scale for browser performance; output is still valid video
    const SCALE = 0.25
    const W = cfg.width * SCALE
    const H = cfg.height * SCALE
    const FPS = 30
    const TOTAL_FRAMES = cfg.duration * FPS

    const canvas = canvasRef.current!
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      setStatus('error')
      setErrorMsg('Could not initialize canvas renderer.')
      return
    }

    // Load artwork image
    const img = new window.Image()
    img.crossOrigin = 'anonymous'
    try {
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = reject
        img.src = artworkUrl
      })
    } catch {
      setStatus('error')
      setErrorMsg('Could not load artwork image. Try again.')
      return
    }

    // Pan direction options (shared by kenburns + glitch)
    const directions = [
      { startX: -0.04, startY: -0.04, endX: 0,     endY: 0     },
      { startX: 0.04,  startY: -0.04, endX: 0,     endY: 0     },
      { startX: 0,     startY: 0,     endX: -0.04, endY: -0.04 },
      { startX: 0,     startY: 0,     endX:  0.04, endY:  0.04 },
    ]
    const dir = directions[Math.floor(Math.random() * directions.length)]

    // Pre-compute per-effect motion functions
    type MotionFn = (t: number) => { scale: number; panX: number; panY: number }
    let getMotion: MotionFn
    const glitchFrames = new Set<number>()

    if (effect === 'breathe') {
      // Gentle scale pulsing, 2 full breathe cycles over the clip
      getMotion = (t) => ({
        scale: 1.01 + 0.06 * (0.5 + 0.5 * Math.sin(t * Math.PI * 4)),
        panX: 0,
        panY: 0,
      })
    } else if (effect === 'glitch') {
      // Slow Ken Burns base with occasional digital glitch clusters
      getMotion = (t) => ({
        scale: 1.06 - 0.04 * t,
        panX: (dir.startX + (dir.endX - dir.startX) * t) * W * 0.5,
        panY: (dir.startY + (dir.endY - dir.startY) * t) * H * 0.5,
      })
      // Pre-compute glitch frame clusters (~15% of frames, in bursts)
      let f = Math.floor(8 + Math.random() * 15)
      while (f < TOTAL_FRAMES) {
        const clusterLen = 1 + Math.floor(Math.random() * 3)
        for (let j = 0; j < clusterLen && f + j < TOTAL_FRAMES; j++) glitchFrames.add(f + j)
        f += Math.floor(12 + Math.random() * 20)
      }
    } else {
      // Ken Burns: zoom out + random pan
      getMotion = (t) => ({
        scale: 1.08 + (1.0 - 1.08) * t,
        panX: (dir.startX + (dir.endX - dir.startX) * t) * W,
        panY: (dir.startY + (dir.endY - dir.startY) * t) * H,
      })
    }

    // Set up MediaRecorder
    const stream = canvas.captureStream(FPS)
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : 'video/webm'
    const recorder = new MediaRecorder(stream, { mimeType })
    const chunks: Blob[] = []
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data) }

    const blobReady = new Promise<Blob>(resolve => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }))
    })

    recorder.start()

    // Cover-fit dimensions (constant across frames)
    const imgAspect = img.width / img.height
    const canvasAspect = W / H
    let drawW: number, drawH: number
    if (imgAspect > canvasAspect) {
      drawH = H; drawW = H * imgAspect
    } else {
      drawW = W; drawH = W / imgAspect
    }

    for (let frame = 0; frame < TOTAL_FRAMES; frame++) {
      const t = TOTAL_FRAMES > 1 ? frame / (TOTAL_FRAMES - 1) : 0
      const { scale, panX, panY } = getMotion(t)

      ctx.clearRect(0, 0, W, H)
      ctx.save()
      ctx.translate(W / 2 + panX, H / 2 + panY)
      ctx.scale(scale, scale)

      ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH)

      // Glitch overlay: horizontal slice offsets + chromatic flash
      if (effect === 'glitch' && glitchFrames.has(frame)) {
        const numSlices = 2 + Math.floor(Math.random() * 3)
        for (let s = 0; s < numSlices; s++) {
          const sliceY  = (Math.random() - 0.5) * drawH
          const sliceH  = 5 + Math.random() * 18
          const offsetX = (Math.random() < 0.5 ? -1 : 1) * (0.02 + Math.random() * 0.07) * drawW
          const srcY    = Math.max(0, (sliceY + drawH / 2) * img.height / drawH)
          const srcH    = Math.min(sliceH * img.height / drawH, img.height - srcY)
          if (srcH > 1) {
            ctx.drawImage(img, 0, srcY, img.width, srcH,
              -drawW / 2 + offsetX, sliceY, drawW, sliceH)
          }
        }
        // Chromatic aberration flash
        ctx.globalAlpha = 0.1 + Math.random() * 0.12
        ctx.globalCompositeOperation = 'screen'
        ctx.fillStyle = Math.random() < 0.5 ? '#ff003380' : '#00ffff50'
        ctx.fillRect(-drawW / 2, -drawH / 2, drawW, drawH)
        ctx.globalCompositeOperation = 'source-over'
        ctx.globalAlpha = 1
      }

      ctx.restore()

      setProgress(Math.round((frame / TOTAL_FRAMES) * 100))

      if (cancelledRef.current) {
        recorder.stop()
        return
      }

      // Pace each frame to real-time so MediaRecorder captures correct duration
      await new Promise(r => setTimeout(r, 1000 / FPS))
    }

    recorder.stop()
    const blob = await blobReady
    const url = URL.createObjectURL(blob)
    setVideoUrl(prev => {
      if (prev) URL.revokeObjectURL(prev)
      return url
    })
    setStatus('done')
    setProgress(100)
  }

  async function generateAI() {
    if (!artworkUrl) return
    setAiStatus('generating')
    setAiVideoUrl(null)
    setAiModelLabel('')
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
      setAiStatus('done')
    } catch {
      setAiStatus('error')
      setErrorMsg('Network error. Check your connection and try again.')
    }
  }

  function download(url: string, suffix: string) {
    const a = document.createElement('a')
    a.href = url
    a.download = `${projectTitle.replace(/\s+/g, '-').toLowerCase()}-${format}-${suffix}.webm`
    a.click()
  }

  function resetFormat(f: Format) {
    cancelledRef.current = true
    setFormat(f)
    setStatus('idle')
    setVideoUrl(null)
    setAiStatus('idle')
    setAiVideoUrl(null)
    setErrorMsg('')
  }

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl)
    }
  }, [videoUrl])

  if (!artworkUrl) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center gap-4">
        <Film size={40} style={{ color: 'var(--surface-3)' }} />
        <p style={{ color: 'var(--text-muted)' }}>No artwork yet. Generate artwork first.</p>
        <button
          onClick={onSwitchToArtwork}
          className="text-sm px-4 py-2 rounded-xl transition-colors"
          style={{ backgroundColor: 'var(--accent)', color: 'var(--bg-page)' }}
        >
          Go to Artwork tab
        </button>
      </div>
    )
  }

  const cfg = FORMAT_CONFIG[format]

  // Shared pill button style helper
  const pill = (active: boolean) => active
    ? { backgroundColor: 'var(--accent)', color: 'var(--bg-page)' }
    : { backgroundColor: 'var(--surface)', color: 'var(--text-muted)', border: '1px solid var(--surface-2)' }

  return (
    <div className="max-w-2xl space-y-6">
      {/* Hidden canvas used for frame rendering */}
      <canvas ref={canvasRef} style={{ display: 'none' }} />

      {/* Artwork preview */}
      <div className="flex items-center gap-4">
        <div className="relative w-20 h-20 rounded-xl overflow-hidden flex-shrink-0" style={{ backgroundColor: 'var(--surface)' }}>
          <Image src={artworkUrl} alt="Artwork" fill className="object-cover" unoptimized />
        </div>
        <div>
          <p className="font-semibold" style={{ color: 'var(--text)' }}>{projectTitle}</p>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Animate this artwork into a video loop</p>
        </div>
      </div>

      {/* ── Free generator controls ──────────────────────────────────────── */}
      <div className="rounded-2xl p-5 space-y-5" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--surface-2)' }}>
        <div className="flex items-center gap-2">
          <Film size={16} style={{ color: 'var(--text-muted)' }} />
          <p className="text-sm font-semibold" style={{ color: 'var(--text)' }}>Free Generator</p>
        </div>

        {/* Format selector */}
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>Export Format</p>
          <div className="flex flex-wrap gap-2">
            {(Object.entries(FORMAT_CONFIG) as [Format, typeof FORMAT_CONFIG[Format]][]).map(([key, val]) => (
              <button
                key={key}
                onClick={() => resetFormat(key)}
                className="px-3 py-2 rounded-xl text-sm font-medium transition-colors"
                style={pill(format === key)}
              >
                <span className="block">{val.label}</span>
                <span className="block text-[10px] opacity-70">{val.description}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Effect selector */}
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>Effect</p>
          <div className="flex flex-wrap gap-2">
            {(Object.entries(EFFECT_CONFIG) as [Effect, typeof EFFECT_CONFIG[Effect]][]).map(([key, val]) => (
              <button
                key={key}
                onClick={() => setEffect(key)}
                className="px-3 py-2 rounded-xl text-sm font-medium transition-colors"
                style={pill(effect === key)}
              >
                <span className="block">{val.label}</span>
                <span className="block text-[10px] opacity-70">{val.description}</span>
              </button>
            ))}
          </div>
        </div>

        <button
          onClick={generateFree}
          disabled={status === 'rendering'}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl font-medium text-sm transition-colors disabled:opacity-50"
          style={{ backgroundColor: 'var(--accent)', color: 'var(--bg-page)' }}
        >
          <Film size={16} />
          {status === 'rendering' ? `Rendering… ${progress}%` : 'Generate Video (Free)'}
        </button>

        {/* Progress bar (free render) */}
        {status === 'rendering' && (
          <div className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--surface-2)' }}>
            <div
              className="h-full rounded-full transition-all duration-100"
              style={{ width: `${progress}%`, backgroundColor: 'var(--accent)' }}
            />
          </div>
        )}

        {/* Free video result */}
        {status === 'done' && videoUrl && (
          <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--surface-2)' }}>
            <video src={videoUrl} controls loop autoPlay muted playsInline className="w-full max-h-80 object-contain bg-black" />
            <div className="p-3 flex justify-between items-center" style={{ backgroundColor: 'var(--bg-page)' }}>
              <span className="text-sm" style={{ color: 'var(--text-muted)' }}>{cfg.label} · {cfg.width}×{cfg.height} · WebM</span>
              <button
                onClick={() => download(videoUrl, 'free')}
                className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg transition-colors"
                style={{ backgroundColor: 'var(--accent)', color: 'var(--bg-page)' }}
              >
                <Download size={14} />
                Download
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── AI generator controls ────────────────────────────────────────── */}
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
            placeholder="e.g. Particles dissolving outward from center, liquid ripple distortion, neon light trails pulsing to a beat"
            rows={3}
            className="w-full rounded-xl px-4 py-3 text-sm focus:outline-none resize-none transition-colors"
            style={{ backgroundColor: 'var(--bg-page)', border: '1px solid var(--surface-2)', color: 'var(--text)' }}
          />
          <p className="text-[11px] mt-1.5" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>Leave blank for a default cinematic drift. Be specific — describe motion, not style.</p>
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
            <p className="text-xs px-3 pt-2" style={{ color: 'var(--text-muted)' }}>AI Generated · {aiModelLabel}</p>
            <video src={aiVideoUrl} controls loop autoPlay muted playsInline className="w-full max-h-80 object-contain bg-black" />
            <div className="p-3 flex justify-between items-center" style={{ backgroundColor: 'var(--bg-page)' }}>
              <span className="text-sm" style={{ color: 'var(--text-muted)' }}>{selectedRatio} · {selectedDuration}s · {aiModelLabel}</span>
              <button
                onClick={() => download(aiVideoUrl, 'ai')}
                className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg transition-colors"
                style={{ backgroundColor: 'var(--accent)', color: 'var(--bg-page)' }}
              >
                <Download size={14} />
                Download
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Error message */}
      {errorMsg && (
        <p className="text-sm" style={{ color: '#f87171' }}>{errorMsg}</p>
      )}
    </div>
  )
}
