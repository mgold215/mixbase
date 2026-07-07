// Free visualizer effect engine — the canvas renderer behind the "Free
// Generator" in Visualizer.tsx.
//
// Design goals (modeled on KREAM-style melodic-house visualizers and the
// standard club-visual toolkit — beat pulses, strobe punches, VHS, glitch,
// film grain, vignette):
//
//  - SEAMLESS LOOPS. Every motion curve is periodic over t ∈ [0, 1): all
//    oscillators run an integer number of cycles per loop (loopSin) and all
//    beat envelopes decay to ~0 by the next beat (beatPulse). Callers must
//    pass t = frame / TOTAL_FRAMES (not TOTAL_FRAMES - 1) so the last frame
//    is one step *before* the wrap — frame 0 is the continuation.
//  - BEAT SYNC. Beat-synced effects lock to a BPM, snapped so a whole number
//    of beats fits the loop exactly (snapBeats) — otherwise the loop pops.
//  - NO DOM AT MODULE SCOPE. Offscreen scratch canvases come from an injected
//    createLayer factory, so the whole engine can be smoke-tested in Node
//    with stub contexts (scripts/effects-test.mjs) — same pattern as the
//    server renderers. domLayerFactory is the browser implementation.
//  - RESOLUTION INDEPENDENT. All offsets/radii are fractions of W/H so the
//    live preview (small canvas) and the recorded render (large canvas)
//    produce the same motion.

export type EffectId =
  | 'kenburns'
  | 'dust'
  | 'pulse'
  | 'strobe'
  | 'liquid'
  | 'orbit'
  | 'vhs'
  | 'glitch'

export type LayerHandle = { canvas: CanvasImageSource; ctx: CanvasRenderingContext2D }
export type LayerFactory = (w: number, h: number) => LayerHandle

export type EffectSetup = {
  W: number
  H: number
  duration: number // seconds per loop
  fps: number
  bpm: number // only read by beat-synced effects
  seed: number // same seed → same motion (preview matches the recording)
  image: CanvasImageSource
  imageWidth: number
  imageHeight: number
  createLayer: LayerFactory
}

// Draws one complete frame (background included) at loop position t ∈ [0, 1).
export type DrawFrame = (ctx: CanvasRenderingContext2D, t: number, frame: number) => void

export type EffectDef = {
  label: string
  description: string
  beatSynced: boolean
  create: (p: EffectSetup) => DrawFrame
}

// Browser LayerFactory. Client-side only — never call during SSR.
export function domLayerFactory(w: number, h: number): LayerHandle {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return { canvas: c, ctx: c.getContext('2d') as CanvasRenderingContext2D }
}

// ── Loop math (exported for unit tests) ─────────────────────────────────────

// Deterministic PRNG so a seed fully determines the motion.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let x = Math.imul(a ^ (a >>> 15), 1 | a)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

// Sine that completes an integer number of cycles per loop → seamless.
export function loopSin(t: number, cycles: number, phase = 0): number {
  return Math.sin(Math.PI * 2 * cycles * t + phase)
}

// Whole beats per loop for a target BPM (≥1). The effective tempo is
// beats / duration × 60 — within a couple BPM of the target, but the loop
// never pops on wrap.
export function snapBeats(duration: number, bpm: number): number {
  return Math.max(1, Math.round((duration * bpm) / 60))
}

// Percussive envelope: 1 at each beat start, exponential decay to ~0 before
// the next beat. Seamless because `beats` is a whole number per loop.
export function beatPulse(t: number, beats: number, sharpness = 6): number {
  const bt = (((t * beats) % 1) + 1) % 1
  return Math.exp(-sharpness * bt)
}

// Cover-fit dimensions (image scaled so it fully covers the canvas).
export function coverDims(imgW: number, imgH: number, W: number, H: number) {
  const imgAspect = imgW / imgH
  return imgAspect > W / H
    ? { drawW: H * imgAspect, drawH: H }
    : { drawW: W, drawH: W / imgAspect }
}

// ── Internal draw helpers ───────────────────────────────────────────────────

