'use client'

import { useState, useRef, useEffect } from 'react'
import Image from 'next/image'
import { Download, Film, Sparkles, Check, MonitorPlay, X } from 'lucide-react'
import { visualizerKindLabel } from '@/lib/visualizer-kinds'
import { saveMedia } from '@/lib/download'
import { EFFECTS, EFFECT_IDS, domLayerFactory, type EffectId, type DrawFrame } from '@/lib/free-effects'

type Format = 'canvas' | 'youtube' | 'square' | 'story'

// Which project pin a video goes into: 'canvas' = vertical (player + Finalize
// Short), 'wide' = horizontal (Finalize Full-Length).
type VizSlot = 'canvas' | 'wide'

const FORMAT_CONFIG: Record<Format, { label: string; width: number; height: number; duration: number; description: string }> = {
  canvas:  { label: 'Spotify Canvas', width: 1080, height: 1920, duration: 6,  description: '9:16 · 6s loop' },
  youtube: { label: 'YouTube',        width: 1920, height: 1080, duration: 30, description: '16:9 · 30s loop' },
  square:  { label: 'Square',         width: 1080, height: 1080, duration: 6,  description: '1:1 · 6s loop' },
  story:   { label: 'Story',          width: 1080, height: 1920, duration: 6,  description: '9:16 · 6s loop' },
}

// The free canvas render draws at 1/2 scale for browser performance, so the
// output is half the format's nominal resolution. Kept here so the render
// and the result label agree (the label used to advertise the full resolution).
const RENDER_SCALE = 0.5

// Default tempo for beat-synced effects — dead center of house.
const DEFAULT_BPM = 122

function clampBpm(raw: string): number {
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n)) return DEFAULT_BPM
  return Math.min(200, Math.max(60, n))
}

type RatioOption = { value: string; label: string }
type RunwayModel = { id: string; label: string; durations: number[]; ratios: RatioOption[] }

