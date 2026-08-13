'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Dices, Download, Film, RotateCcw } from 'lucide-react'
import {
  EFFECTS, EFFECT_IDS, domLayerFactory,
  type DrawFrame, type ParamSpec,
} from '@/lib/free-effects'
import { MACROS, applyMacros } from '@/lib/fx/recipe'
import type { VizRecipe } from '@/lib/fx/types'
import { canExportMp4, exportMp4 } from '@/lib/fx/export'
import { uploadVisualizer, VizUploadError } from '@/lib/fx/upload'
import type { VizRecipeAction } from './useVizRecipe'
import { FORMAT_CONFIG, clampBpm, pill, type Format, type SaveStatus, type VizSlot } from './shared'
import PreviewCanvas from './PreviewCanvas'

// Exports render at the format's NATIVE resolution (1080×1920 / 1920×1080 /
// 1080×1080; 4K on capable hardware). The old always-half-scale render
// survives only as the last-resort retry when full-res MediaRecorder capture
// fails on a weak machine — that floor equals the previous behavior exactly.
const FALLBACK_SCALE = 0.5

// 4K option for the YouTube format (16:9 only — vertical platforms cap at
// 1080×1920), shown when the hardware encoder supports it.
const UHD = { width: 3840, height: 2160 }

// Record the frame loop into a WebM blob. Module scope on purpose: the loop's
// wall-clock pacing (performance.now) is impure, and hoisting it out of the
// component keeps the React Compiler's render-purity analysis clean. Resolves
// null on a deliberate cancel; rejects on recorder/encoder failure.
async function recordFrames(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  drawFrame: DrawFrame,
  duration: number,
  videoBitsPerSecond: number,
  isCancelled: () => boolean,
  onProgress: (pct: number) => void,
): Promise<Blob | null> {
  const FPS = 30
  const TOTAL_FRAMES = duration * FPS
  const stream = canvas.captureStream(FPS)
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9'
    : 'video/webm'
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
  // Real dimensions + container of the finished render, for the result label.
  const [resultMeta, setResultMeta] = useState<{ w: number; h: number; mime: 'MP4' | 'WebM' } | null>(null)
  // Whether this hardware can encode 4K H.264 — gates the YouTube 4K toggle.
  const [supports4k, setSupports4k] = useState(false)
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

  // 4K is offered only when the hardware encoder actually supports it.
  useEffect(() => {
    let stale = false
    if (format !== 'youtube') return
    canExportMp4(UHD.width, UHD.height).then(ok => {
      if (!stale) setSupports4k(ok)
    }).catch(() => {})
    return () => { stale = true }
  }, [format])

  async function generateFree() {
    if (!artworkUrl) return

    cancelledRef.current = false

    setStatus('rendering')
    setProgress(0)
    setVideoUrl(null)
    setErrorMsg('')
    setFreeSave('idle')
    setFreeSavedUrl(null)
    setResultMeta(null)

    const wantHigh = format === 'youtube' && recipe.resolution === 'high' && supports4k
    const exportW = wantHigh ? UHD.width : cfg.width
    const exportH = wantHigh ? UHD.height : cfg.height

    // Prefer WebCodecs: exact frame grid (perfect loop), native resolution,
    // hardware encode faster than realtime, MP4 out (no server transcode).
    const mp4Capable = await canExportMp4(exportW, exportH)
    const canvas = canvasRef.current
    const recorderCapable =
      typeof MediaRecorder !== 'undefined' && typeof canvas?.captureStream === 'function'
    if (!canvas || (!mp4Capable && !recorderCapable)) {
      setStatus('error')
      setErrorMsg('Video recording is not supported in this browser. Try Chrome or Firefox.')
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

    // Build the effect's frame renderer at the requested dimensions. Shares
    // the recipe's seed + resolved params with the preview (resolution
    // independence means the motion is identical at any size).
    const makeDraw = (W: number, H: number): DrawFrame | null => {
      try {
        return EFFECTS[effect].create({
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
        return null
      }
    }

    const TOTAL_FRAMES = cfg.duration * 30

    if (mp4Capable) {
      canvas.width = exportW
      canvas.height = exportH
      const ctx = canvas.getContext('2d')
      const drawFrame = ctx ? makeDraw(exportW, exportH) : null
      if (!ctx || !drawFrame) {
        setStatus('error')
        setErrorMsg('Could not initialize the effect renderer. Try a different image.')
        return
      }
      try {
        const blob = await exportMp4({
          canvas,
          drawFrame: f => drawFrame(ctx, f / TOTAL_FRAMES, f),
          totalFrames: TOTAL_FRAMES,
          fps: 30,
          isCancelled: () => cancelledRef.current,
          onProgress: setProgress,
        })
        if (!blob) return // deliberate cancel (format switch/unmount)
        finishRender(blob, 'video/mp4', exportW, exportH)
        return
      } catch {
        if (cancelledRef.current) return
        // Encoder failed mid-flight (rare driver/OOM cases) — fall through to
        // the MediaRecorder path when it exists, else surface the error.
        if (!recorderCapable) {
          setStatus('error')
          setErrorMsg('Video rendering failed in this browser. Try Chrome or Firefox, or a different image.')
          return
        }
      }
    }

    // MediaRecorder fallback — now at NATIVE resolution with a healthy bitrate
    // (~45 MB ceiling; the signed-URL upload path has no 10 MB wall). A throw
    // here (weak GPU at full res, tainted canvas, codec trouble) retries once
    // at the legacy half scale + 10 MB-safe bitrate — exactly the pre-upgrade
    // output, so the floor never regresses.
    const runRecorder = async (scale: number, bitrate: number) => {
      const W = Math.round(cfg.width * scale)
      const H = Math.round(cfg.height * scale)
      canvas.width = W
      canvas.height = H
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('no 2d context')
      const drawFrame = makeDraw(W, H)
      if (!drawFrame) throw new Error('effect init failed')
      const blob = await recordFrames(
        canvas, ctx, drawFrame, cfg.duration, bitrate,
        () => cancelledRef.current,
        setProgress,
      )
      return blob ? { blob, W, H } : null
    }
    try {
      // ~30 MB ceiling: keeps the worst-case webm well inside the server
      // transcoder's 60 s SIGKILL window (6 s clips still get the full 12 Mbps).
      const fullBitrate = Math.min(12_000_000, Math.floor((30 * 8 * 1024 * 1024) / cfg.duration))
      const r = await runRecorder(1, fullBitrate)
      if (!r) return
      finishRender(r.blob, 'video/webm', r.W, r.H)
    } catch {
      if (cancelledRef.current) return
      try {
        const legacyBitrate = Math.min(3_500_000, Math.floor((8.5 * 8 * 1024 * 1024) / cfg.duration))
        const r = await runRecorder(FALLBACK_SCALE, legacyBitrate)
        if (!r) return
        finishRender(r.blob, 'video/webm', r.W, r.H)
      } catch {
        if (!cancelledRef.current) {
          setStatus('error')
          setErrorMsg('Video rendering failed in this browser. Try Chrome or Firefox, or a different image.')
        }
      }
    }
  }

  function finishRender(blob: Blob, contentType: 'video/mp4' | 'video/webm', w: number, h: number) {
    const url = URL.createObjectURL(blob)
    setVideoUrl(prev => {
      if (prev) URL.revokeObjectURL(prev)
      return url
    })
    setStatus('done')
    setProgress(100)
    setResultMeta({ w, h, mime: contentType === 'video/mp4' ? 'MP4' : 'WebM' })
    // Persist to the Media library so it's findable later (not just a throwaway
    // blob: URL). Playback above is instant from the local blob; this runs after.
    void saveRendered(blob, contentType)
  }

  async function saveRendered(blob: Blob, contentType: 'video/mp4' | 'video/webm') {
    if (!projectId) return
    setFreeSave('saving')
    const title = `${FORMAT_CONFIG[format].label} · ${EFFECTS[effect].label}`
    try {
      // Primary: signed-URL PUT direct to storage + JSON finalize — carries any
      // size and persists the recipe alongside the clip.
      const up = await uploadVisualizer({
        blob, contentType, projectId, title,
        settings: recipe,
        sourceImageUrl: artworkUrl ?? null,
      })
      setFreeSavedUrl(up.video_url)
      setFreeSave('saved')
      return
    } catch (err) {
      // The proven multipart path still works for small webm blobs — use it as
      // the safety net when the signed path hiccups. Oversized or mp4 blobs
      // have no legacy lane; report the failure honestly.
      const legacyEligible =
        err instanceof VizUploadError &&
        contentType === 'video/webm' &&
        blob.size <= 9.5 * 1024 * 1024
      if (!legacyEligible) {
        setFreeSave('error')
        return
      }
    }
    try {
      const fd = new FormData()
      fd.append('file', blob, 'visualizer.webm')
      fd.append('projectId', projectId)
      fd.append('title', title)
      fd.append('settings', JSON.stringify(recipe))
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
        {/* 4K is a YouTube-only offer, shown when the hardware encoder can */}
        {format === 'youtube' && supports4k && (
          <div className="flex items-center gap-2 mt-3">
            <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Resolution</span>
            {([['standard', '1080p'], ['high', '4K']] as const).map(([value, label]) => (
              <button
                key={value}
                onClick={() => dispatch({ type: 'resolution', resolution: value })}
                className="px-2.5 py-1 rounded-lg text-xs font-medium transition-colors"
                style={pill(recipe.resolution === value)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
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
              {cfg.label}{resultMeta ? ` · ${resultMeta.w}×${resultMeta.h} · ${resultMeta.mime}` : ''}
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
              onClick={() => download(videoUrl, 'free', resultMeta?.mime === 'MP4' ? 'mp4' : 'webm')}
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