function drawCover(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  imgW: number,
  imgH: number,
  W: number,
  H: number,
  scale: number,
  panX = 0,
  panY = 0,
  rot = 0,
  alpha = 1,
  comp: GlobalCompositeOperation = 'source-over',
) {
  const { drawW, drawH } = coverDims(imgW, imgH, W, H)
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.globalCompositeOperation = comp
  ctx.translate(W / 2 + panX, H / 2 + panY)
  if (rot) ctx.rotate(rot)
  ctx.scale(scale, scale)
  ctx.drawImage(image, -drawW / 2, -drawH / 2, drawW, drawH)
  ctx.restore()
}

function fillBg(ctx: CanvasRenderingContext2D, W: number, H: number) {
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, W, H)
}

const GRAIN_SIZE = 256

// Static gray-noise tile; drawn with 'overlay' at a random offset each frame
// for animated film grain. Randomness per frame is intentional — grain that
// doesn't repeat with the loop reads as texture, not a stutter.
function makeGrainLayer(createLayer: LayerFactory, rng: () => number): LayerHandle {
  const layer = createLayer(GRAIN_SIZE, GRAIN_SIZE)
  const id = layer.ctx.createImageData(GRAIN_SIZE, GRAIN_SIZE)
  for (let i = 0; i < id.data.length; i += 4) {
    const v = 90 + Math.floor(rng() * 76)
    id.data[i] = v
    id.data[i + 1] = v
    id.data[i + 2] = v
    id.data[i + 3] = 255
  }
  layer.ctx.putImageData(id, 0, 0)
  return layer
}

function drawGrain(ctx: CanvasRenderingContext2D, grain: LayerHandle, W: number, H: number, alpha: number) {
  const ox = Math.floor(Math.random() * GRAIN_SIZE)
  const oy = Math.floor(Math.random() * GRAIN_SIZE)
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.globalCompositeOperation = 'overlay'
  for (let x = -ox; x < W; x += GRAIN_SIZE) {
    for (let y = -oy; y < H; y += GRAIN_SIZE) {
      ctx.drawImage(grain.canvas, x, y)
    }
  }
  ctx.restore()
}

type VignetteCache = { g?: CanvasGradient }

function drawVignette(ctx: CanvasRenderingContext2D, W: number, H: number, strength: number, cache: VignetteCache) {
  if (!cache.g) {
    const r = Math.hypot(W, H) / 2
    const g = ctx.createRadialGradient(W / 2, H / 2, r * 0.45, W / 2, H / 2, r)
    g.addColorStop(0, 'rgba(0,0,0,0)')
    g.addColorStop(1, `rgba(0,0,0,${strength})`)
    cache.g = g
  }
  ctx.save()
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  ctx.fillStyle = cache.g
  ctx.fillRect(0, 0, W, H)
  ctx.restore()
}

// Color-tinted copy of the artwork (capped size) for RGB-split / chroma-fringe
// passes — drawn offset with 'screen' so only the fringe reads.
function makeTintLayer(
  createLayer: LayerFactory,
  image: CanvasImageSource,
  imgW: number,
  imgH: number,
  color: string,
) {
  const cap = 1024
  const s = Math.min(1, cap / Math.max(imgW, imgH))
  const w = Math.max(1, Math.round(imgW * s))
  const h = Math.max(1, Math.round(imgH * s))
  const layer = createLayer(w, h)
  layer.ctx.drawImage(image, 0, 0, w, h)
  layer.ctx.globalCompositeOperation = 'multiply'
  layer.ctx.fillStyle = color
  layer.ctx.fillRect(0, 0, w, h)
  layer.ctx.globalCompositeOperation = 'source-over'
  return { layer, w, h }
}

// ── Effects ─────────────────────────────────────────────────────────────────

const kenburns: EffectDef = {
  label: 'Cinematic Drift',
  description: 'Slow weightless zoom & pan',
  beatSynced: false,
  create(p) {
    const rng = mulberry32(p.seed)
    const phase = rng() * Math.PI * 2
    const grain = makeGrainLayer(p.createLayer, rng)
    const vig: VignetteCache = {}
    return (ctx, t) => {
      fillBg(ctx, p.W, p.H)
      const scale = 1.1 + 0.045 * loopSin(t, 1, phase)
      const panX = 0.028 * p.W * loopSin(t, 1, phase + 1.7)
      const panY = 0.02 * p.H * loopSin(t, 1, phase + 3.9)
      drawCover(ctx, p.image, p.imageWidth, p.imageHeight, p.W, p.H, scale, panX, panY)
      drawVignette(ctx, p.W, p.H, 0.42, vig)
      drawGrain(ctx, grain, p.W, p.H, 0.07)
    }
  },
}

