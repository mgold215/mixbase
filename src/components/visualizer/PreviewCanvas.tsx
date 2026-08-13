'use client'

import { useEffect, useRef, useState } from 'react'
import { EFFECTS, domLayerFactory, type DrawFrame, type EffectId, type ParamValue } from '@/lib/free-effects'
import { FORMAT_CONFIG, type Format } from './shared'

type Props = {
  artworkUrl: string
  format: Format
  effect: EffectId
  // Already macro-resolved params — the exact record the recording will use.
  params: Record<string, ParamValue>
  bpm: number
  seed: number
  // Mirrors "a recording is in flight" so the preview pauses (frames skipped,
  // loop kept alive) instead of fighting the recorder for the main thread.
  renderingRef: React.RefObject<boolean>
}

// Live preview: run the selected effect in a visible canvas via rAF so the
// user sees the motion before committing to a render. Shares the recipe's
// seed + params with the recording, so what you see is exactly what you get.
export default function PreviewCanvas({ artworkUrl, format, effect, params, bpm, seed, renderingRef }: Props) {
  const previewRef = useRef<HTMLCanvasElement>(null)
  // Measured width of the live-preview box. Landscape previews render at the
  // box's full width (instead of a fixed 300px) so 16:9 formats fill the wide
  // panel edge to edge, like the exported video fills a wide screen.
  const [previewBoxW, setPreviewBoxW] = useState(0)

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

  // Params arrive as a fresh object every render — key the effect on their
  // serialized value so slider moves re-init the loop, but unrelated parent
  // re-renders don't.
  const paramsKey = JSON.stringify(params)

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
          bpm,
          seed,
          image: img,
          imageWidth: img.width,
          imageHeight: img.height,
          createLayer: domLayerFactory,
        }, JSON.parse(paramsKey) as Record<string, ParamValue>)
      } catch {
        return
      }
      const start = performance.now()
      // The effects are authored on a 30fps frame grid (that's what the
      // recording sweeps), so draw at most 30 preview frames per second: on a
      // 120Hz display an unthrottled rAF loop does 4× the canvas work for
      // zero visual gain and starves the main thread. Skipping ticks that
      // land on the same frame index also quantizes t to the exact frame
      // positions the recording uses.
      const totalFrames = cfg.duration * 30
      let lastFrame = -1
      const loop = () => {
        if (disposed) return
        if (!renderingRef.current) {
          const elapsed = (performance.now() - start) / 1000
          const frame = Math.floor(elapsed * 30) % totalFrames
          if (frame !== lastFrame) {
            lastFrame = frame
            try {
              draw(ctx, frame / totalFrames, frame)
            } catch {
              return // stop the preview quietly; recording has its own error path
            }
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
  }, [artworkUrl, effect, format, bpm, seed, paramsKey, previewBoxW, renderingRef])

  const cfg = FORMAT_CONFIG[format]
  return (
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
  )
}
