'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Dices, Download, Film, RotateCcw } from 'lucide-react'
import {
  EFFECTS, EFFECT_IDS, domLayerFactory,
  type DrawFrame, type EffectId, type ParamSpec,
} from '@/lib/free-effects'
import { MACROS, applyMacros } from '@/lib/fx/recipe'
import type { VizRecipe } from '@/lib/fx/types'
import type { VizRecipeAction } from './useVizRecipe'
import { FORMAT_CONFIG, clampBpm, pill, type Format, type SaveStatus, type VizSlot } from './shared'
import PreviewCanvas from './PreviewCanvas'

// The free canvas render draws at 1/2 scale for browser performance, so the
// output is half the format's nominal resolution. Kept here so the render
// and the result label agree. (Full-resolution WebCodecs export lands in the
// next phase of the FX engine upgrade.)
const RENDER_SCALE = 0.5

// Record the frame loop into a WebM blob. Module scope on purpose: the loop's
// wall-clock pacing (performance.now) is impure, and hoisting it out of the
// component keeps the React Compiler's render-purity analysis clean. Resolves
// null on a deliberate cancel; rejects on recorder/encoder failure.
async function recordFrames(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  drawFrame: DrawFrame,
  duration: number,
  isCancelled: () => boolean,
  onProgress: (pct: number) => void,
): Promise<Blob | null> {
  const FPS = 30
  const TOTAL_FRAMES = duration * FPS
  const stream = canvas.captureStream(FPS)
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9'
    : 'video/webm'
  // Cap the bitrate so the longest render (30s YouTube) stays comfortably
  // under /api/visualizer/save's 10 MB limit (~8.5 MB budget).
  const videoBitsPerSecond = Math.min(3_500_000, Math.floor((8.5 * 8 * 1024 * 1024) / duration))
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond })
  const chunks: Blob[] = []
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data) }

  const blobReady = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }))
    // A recorder-level failure (encoder error, the capture stream ending)
    // fires 'error' and may never fire 'stop' — without this the await below
    // would hang and the button would stay stuck on "Rendering…" forever
    // (a hang is not a throw, so the catch never runs). Reject so the caller
    // resets to the error state, like the tainted-canvas path.
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

    onProgress(Math.round((frame / TOTAL_FRAMES) * 100))

    if (isCancelled()) {
      recorder.stop()
      return null
    }

    // Pace against an absolute schedule (not a fixed per-frame sleep) so
    // draw time doesn't stretch the recording past the nominal duration.
    const wait = startTime + ((frame + 1) * 1000) / FPS - performance.now()
    await new Promise(r => setTimeout(r, Math.max(0, wait)))
  }

  recorder.stop()
  return blobReady
}

type Props = {
  projectId?: string
  artworkUrl: string
  recipe: VizRecipe
  dispatch: (action: VizRecipeAction) => void
  onSelectFormat: (format: Format) => void
  pinButton: (url: string | null, slot: VizSlot) => React.ReactNode
  download: (url: string, suffix: string, ext: 'webm' | 'mp4') => void
  downloadErr: string | null
  finishSave: (() => Promise<void>) | null
  onFinishSaveTap: () => void
}