const dust: EffectDef = {
  label: 'Dust & Glow',
  description: 'Floating particles, warm light',
  beatSynced: false,
  create(p) {
    const rng = mulberry32(p.seed)
    const phase = rng() * Math.PI * 2
    const grain = makeGrainLayer(p.createLayer, rng)
    const vig: VignetteCache = {}
    const minDim = Math.min(p.W, p.H)
    // Particles drift on closed elliptical paths (integer cycles) so they end
    // exactly where they started — no wrap pop, just endless float.
    const particles = Array.from({ length: 42 }, () => ({
      x0: rng(),
      y0: rng(),
      r: (0.0025 + rng() * 0.006) * minDim,
      ax: (0.015 + rng() * 0.035) * p.W,
      ay: (0.02 + rng() * 0.05) * p.H,
      cx: 1 + Math.floor(rng() * 2),
      cy: 1 + Math.floor(rng() * 2),
      p1: rng() * Math.PI * 2,
      p2: rng() * Math.PI * 2,
      tw: 1 + Math.floor(rng() * 3),
      p3: rng() * Math.PI * 2,
      a: 0.12 + rng() * 0.35,
    }))
    return (ctx, t) => {
      fillBg(ctx, p.W, p.H)
      const scale = 1.09 + 0.05 * loopSin(t, 1, phase)
      const panY = 0.015 * p.H * loopSin(t, 1, phase + 2.4)
      drawCover(ctx, p.image, p.imageWidth, p.imageHeight, p.W, p.H, scale, 0, panY)
      // Warm light leak orbiting slowly off-center
      const lx = p.W * (0.5 + 0.55 * loopSin(t, 1, phase + 0.6))
      const ly = p.H * (0.25 + 0.3 * loopSin(t, 1, phase + 2.7))
      const lr = Math.max(p.W, p.H) * 0.85
      const g = ctx.createRadialGradient(lx, ly, 0, lx, ly, lr)
      g.addColorStop(0, 'rgba(255,178,92,0.32)')
      g.addColorStop(1, 'rgba(255,178,92,0)')
      ctx.save()
      ctx.globalCompositeOperation = 'screen'
      ctx.globalAlpha = 0.55 + 0.35 * loopSin(t, 1, phase + 4.5)
      ctx.fillStyle = g
      ctx.fillRect(0, 0, p.W, p.H)
      ctx.restore()
      // Bokeh dust
      ctx.save()
      ctx.globalCompositeOperation = 'screen'
      ctx.fillStyle = 'rgb(255,236,205)'
      for (const pt of particles) {
        const x = pt.x0 * p.W + pt.ax * loopSin(t, pt.cx, pt.p1)
        const y = pt.y0 * p.H + pt.ay * loopSin(t, pt.cy, pt.p2)
        const a = pt.a * (0.55 + 0.45 * loopSin(t, pt.tw, pt.p3))
        ctx.globalAlpha = a * 0.3
        ctx.beginPath()
        ctx.arc(x, y, pt.r * 3, 0, Math.PI * 2)
        ctx.fill()
        ctx.globalAlpha = a
        ctx.beginPath()
        ctx.arc(x, y, pt.r, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.restore()
      drawVignette(ctx, p.W, p.H, 0.55, vig)
      drawGrain(ctx, grain, p.W, p.H, 0.06)
    }
  },
}

const pulse: EffectDef = {
  label: 'Deep Pulse',
  description: 'Breathes on the beat',
  beatSynced: true,
  create(p) {
    const rng = mulberry32(p.seed)
    const grain = makeGrainLayer(p.createLayer, rng)
    const vig: VignetteCache = {}
    const beats = snapBeats(p.duration, p.bpm)
    return (ctx, t) => {
      fillBg(ctx, p.W, p.H)
      const kick = beatPulse(t, beats, 6)
      const scale = 1.07 + 0.05 * kick
      drawCover(ctx, p.image, p.imageWidth, p.imageHeight, p.W, p.H, scale)
      // Bloom: an enlarged screen-composited copy that flares on the kick
      drawCover(ctx, p.image, p.imageWidth, p.imageHeight, p.W, p.H, scale * 1.05, 0, 0, 0, 0.22 * kick, 'screen')
      // Sink slightly darker between beats so the kick reads as light
      ctx.save()
      ctx.globalAlpha = 0.1 * (1 - kick)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, p.W, p.H)
      ctx.restore()
      drawVignette(ctx, p.W, p.H, 0.45, vig)
      drawGrain(ctx, grain, p.W, p.H, 0.05)
    }
  },
}

const strobe: EffectDef = {
  label: 'Club Strobe',
  description: 'Beat punch, downbeat flash',
  beatSynced: true,
  create(p) {
    const rng = mulberry32(p.seed)
    const phase = rng() * Math.PI * 2
    const grain = makeGrainLayer(p.createLayer, rng)
    const vig: VignetteCache = {}
    const beats = snapBeats(p.duration, p.bpm)
    const bars = Math.max(1, Math.round(beats / 4))
    const red = makeTintLayer(p.createLayer, p.image, p.imageWidth, p.imageHeight, '#ff0040')
    const cyan = makeTintLayer(p.createLayer, p.image, p.imageWidth, p.imageHeight, '#00e0ff')
    return (ctx, t) => {
      fillBg(ctx, p.W, p.H)
      const kick = beatPulse(t, beats, 7)
      // Sharp decay so the flash is a strobe hit (~150ms), not a slow fade
      const flash = beatPulse(t, bars, 14)
      const rot = 0.015 * loopSin(t, 1, phase)
      const scale = 1.09 + 0.06 * kick
      drawCover(ctx, p.image, p.imageWidth, p.imageHeight, p.W, p.H, scale, 0, 0, rot)
      // RGB split flares with the bar flash, ticks with each kick
      const d = p.W * (0.014 * flash + 0.004 * kick)
      if (d > 0.3) {
        const a = Math.min(1, flash + kick * 0.4) * 0.5
        drawCover(ctx, red.layer.canvas, red.w, red.h, p.W, p.H, scale, -d, 0, rot, a, 'screen')
        drawCover(ctx, cyan.layer.canvas, cyan.w, cyan.h, p.W, p.H, scale, d, 0, rot, a, 'screen')
      }
      if (flash > 0.02) {
        ctx.save()
        ctx.globalAlpha = 0.45 * flash
        ctx.fillStyle = '#fff'
        ctx.fillRect(0, 0, p.W, p.H)
        ctx.restore()
      }
      drawVignette(ctx, p.W, p.H, 0.35, vig)
      drawGrain(ctx, grain, p.W, p.H, 0.06)
    }
  },
}

const liquid: EffectDef = {
  label: 'Liquid',
  description: 'Slow underwater ripple',
  beatSynced: false,
  create(p) {
    const rng = mulberry32(p.seed)
    const phase = rng() * Math.PI * 2
    const grain = makeGrainLayer(p.createLayer, rng)
    const vig: VignetteCache = {}
    const src = p.createLayer(p.W, p.H)
    const bandH = Math.max(2, Math.round(p.H / 140))
    const k = (Math.PI * 2 * 3.5) / p.H // spatial wave frequency
    return (ctx, t) => {
      // Render the (slightly overscanned) artwork once, then re-draw it in
      // horizontal bands offset by a travelling sine — the classic cheap
      // "liquid" displacement.
      fillBg(src.ctx, p.W, p.H)
      drawCover(src.ctx, p.image, p.imageWidth, p.imageHeight, p.W, p.H, 1.1 + 0.02 * loopSin(t, 1, phase))
      fillBg(ctx, p.W, p.H)
      const amp = p.W * 0.02 * (0.75 + 0.25 * loopSin(t, 2, phase + 1.3))
      const travel = Math.PI * 2 * t // one full wave cycle per loop
      for (let y = 0; y < p.H; y += bandH) {
        const dx = amp * Math.sin(y * k + travel * 3 + phase)
        ctx.drawImage(src.canvas, 0, y, p.W, bandH, dx, y, p.W, bandH)
      }
      drawVignette(ctx, p.W, p.H, 0.38, vig)
      drawGrain(ctx, grain, p.W, p.H, 0.05)
    }
  },
}

const orbit: EffectDef = {
  label: 'Orbit',
  description: 'Weightless sway & rotation',
  beatSynced: false,
  create(p) {
    const rng = mulberry32(p.seed)
    const phase = rng() * Math.PI * 2
    const grain = makeGrainLayer(p.createLayer, rng)
    const vig: VignetteCache = {}
    const rotMax = 0.05 // ~2.9°
    // Extra zoom needed so the rotated cover never shows a corner
    const ratio = Math.max(p.W / p.H, p.H / p.W)
    const bleed = Math.cos(rotMax) + ratio * Math.sin(rotMax)
    return (ctx, t) => {
      fillBg(ctx, p.W, p.H)
      const rot = rotMax * loopSin(t, 1, phase)
      const scale = bleed * (1.035 + 0.025 * loopSin(t, 2, phase + 2.2))
      const panX = 0.012 * p.W * loopSin(t, 1, phase + 4.1)
      drawCover(ctx, p.image, p.imageWidth, p.imageHeight, p.W, p.H, scale, panX, 0, rot)
      drawVignette(ctx, p.W, p.H, 0.48, vig)
      drawGrain(ctx, grain, p.W, p.H, 0.06)
    }
  },
}

const vhs: EffectDef = {
  label: 'VHS',
  description: 'Tape fuzz, tracking roll',
  beatSynced: false,
  create(p) {
    const rng = mulberry32(p.seed)
    const phase = rng() * Math.PI * 2
    const grain = makeGrainLayer(p.createLayer, rng)
    const vig: VignetteCache = {}
    const src = p.createLayer(p.W, p.H)
    const red = makeTintLayer(p.createLayer, p.image, p.imageWidth, p.imageHeight, '#ff0040')
    const cyan = makeTintLayer(p.createLayer, p.image, p.imageWidth, p.imageHeight, '#00e0ff')
    // Pre-rendered scanline overlay: 1px dark row every 3px
    const scan = p.createLayer(p.W, p.H)
    scan.ctx.fillStyle = 'rgba(0,0,0,0.16)'
    for (let y = 0; y < p.H; y += 3) scan.ctx.fillRect(0, y, p.W, 1)
    return (ctx, t) => {
      const scale = 1.07 + 0.01 * loopSin(t, 1, phase)
      const jitterY = (Math.random() - 0.5) * p.H * 0.003
      const fringe = p.W * 0.0045
      fillBg(src.ctx, p.W, p.H)
      drawCover(src.ctx, p.image, p.imageWidth, p.imageHeight, p.W, p.H, scale, 0, jitterY)
      drawCover(src.ctx, red.layer.canvas, red.w, red.h, p.W, p.H, scale, -fringe, jitterY, 0, 0.35, 'screen')
      drawCover(src.ctx, cyan.layer.canvas, cyan.w, cyan.h, p.W, p.H, scale, fringe, jitterY, 0, 0.35, 'screen')
      fillBg(ctx, p.W, p.H)
      ctx.drawImage(src.canvas, 0, 0)
      // Tracking band rolling bottom→top once per loop: displaced slice + noise
      const bandH = Math.max(3, Math.round(p.H * 0.045))
      const bandY = Math.round((1 - t) * p.H) - bandH / 2
      const shift = p.W * (0.01 + 0.015 * Math.random())
      ctx.drawImage(src.canvas, 0, Math.max(0, bandY), p.W, bandH, shift, Math.max(0, bandY), p.W, bandH)
      ctx.save()
      ctx.beginPath()
      ctx.rect(0, bandY, p.W, bandH)
      ctx.clip()
      ctx.globalAlpha = 0.1
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, bandY, p.W, bandH)
      drawGrain(ctx, grain, p.W, p.H, 0.5)
      ctx.restore()
      ctx.save()
      ctx.globalAlpha = 1
      ctx.drawImage(scan.canvas, 0, 0)
      // Faint warm magenta cast, very VHS
      ctx.globalAlpha = 0.04
      ctx.fillStyle = '#ff0060'
      ctx.fillRect(0, 0, p.W, p.H)
      ctx.restore()
      drawVignette(ctx, p.W, p.H, 0.42, vig)
      drawGrain(ctx, grain, p.W, p.H, 0.1)
    }
  },
}

