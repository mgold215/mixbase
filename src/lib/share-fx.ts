'use client'

import { useEffect, useRef, useState, useCallback, type RefObject } from 'react'
import { DEFAULT_PALETTE, PENDING_PALETTE, paletteFromPixels, type SharePalette } from '@/lib/share-palette'

// The "alive" layer shared by the two public players (the single-track page's
// ShareClient and the album page's AlbumPlayer): the waveform fetch, the
// cover's colours, the music-driven --energy and --beat variables, and the
// desktop parallax. Kept together so the two pages cannot drift apart in feel.
// What is DRAWN with these lives in src/components/ShareStage.tsx.

// ── The cover's colours ─────────────────────────────────────────────────────
// The picture is decoded onto a small canvas and its pixels handed to
// src/lib/share-palette.ts. Storage serves covers with
// Access-Control-Allow-Origin: *, which is what lets a canvas read them; if
// that ever fails (or the image does) the page keeps its default colours.
const PALETTE_SAMPLE = 40
const paletteCache = new Map<string, SharePalette>()

export function loadPalette(url: string): Promise<SharePalette> {
  const known = paletteCache.get(url)
  if (known) return Promise.resolve(known)
  return new Promise(resolve => {
    const img = new window.Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      try {
        const c = document.createElement('canvas')
        c.width = c.height = PALETTE_SAMPLE
        const ctx = c.getContext('2d', { willReadFrequently: true })
        if (!ctx) return resolve(DEFAULT_PALETTE)
        ctx.drawImage(img, 0, 0, PALETTE_SAMPLE, PALETTE_SAMPLE)
        const palette = paletteFromPixels(ctx.getImageData(0, 0, PALETTE_SAMPLE, PALETTE_SAMPLE).data)
        paletteCache.set(url, palette)
        resolve(palette)
      } catch { resolve(DEFAULT_PALETTE) }
    }
    img.onerror = () => resolve(DEFAULT_PALETTE)
    img.src = url
  })
}

// The palette for `url`. Until the first cover has been read the page wears
// PENDING_PALETTE (no colour, lights down) so the colours come up once, in the
// right hue; while a later cover is being read (the album page, on a track
// change) the previous colours stay up. No cover at all: the default violet.
export function useArtPalette(url: string | null): SharePalette {
  const [palette, setPalette] = useState<SharePalette>(() => (url ? paletteCache.get(url) ?? PENDING_PALETTE : DEFAULT_PALETTE))
  useEffect(() => {
    let live = true
    const apply = (p: SharePalette) => { if (live) setPalette(p) }
    if (url) loadPalette(url).then(apply)
    else Promise.resolve(DEFAULT_PALETTE).then(apply)
    return () => { live = false }
  }, [url])
  return palette
}

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
// Two CSS variables on the player's root element, both 0–1:
//   --energy  how loud the music is right now (smoothed) — the lights, the
//             glow behind the title and the cover, the play button's halo.
//   --beat    the kick: jumps on each hit and falls away before the next — the
//             cover's pulse, the flash of colour on the title.
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
//     That is loudness only, with no kick in it, so on this path --beat
//     stays 0: the lights and glows follow how loud the music is, and the
//     constant motion (drifting lights, the floating cover) carries the rest.
//     (A tempo-locked pulse would need the song's BPM in the public payload,
//     which scripts/share-projection-test.mjs deliberately keeps out.)
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

// The kick is listened for below this frequency…
const KICK_CUTOFF_HZ = 140
// …and a jump smaller than KICK_MIN_JUMP (as a share of the low end's recent
// level) is never a hit: a steady bass note ripples by a few percent as it is
// measured. KICK_MAX_JUMP caps what one jump may teach the yardstick. Under
// KICK_SILENCE (as a waveform level, 1 = full scale) there is nothing down
// there to judge.
const KICK_MIN_JUMP = 0.3
const KICK_MAX_JUMP = 1.2
const KICK_SILENCE = 0.01

