'use client'

import { useEffect, useRef, useCallback, type PointerEvent as ReactPointerEvent } from 'react'
import { resamplePeaks } from '@/lib/waveform-peaks'

// The share page's waveform: real peaks from GET /api/share/<token>/peaks,
// drawn on a canvas, tinted with the artwork's accent as it fills. Dragging or
// tapping seeks; releasing also reports where, so the page can offer "Note at
// 1:32". Until the peaks arrive the caller renders a shimmer in its place; if
// they never arrive (`peaks` = []) a flat, even bar set is drawn so the
// scrubber still works.

type Props = {
  peaks: number[]
  /** 0–1 */
  progress: number
  accent: [number, number, number]
  onSeek: (fraction: number) => void
  /** Called when a pointer gesture ends — the fraction the user landed on. */
  onSeekEnd?: (fraction: number) => void
  className?: string
}

export default function ShareWaveform({ peaks, progress, accent, onSeek, onSeekEnd, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const lastFraction = useRef(0)

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const dpr = Math.min(window.devicePixelRatio || 1, 3)
    const w = wrap.clientWidth
    const h = wrap.clientHeight
    if (w === 0 || h === 0) return
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const gap = 2
    const barW = w < 420 ? 3 : 4
    const count = Math.max(24, Math.floor(w / (barW + gap)))
    const bars = peaks.length > 0 ? resamplePeaks(peaks, count) : new Array<number>(count).fill(40)
    const [r, g, b] = accent
    const mid = h / 2
    const minH = 3
    const playedUntil = progress * count

    for (let i = 0; i < count; i++) {
      const x = i * (barW + gap)
      const v = bars[i] / 100
      const bh = Math.max(minH, v * (h - 2))
      const played = i + 1 <= playedUntil
      const partial = !played && i < playedUntil
      ctx.fillStyle = played
        ? `rgba(${r},${g},${b},0.95)`
        : partial ? `rgba(${r},${g},${b},0.6)` : 'rgba(255,255,255,0.28)'
      roundRect(ctx, x, mid - bh / 2, barW, bh, barW / 2)
    }
  }, [peaks, progress, accent])

  useEffect(() => { draw() }, [draw])
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => draw())
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [draw])

  const fractionAt = (e: ReactPointerEvent) => {
    const rect = wrapRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return 0
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
  }
  const onDown = (e: ReactPointerEvent) => {
    dragging.current = true
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    const f = fractionAt(e)
    lastFraction.current = f
    onSeek(f)
  }
  const onMove = (e: ReactPointerEvent) => {
    if (!dragging.current) return
    const f = fractionAt(e)
    lastFraction.current = f
    onSeek(f)
  }
  const onUp = () => {
    if (!dragging.current) return
    dragging.current = false
    onSeekEnd?.(lastFraction.current)
  }

  return (
    <div
      ref={wrapRef}
      className={`relative select-none touch-none cursor-pointer ${className ?? ''}`}
      role="slider"
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress * 100)}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      <canvas ref={canvasRef} className="block w-full h-full" />
    </div>
  )
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.lineTo(x + w - rr, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr)
  ctx.lineTo(x + w, y + h - rr)
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h)
  ctx.lineTo(x + rr, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr)
  ctx.lineTo(x, y + rr)
  ctx.quadraticCurveTo(x, y, x + rr, y)
  ctx.closePath()
  ctx.fill()
}