const glitch: EffectDef = {
  label: 'Glitch',
  description: 'RGB-split digital bursts',
  beatSynced: true,
  create(p) {
    const rng = mulberry32(p.seed)
    const phase = rng() * Math.PI * 2
    const grain = makeGrainLayer(p.createLayer, rng)
    const vig: VignetteCache = {}
    const src = p.createLayer(p.W, p.H)
    const red = makeTintLayer(p.createLayer, p.image, p.imageWidth, p.imageHeight, '#ff0040')
    const cyan = makeTintLayer(p.createLayer, p.image, p.imageWidth, p.imageHeight, '#00e0ff')
    const beats = snapBeats(p.duration, p.bpm)
    // Bursts land on a random subset of beats so the glitches feel musical.
    const bursts: { start: number; dur: number }[] = []
    for (let b = 0; b < beats; b++) {
      if (rng() < 0.4) bursts.push({ start: b / beats, dur: (0.1 + rng() * 0.18) / p.duration })
    }
    if (bursts.length < 2) {
      bursts.push({ start: 0.12, dur: 0.15 / p.duration }, { start: 0.58, dur: 0.18 / p.duration })
    }
    const env = (t: number) => {
      let e = 0
      for (const b of bursts) {
        const dt = t - b.start
        if (dt >= 0 && dt < b.dur) e = Math.max(e, 1 - dt / b.dur)
      }
      return e
    }
    return (ctx, t) => {
      const e = env(t)
      const scale = 1.09 + 0.03 * loopSin(t, 1, phase)
      const panX = 0.015 * p.W * loopSin(t, 1, phase + 1.2)
      fillBg(src.ctx, p.W, p.H)
      drawCover(src.ctx, p.image, p.imageWidth, p.imageHeight, p.W, p.H, scale, panX, 0)
      // Constant hairline fringe; blown out during bursts
      const d = p.W * (0.002 + 0.02 * e)
      const fa = 0.25 + 0.45 * e
      drawCover(src.ctx, red.layer.canvas, red.w, red.h, p.W, p.H, scale, panX - d, 0, 0, fa, 'screen')
      drawCover(src.ctx, cyan.layer.canvas, cyan.w, cyan.h, p.W, p.H, scale, panX + d, 0, 0, fa, 'screen')
      fillBg(ctx, p.W, p.H)
      ctx.drawImage(src.canvas, 0, 0)
      if (e > 0.03) {
        // Horizontal slice displacement
        const slices = 3 + Math.floor(Math.random() * 4)
        for (let s = 0; s < slices; s++) {
          const sy = Math.floor(Math.random() * p.H)
          const sh = Math.max(2, Math.floor((0.006 + Math.random() * 0.03) * p.H))
          const dx = (Math.random() < 0.5 ? -1 : 1) * (0.03 + Math.random() * 0.09) * p.W * e
          ctx.drawImage(src.canvas, 0, sy, p.W, sh, dx, sy, p.W, sh)
        }
        // Block echo: a displaced rectangular chunk
        if (Math.random() < 0.7) {
          const bw = Math.floor((0.15 + Math.random() * 0.3) * p.W)
          const bh = Math.floor((0.05 + Math.random() * 0.15) * p.H)
          const bx = Math.floor(Math.random() * (p.W - bw))
          const by = Math.floor(Math.random() * (p.H - bh))
          const dx = (Math.random() < 0.5 ? -1 : 1) * (0.02 + Math.random() * 0.05) * p.W
          ctx.drawImage(src.canvas, bx, by, bw, bh, bx + dx, by, bw, bh)
        }
        drawGrain(ctx, grain, p.W, p.H, 0.25 * e)
        // Rare full-frame invert pop at burst peaks
        if (e > 0.85 && Math.random() < 0.25) {
          ctx.save()
          ctx.globalCompositeOperation = 'difference'
          ctx.globalAlpha = 0.9
          ctx.fillStyle = '#fff'
          ctx.fillRect(0, 0, p.W, p.H)
          ctx.restore()
        }
      }
      drawVignette(ctx, p.W, p.H, 0.32, vig)
      drawGrain(ctx, grain, p.W, p.H, 0.05)
    }
  },
}

// Registry — insertion order is the UI display order.
export const EFFECTS: Record<EffectId, EffectDef> = {
  kenburns,
  dust,
  pulse,
  strobe,
  liquid,
  orbit,
  vhs,
  glitch,
}

export const EFFECT_IDS = Object.keys(EFFECTS) as EffectId[]