type Props = {
  projectTitle: string
  artworkUrl: string | null
  onSwitchToArtwork: () => void
  // When set, generated videos are persisted to the Media library against this
  // project. Omitted in contexts with no backing project (none currently).
  projectId?: string
  // The project's pinned visualizers. visualizer_url is the VERTICAL pin —
  // loops in the player while this track plays (Spotify-Canvas style) and
  // feeds the Finalize Short render. visualizer_wide_url is the HORIZONTAL
  // pin that feeds the Finalize Full-Length render. Wired on the project
  // page; the Media modal omits them.
  visualizerUrl?: string | null
  onVisualizerUpdated?: (url: string | null) => void
  wideVisualizerUrl?: string | null
  onWideVisualizerUpdated?: (url: string | null) => void
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

// A saved video from the user's library (mb_visualizers) — any project, any
// kind: canvas loops, Runway AI, and finished YouTube/Shorts renders.
type LibraryItem = {
  id: string
  video_url: string
  title: string | null
  kind: string
  project_id: string | null
  source_image_url: string | null
  created_at: string
}

export default function Visualizer({
  projectTitle, artworkUrl, onSwitchToArtwork, projectId,
  visualizerUrl, onVisualizerUpdated, wideVisualizerUrl, onWideVisualizerUpdated,
}: Props) {
  const [format, setFormat] = useState<Format>('canvas')
  const [effect, setEffect] = useState<EffectId>('kenburns')
  // Raw input string so typing "1" mid-edit isn't clamped out from under the
  // user; clampBpm() is applied wherever the number is consumed.
  const [bpm, setBpm] = useState(String(DEFAULT_BPM))
  const [status, setStatus] = useState<'idle' | 'rendering' | 'done' | 'error'>('idle')
  const [progress, setProgress] = useState(0)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState('')
  const [aiStatus, setAiStatus] = useState<'idle' | 'generating' | 'done' | 'error'>('idle')
  const [aiVideoUrl, setAiVideoUrl] = useState<string | null>(null)
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiModelLabel, setAiModelLabel] = useState('')
  const [freeSave, setFreeSave] = useState<SaveStatus>('idle')
  // Persisted mf-video URL of the last free render — the blob: URL plays
  // locally, but only the stored URL can be pinned as the project visualizer.
  const [freeSavedUrl, setFreeSavedUrl] = useState<string | null>(null)
  const [aiSaved, setAiSaved] = useState(false)
  const [projectViz, setProjectViz] = useState(visualizerUrl ?? null)
  const [projectVizWide, setProjectVizWide] = useState(wideVisualizerUrl ?? null)
  const [settingViz, setSettingViz] = useState(false)
  const [vizError, setVizError] = useState('')
  // "Choose from Media" picker — pin any previously generated loop, from any
  // project, into whichever slot (vertical/horizontal) opened the picker.
  const [pickerSlot, setPickerSlot] = useState<VizSlot | null>(null)
  const [library, setLibrary] = useState<LibraryItem[]>([])
  const [libraryLoading, setLibraryLoading] = useState(false)
  const [libraryError, setLibraryError] = useState('')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const previewRef = useRef<HTMLCanvasElement>(null)
  // Measured width of the live-preview box. Landscape previews render at the
  // box's full width (instead of a fixed 300px) so 16:9 formats fill the wide
  // panel edge to edge, like the exported video fills a wide screen.
  const [previewBoxW, setPreviewBoxW] = useState(0)
  const cancelledRef = useRef(false)
  // Mirrors status === 'rendering' for the preview rAF loop, which must not
  // re-init (and restart the loop position) every time status flips.
  const renderingRef = useRef(false)
  // One seed per mount: the live preview and the recorded render share it, so
  // what you see in the preview is exactly the motion you get in the video.
  const seedRef = useRef(Math.floor(Math.random() * 2 ** 31))

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
    setFreeSave('idle')
    setFreeSavedUrl(null)

    const cfg = FORMAT_CONFIG[format]

    // Render at 1/2 scale for browser performance; output is still valid video
    const W = Math.round(cfg.width * RENDER_SCALE)
    const H = Math.round(cfg.height * RENDER_SCALE)
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

    // Build the effect's frame renderer (see src/lib/free-effects.ts). Shares
    // the preview's seed so the recording matches what the preview showed.
    let drawFrame: DrawFrame
    try {
      drawFrame = EFFECTS[effect].create({
        W, H,
        duration: cfg.duration,
        fps: FPS,
        bpm: clampBpm(bpm),
        seed: seedRef.current,
        image: img,
        imageWidth: img.width,
        imageHeight: img.height,
        createLayer: domLayerFactory,
      })
    } catch {
      setStatus('error')
      setErrorMsg('Could not initialize the effect renderer. Try a different image.')
      return
    }

    // Set up MediaRecorder + run the frame loop. Any throw in here — a tainted
    // canvas SecurityError (artwork served without CORS headers), captureStream
    // being unavailable, or an unsupported codec — must reset the button, not
    // leave it stuck on "Rendering…" forever. Happy path is unchanged (the catch
    // only runs on a real throw). Matches the try/finally-resets-loading pattern.
    try {
      const stream = canvas.captureStream(FPS)
      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9'
        : 'video/webm'
      // Cap the bitrate so the longest render (30s YouTube) stays comfortably
      // under /api/visualizer/save's 10 MB limit (~8.5 MB budget).
      const videoBitsPerSecond = Math.min(3_500_000, Math.floor((8.5 * 8 * 1024 * 1024) / cfg.duration))
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond })
      const chunks: Blob[] = []
      recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data) }

      const blobReady = new Promise<Blob>((resolve, reject) => {
        recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }))
        // A recorder-level failure (encoder error, the capture stream ending)
        // fires 'error' and may never fire 'stop' — without this the await below
        // would hang and the button would stay stuck on "Rendering…" forever
        // (a hang is not a throw, so the catch never runs). Reject so the
        // surrounding catch resets to the error state, like the tainted-canvas path.
        recorder.onerror = () => reject(new Error('MediaRecorder failed'))
      })
      // If a cancel bails out before the await below, keep a late rejection from
      // surfacing as an unhandled promise rejection.
      blobReady.catch(() => {})

      recorder.start()

      // t = frame / TOTAL_FRAMES (never reaching 1) so the last frame sits one
      // step before the wrap — every effect is periodic over [0,1), which makes
      // the exported loop seamless.
      const startTime = performance.now()
      for (let frame = 0; frame < TOTAL_FRAMES; frame++) {
        drawFrame(ctx, frame / TOTAL_FRAMES, frame)

        setProgress(Math.round((frame / TOTAL_FRAMES) * 100))

        if (cancelledRef.current) {
          recorder.stop()
          return
        }

        // Pace against an absolute schedule (not a fixed per-frame sleep) so
        // draw time doesn't stretch the recording past the nominal duration.
        const wait = startTime + ((frame + 1) * 1000) / FPS - performance.now()
        await new Promise(r => setTimeout(r, Math.max(0, wait)))
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

      // Persist to the Media library so it's findable later (not just a throwaway
      // blob: URL). Playback above is instant from the local blob; this runs after.
      void saveFreeToMedia(blob, format, effect)
    } catch {
      // Don't clobber a deliberate cancel (resetFormat/unmount) with an error.
      if (!cancelledRef.current) {
        setStatus('error')
        setErrorMsg('Video rendering failed in this browser. Try Chrome or Firefox, or a different image.')
      }
    }
  }

  async function saveFreeToMedia(blob: Blob, fmt: Format, eff: EffectId) {
    if (!projectId) return
    setFreeSave('saving')
    try {
      const fd = new FormData()
      fd.append('file', blob, 'visualizer.webm')
      fd.append('projectId', projectId)
      fd.append('title', `${FORMAT_CONFIG[fmt].label} · ${EFFECTS[eff].label}`)
      if (artworkUrl) fd.append('sourceImageUrl', artworkUrl)
      const res = await fetch('/api/visualizer/save', { method: 'POST', body: fd })
      if (res.ok) {
        const data = await res.json().catch(() => null) as { video_url?: string } | null
        setFreeSavedUrl(data?.video_url ?? null)
        setFreeSave('saved')
      } else {
        setFreeSave('error')
      }
    } catch {
      setFreeSave('error')
    }
  }

  // Open the library picker for a pin slot and load every saved loop the user
  // owns. Loading flag resets in finally so a network reject can't strand the
  // spinner.
  async function openPicker(slot: VizSlot) {
    setPickerSlot(slot)
    setLibraryError('')
    setLibraryLoading(true)
    try {
      const res = await fetch('/api/visualizer')
      const data = await res.json().catch(() => null)
      if (!res.ok || !Array.isArray(data)) throw new Error()
      setLibrary(data)
    } catch {
      setLibraryError('Could not load your visualizers. Try again.')
    } finally {
      setLibraryLoading(false)
    }
  }

  async function pickFromLibrary(item: LibraryItem) {
    await setProjectVisualizer(pickerSlot ?? 'canvas', item.video_url)
    setPickerSlot(null)
  }

  // Pin (or clear) one of the project's visualizer slots — vertical loops in
  // the player and feeds the Short; horizontal feeds the Full-Length video.
  // Persists via the project PATCH so it survives reloads.
  async function setProjectVisualizer(slot: VizSlot, url: string | null) {
    if (!projectId || settingViz) return
    setSettingViz(true)
    setVizError('')
    // One PATCH attempt — resolves to null on success, an error message on
    // failure. Kept as a closure so the retry below is a genuine re-request.
    const attempt = async (): Promise<string | null> => {
      try {
        const res = await fetch(`/api/projects/${projectId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(slot === 'wide' ? { visualizer_wide_url: url } : { visualizer_url: url }),
        })
        if (res.ok) return null
        const data = await res.json().catch(() => null) as { error?: string } | null
        return data?.error || `Request failed (${res.status})`
      } catch {
        return 'Network error'
      }
    }
    try {
      let err = await attempt()
      if (err) {
        // Every merge redeploys prod, and pinning right after generating is
        // exactly when a restart blip can land — one spaced retry absorbs it.
        await new Promise(r => setTimeout(r, 1500))
        err = await attempt()
      }
      if (err) {
        setVizError(`Could not update the project visualizer (${err}). Try again.`)
        return
      }
      if (slot === 'wide') {
        setProjectVizWide(url)
        onWideVisualizerUpdated?.(url)
      } else {
        setProjectViz(url)
        onVisualizerUpdated?.(url)
      }
    } finally {
      setSettingViz(false)
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

  // saveMedia handles the platform differences: share sheet on phones (so the
  // clip can go straight to Photos), forced attachment download on desktop. A
  // bare cross-origin <a download> would just open the video inline.
  function download(url: string, suffix: string, ext: 'webm' | 'mp4') {
    void saveMedia(url, `${projectTitle}-${format}-${suffix}`, ext).catch(() => {})
  }

  function resetFormat(f: Format) {
    cancelledRef.current = true
    setFormat(f)
    setStatus('idle')
    setVideoUrl(null)
    setAiStatus('idle')
    setAiVideoUrl(null)
    setFreeSave('idle')
    setFreeSavedUrl(null)
    setAiSaved(false)
    setErrorMsg('')
  }

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl)
    }
  }, [videoUrl])

  // If the component unmounts mid-render (e.g. the Media modal is closed while a
  // free render is in flight), signal the frame loop to stop so it doesn't keep
  // drawing + recording on a dead instance and leak a blob URL the revoke effect
  // above can no longer catch. Empty deps → runs only on unmount.
  useEffect(() => {
    return () => { cancelledRef.current = true }
  }, [])

  useEffect(() => { renderingRef.current = status === 'rendering' }, [status])

  const bpmNum = clampBpm(bpm)

  // Track the preview box's width so landscape previews can fill it. Only
  // material changes (>32px) update state — every update re-inits the preview
  // loop from t = 0, so ignore sub-pixel/scrollbar jitter.
  useEffect(() => {
    const box = previewRef.current?.parentElement
    if (!box || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(entries => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0)
      if (w > 0) setPreviewBoxW(prev => (Math.abs(prev - w) > 32 ? w : prev))
    })
    ro.observe(box)
    return () => ro.disconnect()
  }, [artworkUrl])

  // Live preview: run the selected effect in a visible canvas via rAF so
  // the user sees the motion before committing to a render. Paused (frames
  // skipped, loop kept alive) while a recording is in flight so the two loops
  // don't fight for the main thread.
  useEffect(() => {
    const canvas = previewRef.current
    if (!canvas || !artworkUrl) return
    let disposed = false
    let raf = 0
    const cfg = FORMAT_CONFIG[format]
    // Landscape formats render at the preview box's full width so the wide
    // canvas is sharp when displayed edge to edge; portrait/square formats are
    // height-limited by the CSS cap, so 300px of intrinsic width is plenty.
    const boxW = previewBoxW || canvas.parentElement?.clientWidth || 0
    const PW = cfg.width > cfg.height ? Math.min(1024, Math.max(300, boxW)) : 300
    const PH = Math.round((PW * cfg.height) / cfg.width)
    canvas.width = PW
    canvas.height = PH
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const img = new window.Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      if (disposed) return
      let draw: DrawFrame
      try {
        draw = EFFECTS[effect].create({
          W: PW, H: PH,
          duration: cfg.duration,
          fps: 30,
          bpm: bpmNum,
          seed: seedRef.current,
          image: img,
          imageWidth: img.width,
          imageHeight: img.height,
          createLayer: domLayerFactory,
        })
      } catch {
        return
      }
      const start = performance.now()
      const loop = () => {
        if (disposed) return
        if (!renderingRef.current) {
          const elapsed = (performance.now() - start) / 1000
          const t = (elapsed % cfg.duration) / cfg.duration
          try {
            draw(ctx, t, Math.floor(t * cfg.duration * 30))
          } catch {
            return // stop the preview quietly; recording has its own error path
          }
        }
        raf = requestAnimationFrame(loop)
      }
      raf = requestAnimationFrame(loop)
    }
    img.src = artworkUrl
    return () => {
      disposed = true
      cancelAnimationFrame(raf)
    }
  }, [artworkUrl, effect, format, bpmNum, previewBoxW])

  // One pin slot's UI: preview + Choose from Media + Remove. Shared by the
  // vertical (player + Short) and horizontal (Full-Length) slots below.
  const vizSlotCard = (slot: VizSlot, url: string | null, title: string, blurb: string) => (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>{title}</p>
        <button
          onClick={() => openPicker(slot)}
          disabled={settingViz}
          className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 flex-shrink-0"
          style={{ backgroundColor: 'var(--surface-2)', color: 'var(--text)' }}
        >
          <Film size={14} />
          Choose from Media
        </button>
      </div>
      {url ? (
        <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--surface-2)' }}>
          <video src={url} controls loop autoPlay muted playsInline className="w-full max-h-80 object-contain bg-black" />
          <div className="p-3 flex flex-wrap justify-between items-center gap-2" style={{ backgroundColor: 'var(--bg-page)' }}>
            <span className="text-sm" style={{ color: 'var(--text-muted)' }}>{blurb}</span>
            <button
              onClick={() => setProjectVisualizer(slot, null)}
              disabled={settingViz}
              className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 flex-shrink-0"
              style={{ backgroundColor: 'var(--surface-2)', color: '#f87171' }}
            >
              <X size={14} />
              Remove
            </button>
          </div>
        </div>
      ) : (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>None set. {blurb}</p>
      )}
    </div>
  )

  // ── Project Visualizers section — the videos pinned to this project. Shown
  // on the project page (where onVisualizerUpdated is wired); rendered even
  // before any artwork exists so a previously set visualizer never disappears.
  const projectVizSection = projectId && onVisualizerUpdated ? (
    <div className="rounded-2xl p-5 space-y-5" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--surface-2)' }}>
      <div className="flex items-center gap-2">
        <MonitorPlay size={16} style={{ color: 'var(--text-muted)' }} />
        <p className="text-sm font-semibold" style={{ color: 'var(--text)' }}>Project Visualizers</p>
      </div>
      {vizSlotCard('canvas', projectViz, 'Vertical · player + Short',
        'Loops in the player while this track plays (like a Spotify Canvas) and is the source for Finalize Short.')}
      {vizSlotCard('wide', projectVizWide, 'Horizontal · full-length video',
        'The 16:9 loop behind the full-length YouTube render (Video tab → Finalize Full-Length).')}
      {vizError && <p className="text-sm" style={{ color: '#f87171' }}>{vizError}</p>}

      {/* Library picker — every saved loop the user owns, any project */}
      {pickerSlot && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0,0,0,0.75)' }}
          onClick={e => { if (e.target === e.currentTarget) setPickerSlot(null) }}
        >
          <div className="w-full max-w-2xl rounded-2xl overflow-hidden flex flex-col" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)', maxHeight: '85dvh' }}>
            <div className="flex items-center justify-between px-5 py-4 border-b flex-shrink-0" style={{ borderColor: 'var(--border)' }}>
              <h3 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
                {pickerSlot === 'wide' ? 'Choose the horizontal visualizer' : 'Choose the vertical visualizer'}
              </h3>
              <button onClick={() => setPickerSlot(null)} aria-label="Close" className="transition-colors" style={{ color: 'var(--text-muted)' }}>
                <X size={16} />
              </button>
            </div>
            <div className="p-4 overflow-y-auto overscroll-contain">
              {libraryLoading ? (
                <p className="text-sm text-center py-10" style={{ color: 'var(--text-muted)' }}>Loading…</p>
              ) : libraryError ? (
                <p className="text-sm text-center py-10" style={{ color: '#f87171' }}>{libraryError}</p>
              ) : library.length === 0 ? (
                <p className="text-sm text-center py-10" style={{ color: 'var(--text-muted)' }}>
                  No saved visualizers yet — generate one below and it will appear here.
                </p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {library.map(item => {
                    const isCurrent = (pickerSlot === 'wide' ? projectVizWide : projectViz) === item.video_url
                    return (
                      <button
                        key={item.id}
                        onClick={() => pickFromLibrary(item)}
                        disabled={settingViz}
                        className="text-left rounded-xl overflow-hidden transition-all disabled:opacity-50"
                        style={{
                          border: isCurrent ? '2px solid var(--accent)' : '1px solid var(--surface-2)',
                          backgroundColor: 'var(--bg-page)',
                        }}
                      >
                        <video
                          src={item.video_url}
                          poster={item.source_image_url ?? undefined}
                          muted
                          playsInline
                          loop
                          autoPlay
                          preload="metadata"
                          className="w-full aspect-square object-cover bg-black"
                        />
                        <div className="px-2.5 py-2">
                          <p className="text-xs font-medium truncate" style={{ color: 'var(--text)' }}>
                            {item.title ?? 'Visualizer'}
                          </p>
                          <p className="text-[10px] flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
                            {isCurrent ? (
                              <span className="flex items-center gap-1" style={{ color: 'var(--accent)' }}>
                                <Check size={10} strokeWidth={3} /> Current
                              </span>
                            ) : (
                              `${visualizerKindLabel(item.kind)} · ${new Date(item.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
                            )}
                          </p>
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  ) : null

  if (!artworkUrl) {
    return (
      <div className="max-w-4xl space-y-6">
        {projectVizSection}
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
      </div>
    )
  }

  const cfg = FORMAT_CONFIG[format]

  // Shared pill button style helper
  const pill = (active: boolean) => active
    ? { backgroundColor: 'var(--accent)', color: 'var(--bg-page)' }
    : { backgroundColor: 'var(--surface)', color: 'var(--text-muted)', border: '1px solid var(--surface-2)' }

  // Pin affordance for a persisted mf-video URL — only where the project page
  // wired the callback, and only once the video is saved. The slot follows the
  // render's orientation: 16:9 loops pin as the horizontal (Full-Length)
  // visualizer, everything else as the vertical (player + Short) one.
  const pinButton = (url: string | null, slot: VizSlot) => {
    if (!projectId || !onVisualizerUpdated || !url) return null
    const label = slot === 'wide' ? 'Horizontal Visualizer' : 'Vertical Visualizer'
    if ((slot === 'wide' ? projectVizWide : projectViz) === url) return (
      <span className="flex items-center gap-1 text-sm font-medium flex-shrink-0" style={{ color: 'var(--accent)' }}>
        <Check size={13} strokeWidth={3} /> {label}
      </span>
    )
    return (
      <button
        onClick={() => setProjectVisualizer(slot, url)}
        disabled={settingViz}
        className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 flex-shrink-0"
        style={{ backgroundColor: 'var(--surface-2)', color: 'var(--text)' }}
      >
        <MonitorPlay size={14} />
        {settingViz ? 'Setting…' : `Set as ${label}`}
      </button>
    )
  }

  // Orientation of the AI render, from the selected Runway ratio ('1280:720'
  // style). Wider-than-tall pins to the horizontal slot.
  const aiSlot: VizSlot = (() => {
    const [w, h] = selectedRatio.split(':').map(n => parseInt(n, 10))
    return Number.isFinite(w) && Number.isFinite(h) && w > h ? 'wide' : 'canvas'
  })()

  return (
    <div className="max-w-4xl space-y-6">
      {/* Hidden canvas used for frame rendering */}
      <canvas ref={canvasRef} style={{ display: 'none' }} />

      {projectVizSection}

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
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {EFFECT_IDS.map(key => (
              <button
                key={key}
                onClick={() => setEffect(key)}
                className="px-3 py-2 rounded-xl text-sm font-medium transition-colors text-left"
                style={pill(effect === key)}
              >
                <span className="block">{EFFECTS[key].label}</span>
                <span className="block text-[10px] opacity-70">{EFFECTS[key].description}</span>
              </button>
            ))}
          </div>
        </div>

        {/* BPM — only for beat-synced effects */}
        {EFFECTS[effect].beatSynced && (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>Track BPM</p>
            <input
              type="number"
              inputMode="numeric"
              min={60}
              max={200}
              value={bpm}
              onChange={e => setBpm(e.target.value)}
              onBlur={() => setBpm(String(bpmNum))}
              className="w-28 rounded-lg px-3 py-2 text-sm focus:outline-none transition-colors"
              style={{ backgroundColor: 'var(--bg-page)', border: '1px solid var(--surface-2)', color: 'var(--text)' }}
            />
            <p className="text-[11px] mt-1.5" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>
              Set this to your track&rsquo;s tempo — the effect pulses on the beat (snapped slightly so the loop stays seamless).
            </p>
          </div>
        )}

        {/* Live preview of the selected effect */}
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>Live Preview</p>
          <div className="rounded-xl overflow-hidden flex items-center justify-center" style={{ backgroundColor: '#000', border: '1px solid var(--surface-2)' }}>
            <canvas
              ref={previewRef}
              className="block"
              style={cfg.width > cfg.height
                ? { width: '100%', height: 'auto' }
                : { maxWidth: '100%', maxHeight: '18rem', width: 'auto', height: 'auto' }}
            />
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
            <video
              src={videoUrl}
              controls loop autoPlay muted playsInline
              className={cfg.width > cfg.height ? 'w-full bg-black' : 'w-full max-h-80 object-contain bg-black'}
            />
            <div className="p-3 flex flex-wrap justify-between items-center gap-2" style={{ backgroundColor: 'var(--bg-page)' }}>
              <span className="text-sm flex items-center gap-2" style={{ color: 'var(--text-muted)' }}>
                {cfg.label} · {Math.round(cfg.width * RENDER_SCALE)}×{Math.round(cfg.height * RENDER_SCALE)} · WebM
                {freeSave === 'saving' && <span className="text-[11px]">Saving…</span>}
                {freeSave === 'saved' && (
                  <span className="text-[11px] flex items-center gap-1" style={{ color: 'var(--accent)' }}>
                    <Check size={11} strokeWidth={3} /> Saved to Media
                  </span>
                )}
                {freeSave === 'error' && <span className="text-[11px]" style={{ color: '#f87171' }}>Save failed</span>}
              </span>
              {freeSave === 'saved' && pinButton(freeSavedUrl, format === 'youtube' ? 'wide' : 'canvas')}
              <button
                onClick={() => download(videoUrl, 'free', 'webm')}
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
      </div>

      {/* Error message */}
      {errorMsg && (
        <p className="text-sm" style={{ color: '#f87171' }}>{errorMsg}</p>
      )}
    </div>
  )
}
