'use client'

import { useEffect, useRef, useState, useCallback, type RefObject } from 'react'

// The "alive" layer shared by the two public players (the single-track page's
// ShareClient and the album page's AlbumPlayer): the waveform fetch, the
// music-driven --energy variable, and the desktop parallax. Kept together so
// the two pages cannot drift apart in feel.

// ── Waveform peaks ──────────────────────────────────────────────────────────
// GET /api/share/<token>/peaks[?project=<id>] answers 200 with the peaks, or
// 202 while a long mix is still decoding. Poll gently for a couple of minutes,
// then give up to [] — the caller draws plain bars and the scrubber still works.
const PEAKS_POLL_MS = 8000
const PEAKS_POLL_MAX = 15

export async function fetchPeaks(url: string, signal: AbortSignal): Promise<number[]> {
  for (let attempt = 0; attempt <= PEAKS_POLL_MAX; attempt++) {
    let res: Response
    try {
      res = await fetch(url, { signal })
    } catch {
      return []
    }
    if (res.status === 202 && attempt < PEAKS_POLL_MAX) {
      await new Promise<void>(resolve => {
        const t = setTimeout(resolve, PEAKS_POLL_MS)
        signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
      })
      if (signal.aborted) return []
      continue
    }
    if (!res.ok) return []
    const data = await res.json().catch(() => null) as { peaks?: unknown } | null
    return Array.isArray(data?.peaks) && data.peaks.length > 0 ? (data.peaks as number[]) : []
  }
  return []
}

// ── Music-driven energy ─────────────────────────────────────────────────────
// One CSS variable, --energy (0–1), on the player's root element; the play
// button's glow, the cover's scale and the backdrop wash read it.
//
// Two sources, chosen once:
//   · An AnalyserNode on the same-origin audio proxy — beat-accurate. Created
//     inside the first play tap (autoplay policy) by `ensureAnalyser`, resumed
//     on every play. NOT on iOS: once an element is routed through an
//     AudioContext, Safari silences it when the screen locks or the app goes
//     to the background — and listening with the phone in a pocket is exactly
//     what the share page is for. The native element must stay the audio path.
//   · The waveform peaks at the playhead — coarse (one bar is a second or two
//     of music) but free, works everywhere, and never touches the audio graph.
// Either way the analyser is decoration: if anything fails, the element plays
// as it always did.
export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false
  return /iP(hone|ad|od)/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

type EnergyOptions = {
  audioRef: RefObject<HTMLAudioElement | null>
  rootRef: RefObject<HTMLElement | null>
  isPlaying: boolean
  /** Waveform peaks (0–100) and the playhead fraction — the fallback source. */
  peaks: number[] | null
  progress: number
}

export function useAudioEnergy({ audioRef, rootRef, isPlaying, peaks, progress }: EnergyOptions): { ensureAnalyser: () => void } {
  const ctxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const rafRef = useRef<number | null>(null)
  const energyRef = useRef(0)
  // Read by the animation loop without re-arming it on every timeupdate.
  const progressRef = useRef(progress)
  const peaksRef = useRef(peaks)
  useEffect(() => { progressRef.current = progress }, [progress])
  useEffect(() => { peaksRef.current = peaks }, [peaks])

  const ensureAnalyser = useCallback(() => {
    const audio = audioRef.current
    if (!audio || ctxRef.current || isIOS()) return
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    let ctx: AudioContext | null = null
    let source: MediaElementAudioSourceNode | null = null
    try {
      ctx = new Ctx()
      source = ctx.createMediaElementSource(audio)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.82
      source.connect(analyser)
      analyser.connect(ctx.destination)
      ctxRef.current = ctx
      analyserRef.current = analyser
    } catch {
      // Once an element is wired into a context it only sounds through it —
      // if the analyser failed after that point, keep the audio audible.
      try { if (ctx && source) source.connect(ctx.destination) } catch { /* nothing more to do */ }
      if (ctx) ctxRef.current = ctx
    }
    ctx?.resume().catch(() => {})
  }, [audioRef])

  // A lock-screen or headset play lands without a tap — wake the context too,
  // or an element wired through it stays mute.
  useEffect(() => {
    if (isPlaying) ctxRef.current?.resume().catch(() => {})
  }, [isPlaying])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const setEnergy = (e: number) => root.style.setProperty('--energy', e.toFixed(3))
    if (!isPlaying) {
      // Ease the glow back down rather than snapping it off.
      const decay = () => {
        energyRef.current *= 0.85
        setEnergy(energyRef.current)
        if (energyRef.current > 0.01) rafRef.current = requestAnimationFrame(decay)
      }
      rafRef.current = requestAnimationFrame(decay)
      return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
    }
    const analyser = analyserRef.current
    const bins = analyser ? new Uint8Array(analyser.frequencyBinCount) : null
    let last = performance.now()
    const tick = (now: number) => {
      let raw: number
      if (analyser && bins) {
        analyser.getByteFrequencyData(bins)
        // Low/mid bins carry the beat; the top of the spectrum is mostly hiss.
        let sum = 0
        const n = Math.min(40, bins.length)
        for (let i = 0; i < n; i++) sum += bins[i]
        raw = Math.min(1, (sum / n / 255) * 1.35)
      } else {
        const p = peaksRef.current
        if (p && p.length > 0) {
          const i = Math.min(p.length - 1, Math.floor(progressRef.current * p.length))
          raw = (p[i] / 100) * 0.9
        } else {
          // No data at all: a slow, gentle breath so the page is never dead.
          raw = 0.35 + 0.15 * Math.sin(now / 900)
        }
      }
      // Frame-rate independent smoothing (~0.25 per 16 ms frame).
      const dt = Math.min(64, now - last)
      last = now
      const k = 1 - Math.pow(0.75, dt / 16)
      energyRef.current += (raw - energyRef.current) * k
      setEnergy(energyRef.current)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [isPlaying, rootRef])

  return { ensureAnalyser }
}

// ── Parallax ────────────────────────────────────────────────────────────────
// Desktop only (a fine pointer): the backdrop follows the mouse by a few
// pixels. Phones keep the slow drift alone — tilt would need a permission
// prompt on iOS, which is not worth it for a page you open from a text.
export function useParallax(rootRef: RefObject<HTMLElement | null>, bgRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia('(pointer: fine)').matches) return
    const root = rootRef.current
    const bg = bgRef.current
    if (!root || !bg) return
    let frame: number | null = null
    const onMove = (e: PointerEvent) => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = null
        const r = root.getBoundingClientRect()
        const dx = ((e.clientX - r.left) / r.width - 0.5) * -16
        const dy = ((e.clientY - r.top) / r.height - 0.5) * -12
        bg.style.transform = `translate3d(${dx.toFixed(1)}px, ${dy.toFixed(1)}px, 0)`
      })
    }
    root.addEventListener('pointermove', onMove)
    return () => { root.removeEventListener('pointermove', onMove); if (frame) cancelAnimationFrame(frame) }
  }, [rootRef, bgRef])
}

// Which loop fits the screen: phones get the 9:16 Canvas, laptops the 16:9.
// Starts true (the phone case — most links are opened from a text) and
// corrects itself on mount and on rotation.
export function usePortrait(): boolean {
  const [portrait, setPortrait] = useState(true)
  useEffect(() => {
    const mq = window.matchMedia('(orientation: portrait)')
    const apply = () => setPortrait(mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])
  return portrait
}