// The free FX studio: presets (the 12 scene effects), macro sliders, advanced
// per-effect fine-tuning, seed control, live preview, and the render/save
// pipeline. Every knob feeds one VizRecipe; applyMacros() resolves it to the
// exact params both the preview and the recording consume.
export default function FreeStudio({
  projectId, artworkUrl, recipe, dispatch, onSelectFormat,
  pinButton, download, downloadErr, finishSave, onFinishSaveTap,
}: Props) {
  const [status, setStatus] = useState<'idle' | 'rendering' | 'done' | 'error'>('idle')
  const [progress, setProgress] = useState(0)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState('')
  const [freeSave, setFreeSave] = useState<SaveStatus>('idle')
  // Persisted mf-video URL of the last free render — the blob: URL plays
  // locally, but only the stored URL can be pinned as the project visualizer.
  const [freeSavedUrl, setFreeSavedUrl] = useState<string | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  // Raw input string so typing "1" mid-edit isn't clamped out from under the
  // user; clampBpm() is applied wherever the number is consumed.
  const [bpmText, setBpmText] = useState(String(recipe.bpm))
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const cancelledRef = useRef(false)
  // Mirrors status === 'rendering' for the preview rAF loop, which must not
  // re-init (and restart the loop position) every time status flips.
  const renderingRef = useRef(false)

  const effect = recipe.scene.id
  const format = recipe.format
  const cfg = FORMAT_CONFIG[format]
  const bpmNum = clampBpm(bpmText, recipe.bpm)

  // The exact params the recording will use — macros applied over the base
  // params, clamped to each spec. The preview consumes the same object.
  const effectiveParams = useMemo(
    () => applyMacros(effect, recipe.scene.params, recipe.macros),
    [effect, recipe.scene.params, recipe.macros],
  )

  useEffect(() => { renderingRef.current = status === 'rendering' }, [status])

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl)
    }
  }, [videoUrl])

  // If the component unmounts mid-render (e.g. the Media modal is closed while
  // a free render is in flight), signal the frame loop to stop so it doesn't
  // keep drawing + recording on a dead instance. Empty deps → unmount only.
  useEffect(() => {
    return () => { cancelledRef.current = true }
  }, [])

  // Format switches remount this component (key={format} in the container),
  // which cancels any in-flight render via the unmount effect above and
  // resets all transient state — the old resetFormat() behavior, without an
  // effect that calls setState.

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

    // Render at 1/2 scale for browser performance; output is still valid video
    const W = Math.round(cfg.width * RENDER_SCALE)
    const H = Math.round(cfg.height * RENDER_SCALE)

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
    // the recipe's seed + resolved params with the preview, so the recording
    // matches what the preview showed.
    let drawFrame: DrawFrame
    try {
      drawFrame = EFFECTS[effect].create({
        W, H,
        duration: cfg.duration,
        fps: 30,
        bpm: bpmNum,
        seed: recipe.seed,
        image: img,
        imageWidth: img.width,
        imageHeight: img.height,
        createLayer: domLayerFactory,
      }, effectiveParams)
    } catch {
      setStatus('error')
      setErrorMsg('Could not initialize the effect renderer. Try a different image.')
      return
    }

    // Run the recorder. Any throw in here — a tainted canvas SecurityError
    // (artwork served without CORS headers), captureStream being unavailable,
    // or an unsupported codec — must reset the button, not leave it stuck on
    // "Rendering…" forever. Happy path is unchanged (the catch only runs on a
    // real throw). Matches the try/finally-resets-loading pattern.
    try {
      const blob = await recordFrames(
        canvas, ctx, drawFrame, cfg.duration,
        () => cancelledRef.current,
        setProgress,
      )
      if (!blob) return // deliberate cancel (format switch/unmount)
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
      // Don't clobber a deliberate cancel (format switch/unmount) with an error.
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

  // One advanced param row: slider with live value, or an on/off toggle.
  const paramRow = (spec: ParamSpec) => {
    const value = effectiveParams[spec.id]
    const base = recipe.scene.params[spec.id] ?? spec.default
    if (spec.type === 'toggle') {
      return (
        <div key={spec.id} className="flex items-center justify-between gap-3 py-1">
          <span className="text-sm" style={{ color: 'var(--text)' }}>{spec.label}</span>
          <button
            onClick={() => dispatch({ type: 'param', id: spec.id, value: !(base as boolean) })}
            className="px-3 py-1 rounded-lg text-xs font-medium transition-colors"
            style={pill(base as boolean)}
          >
            {(base as boolean) ? 'On' : 'Off'}
          </button>
        </div>
      )
    }
    const step = spec.step ?? 0.01
    const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 2
    return (
      <div key={spec.id} className="py-1">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm" style={{ color: 'var(--text)' }}>{spec.label}</span>
          <span className="text-xs tabular-nums" style={{ color: 'var(--text-muted)' }}>
            {(value as number).toFixed(decimals)}
          </span>
        </div>
        <input
          type="range"
          min={spec.min}
          max={spec.max}
          step={step}
          value={base as number}
          onChange={e => dispatch({ type: 'param', id: spec.id, value: parseFloat(e.target.value) })}
          className="w-full accent-[var(--accent)]"
        />
      </div>
    )
  }

  return (
    <div className="rounded-2xl p-5 space-y-5" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--surface-2)' }}>
      {/* Hidden canvas used for frame rendering */}
      <canvas ref={canvasRef} style={{ display: 'none' }} />

      <div className="flex items-center gap-2">
        <Film size={16} style={{ color: 'var(--text-muted)' }} />
        <p className="text-sm font-semibold" style={{ color: 'var(--text)' }}>Free FX Studio</p>
      </div>

      {/* Format selector */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>Export Format</p>
        <div className="flex flex-wrap gap-2">
          {(Object.entries(FORMAT_CONFIG) as [Format, typeof FORMAT_CONFIG[Format]][]).map(([key, val]) => (
            <button
              key={key}
              onClick={() => onSelectFormat(key)}
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
              onClick={() => dispatch({ type: 'scene', id: key })}
              className="px-3 py-2 rounded-xl text-sm font-medium transition-colors text-left"
              style={pill(effect === key)}
            >
              <span className="block">{EFFECTS[key].label}</span>
              <span className="block text-[10px] opacity-70">{EFFECTS[key].description}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Macro sliders + seed — the coarse "make it mine" controls */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Character</p>
          <button
            onClick={() => dispatch({ type: 'seed', seed: Math.floor(Math.random() * 2 ** 31) })}
            className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-lg transition-colors"
            style={{ backgroundColor: 'var(--surface-2)', color: 'var(--text)' }}
            title={`Seed ${recipe.seed} — same seed, same motion`}
          >
            <Dices size={13} />
            Shuffle · #{recipe.seed % 10000}
          </button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-5 gap-y-2">
          {MACROS.map(m => (
            <div key={m.id}>
              <div className="flex items-center justify-between">
                <span className="text-sm" style={{ color: 'var(--text)' }}>{m.label}</span>
                <span className="text-xs tabular-nums" style={{ color: 'var(--text-muted)' }}>
                  {Math.round((recipe.macros[m.id] ?? 0.5) * 100)}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={recipe.macros[m.id] ?? 0.5}
                onChange={e => dispatch({ type: 'macro', id: m.id, value: parseFloat(e.target.value) })}
                className="w-full accent-[var(--accent)]"
              />
            </div>
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
            value={bpmText}
            onChange={e => setBpmText(e.target.value)}
            onBlur={() => {
              setBpmText(String(bpmNum))
              dispatch({ type: 'bpm', bpm: bpmNum })
            }}
            className="w-28 rounded-lg px-3 py-2 text-sm focus:outline-none transition-colors"
            style={{ backgroundColor: 'var(--bg-page)', border: '1px solid var(--surface-2)', color: 'var(--text)' }}
          />
          <p className="text-[11px] mt-1.5" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>
            Set this to your track&rsquo;s tempo — the effect pulses on the beat (snapped slightly so the loop stays seamless).
          </p>
        </div>
      )}

      {/* Live preview of the selected effect + current recipe */}
      <PreviewCanvas
        artworkUrl={artworkUrl}
        format={format}
        effect={effect}
        params={effectiveParams}
        bpm={bpmNum}
        seed={recipe.seed}
        renderingRef={renderingRef}
      />

      {/* Advanced per-effect fine-tuning */}
      <div className="rounded-xl" style={{ border: '1px solid var(--surface-2)' }}>
        <button
          onClick={() => setAdvancedOpen(o => !o)}
          className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium transition-colors"
          style={{ color: 'var(--text)' }}
        >
          <span>Fine-tune {EFFECTS[effect].label}</span>
          <ChevronDown size={15} style={{ transform: advancedOpen ? 'rotate(180deg)' : undefined, transition: 'transform 150ms', color: 'var(--text-muted)' }} />
        </button>
        {advancedOpen && (
          <div className="px-4 pb-4 space-y-1">
            {EFFECTS[effect].params.map(paramRow)}
            <div className="pt-2">
              <button
                onClick={() => dispatch({ type: 'resetParams' })}
                className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg transition-colors"
                style={{ backgroundColor: 'var(--surface-2)', color: 'var(--text-muted)' }}
              >
                <RotateCcw size={12} />
                Reset to defaults
              </button>
            </div>
          </div>
        )}
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

      {/* Error message */}
      {errorMsg && (
        <p className="text-sm" style={{ color: '#f87171' }}>{errorMsg}</p>
      )}
    </div>
  )
}