export function useAudioEnergy({ audioRef, rootRef, isPlaying, peaks, progress }: EnergyOptions): { ensureAnalyser: () => void } {
  const ctxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  // A second analyser for the kick, fed the low end only (see ensureAnalyser).
  const kickRef = useRef<AnalyserNode | null>(null)
  const rafRef = useRef<number | null>(null)
  const energyRef = useRef(0)
  const beatRef = useRef(0)
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
    // The kick's own branch, BESIDE the sound's path rather than in it: the low
    // end only (low-passed), read as a waveform, then into a gain of zero —
    // which adds nothing to what is heard but ties the branch to the output so
    // the browser keeps it running. Built after the main path and on its own
    // try: whatever happens here cannot touch what the listener hears.
    if (ctx && source && analyserRef.current) {
      try {
        // Two low-passes in a row: one alone lets enough of a chord through
        // that its notes beating against each other look like drum hits.
        const low = ctx.createBiquadFilter()
        low.type = 'lowpass'
        low.frequency.value = KICK_CUTOFF_HZ
        const lower = ctx.createBiquadFilter()
        lower.type = 'lowpass'
        lower.frequency.value = KICK_CUTOFF_HZ
        const kick = ctx.createAnalyser()
        // 2048 samples ≈ 45 ms: long enough that a steady bass note measures
        // steady, short enough to land on the beat.
        kick.fftSize = 2048
        const mute = ctx.createGain()
        mute.gain.value = 0
        source.connect(low)
        low.connect(lower)
        lower.connect(kick)
        kick.connect(mute)
        mute.connect(ctx.destination)
        kickRef.current = kick
      } catch { /* no kick signal: the glow still follows the level */ }
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
    // Someone who asked their device for less motion gets a still page: the
    // variables stay at 0 and the stylesheet stops the drifting.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const publish = () => {
      root.style.setProperty('--energy', energyRef.current.toFixed(3))
      root.style.setProperty('--beat', beatRef.current.toFixed(3))
    }
    if (!isPlaying) {
      // Ease the glow back down rather than snapping it off.
      const decay = () => {
        energyRef.current *= 0.85
        beatRef.current *= 0.7
        publish()
        if (energyRef.current > 0.01 || beatRef.current > 0.01) rafRef.current = requestAnimationFrame(decay)
        else { energyRef.current = 0; beatRef.current = 0; publish() }
      }
      rafRef.current = requestAnimationFrame(decay)
      return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
    }
    const analyser = analyserRef.current
    const bins = analyser ? new Uint8Array(analyser.frequencyBinCount) : null
    const kick = kickRef.current
    const kickWave = kick ? new Float32Array(kick.fftSize) : null
    // The low end's running level and its biggest recent jump above it;
    // `primed` skips the first frame.
    let levelAverage = 0
    let recentJump = 0
    let primed = false
    let last = performance.now()
    const tick = (now: number) => {
      const dt = Math.min(64, now - last)
      last = now
      let raw: number
      let hit = 0
      if (analyser && bins) {
        analyser.getByteFrequencyData(bins)
        // Low/mid bins carry the beat; the top of the spectrum is mostly hiss.
        let sum = 0
        const n = Math.min(40, bins.length)
        for (let i = 0; i < n; i++) sum += bins[i]
        raw = Math.min(1, (sum / n / 255) * 1.35)
        if (kick && kickWave) {
          // A drum hit: how loud the low end is over the last few hundredths
          // of a second, against how loud it has been lately. On dance music
          // the kick is the loudest thing down there, so it stands clear of
          // the bass line it lands on; because it is a RATIO it reads the same
          // at any volume, and a held note or a pad (level steady) gives
          // nothing. The hi-hats never reach this branch.
          // (Two earlier tries read the spectrum instead and failed on real
          // conditions: the byte spectrum stops at −30 dB, so a mastered low
          // end reads as "full" all the time; and with only a few bands, two
          // steady notes close together beat against each other and look like
          // hits.)
          kick.getFloatTimeDomainData(kickWave)
          let power = 0
          for (let i = 0; i < kickWave.length; i++) power += kickWave[i] * kickWave[i]
          const level = Math.sqrt(power / kickWave.length)
          if (primed && levelAverage > KICK_SILENCE) {
            // How far above its recent level the low end is, judged against
            // the biggest such jump of the last couple of seconds, so a kick
            // that towers over a sparse mix and one that only just clears a
            // rolling bass line are both read as hits (the second less
            // reliably: about half of them, on a heavily limited test mix).
            // The floor under that yardstick is what keeps a steady note's
            // ripple from counting.
            const over = level / levelAverage - 1
            // Capped: the first note after a silence is a jump of twenty times
            // and would make every kick after it look small for seconds.
            recentJump = Math.max(Math.min(over, KICK_MAX_JUMP), recentJump * Math.pow(0.993, dt / 16))
            const span = Math.max(KICK_MIN_JUMP, recentJump)
            const strength = Math.min(1, Math.max(0, (over - span * 0.3) / (span * 0.6)))
            // Squared: a real hit stays a hit, a half-hearted wobble all but goes.
            hit = strength * strength
          }
          levelAverage += (level - levelAverage) * (1 - Math.pow(0.96, dt / 16))
          primed = true
        }
      } else {
        const p = peaksRef.current
        const audio = audioRef.current
        if (p && p.length > 0) {
          // The element's own clock, not the React state: timeupdate fires
          // four times a second, a frame comes sixty.
          const at = audio && audio.duration > 0 && Number.isFinite(audio.duration)
            ? audio.currentTime / audio.duration
            : progressRef.current
          // Between two bars, not on one: the level glides instead of stepping.
          const x = Math.min(p.length - 1, Math.max(0, at * p.length - 0.5))
          const i = Math.floor(x)
          const next = p[Math.min(p.length - 1, i + 1)]
          raw = ((p[i] + (next - p[i]) * (x - i)) / 100) * 0.9
        } else {
          // No data at all: a slow, gentle breath so the page is never dead.
          raw = 0.35 + 0.15 * Math.sin(now / 900)
        }
      }
      // Frame-rate independent smoothing (~0.25 per 16 ms frame).
      const k = 1 - Math.pow(0.75, dt / 16)
      energyRef.current += (raw - energyRef.current) * k
      // Up at once, down over about a tenth of a second.
      beatRef.current = Math.max(hit, beatRef.current * Math.pow(0.86, dt / 16))
      publish()
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [isPlaying, rootRef, audioRef])

  return { ensureAnalyser }
}

// ── Parallax ────────────────────────────────────────────────────────────────
// Desktop only (a fine pointer): the backdrop follows the mouse by a few
// pixels, and the pointer's place is published on the root as --px / --py
// (−0.5 … 0.5 across the page) so the cover can lean toward it. Phones keep the
// slow drift alone — tilt would need a permission prompt on iOS, which is not
// worth it for a page you open from a text.
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
        const nx = Math.min(0.5, Math.max(-0.5, (e.clientX - r.left) / r.width - 0.5))
        const ny = Math.min(0.5, Math.max(-0.5, (e.clientY - r.top) / r.height - 0.5))
        bg.style.transform = `translate3d(${(nx * -16).toFixed(1)}px, ${(ny * -12).toFixed(1)}px, 0)`
        root.style.setProperty('--px', nx.toFixed(3))
        root.style.setProperty('--py', ny.toFixed(3))
      })
    }
    // The pointer leaving the page lets the cover settle back level.
    const onLeave = () => {
      root.style.setProperty('--px', '0')
      root.style.setProperty('--py', '0')
    }
    root.addEventListener('pointermove', onMove)
    root.addEventListener('pointerleave', onLeave)
    return () => {
      root.removeEventListener('pointermove', onMove)
      root.removeEventListener('pointerleave', onLeave)
      if (frame) cancelAnimationFrame(frame)
    }
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
