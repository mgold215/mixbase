// Free visualizer effect engine — the canvas renderer behind the "Free
// Generator" in Visualizer.tsx.
//
// Design goals (modeled on KREAM-style melodic-house visualizers and the
// standard club-visual toolkit — beat pulses, strobe punches, VHS, glitch,
// drone flyovers, 2.5-D parallax, kaleidoscope mirrors, warp-zoom bursts,
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
//  - DETERMINISTIC PER FRAME. Any per-frame randomness (grain drift, VHS
//    tracking jitter, glitch geometry) is drawn from frameRng(seed, frame),
//    NOT the ambient Math.random() nor a single shared per-effect stream. The
//    preview is a free-running rAF loop while the recording is a strict
//    0…N-1 sweep, so frame K must render identically regardless of how many
//    frames ran before it — that is the only way "the preview is exactly the
//    motion you get in the video" (see EffectSetup.seed / Visualizer.tsx).

export type EffectId =
  | 'kenburns'
  | 'drone'
  | 'parallax'
  | 'dust'
  | 'pulse'
  | 'strobe'
  | 'zoomblur'
  | 'liquid'
  | 'orbit'
  | 'kaleido'
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

// Per-frame PRNG: the returned stream is fully determined by (seed, frame), so
// a given frame index renders identically no matter what was drawn before it.
// This is what keeps the free-running preview loop and the sequential recording
// pass in lock-step. A single shared per-effect stream would NOT: its state at
// frame K depends on how many frames ran first, which differs between the two
// passes (preview repeats/skips frames; recording sweeps 0…N-1 once).
export function frameRng(seed: number, frame: number): () => number {
  return mulberry32((seed ^ Math.imul(frame + 1, 0x9e3779b1)) >>> 0)
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

// Static gray-noise tile; drawn with 'overlay' at a per-frame offset for
// animated film grain. The offset comes from the per-frame seeded stream
// (frameRng) passed in by the caller, so the grain still drifts frame-to-frame
// — reading as texture, not a stutter — while rendering identically in the
// preview and the recording (an ambient Math.random() offset would not).
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

function drawGrain(
  ctx: CanvasRenderingContext2D,
  grain: LayerHandle,
  W: number,
  H: number,
  alpha: number,
  rng: () => number,
) {
  const ox = Math.floor(rng() * GRAIN_SIZE)
  const oy = Math.floor(rng() * GRAIN_SIZE)
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

// Hand-rolled rounded-rect path — ctx.roundRect is too new to rely on in every
// recording browser, and the Node test stubs only see generic method calls.
function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
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
    return (ctx, t, frame) => {
      const fr = frameRng(p.seed, frame)
      fillBg(ctx, p.W, p.H)
      const scale = 1.1 + 0.045 * loopSin(t, 1, phase)
      const panX = 0.028 * p.W * loopSin(t, 1, phase + 1.7)
      const panY = 0.02 * p.H * loopSin(t, 1, phase + 3.9)
      drawCover(ctx, p.image, p.imageWidth, p.imageHeight, p.W, p.H, scale, panX, panY)
      drawVignette(ctx, p.W, p.H, 0.42, vig)
      drawGrain(ctx, grain, p.W, p.H, 0.07, fr)
    }
  },
}

const drone: EffectDef = {
  label: 'Drone Shot',
  description: 'Aerial dive & climb, banked turns',
  beatSynced: false,
  create(p) {
    const rng = mulberry32(p.seed)
    const phase = rng() * Math.PI * 2
    const grain = makeGrainLayer(p.createLayer, rng)
    const vig: VignetteCache = {}
    const rotMax = 0.045 // banking ~2.6°
    // Extra zoom so the banked (rotated) cover never shows a corner
    const ratio = Math.max(p.W / p.H, p.H / p.W)
    const bleed = Math.cos(rotMax) + ratio * Math.sin(rotMax)
    return (ctx, t, frame) => {
      const fr = frameRng(p.seed, frame)
      fillBg(ctx, p.W, p.H)
      // Altitude: smoothstepped sine — the dive accelerates in, eases out.
      // alt 0 = high & wide, alt 1 = low flyover (pushed in).
      const u = 0.5 + 0.5 * loopSin(t, 1, phase)
      const alt = u * u * (3 - 2 * u)
      const scale = bleed * (1.04 + 0.42 * alt)
      // Sweep across the artwork — amplitude grows with the zoom margin, so
      // the low pass glides far while the high shot barely drifts. Banking
      // follows the sweep's velocity (its cosine), like a drone leaning into
      // the turn.
      const zoomExtra = scale - bleed
      const panX = 0.25 * zoomExtra * p.W * loopSin(t, 2, phase + 0.9)
      const panY = 0.15 * zoomExtra * p.H * loopSin(t, 1, phase + 2.6)
      const rot = rotMax * loopSin(t, 2, phase + 0.9 + Math.PI / 2)
      // Micro-vibration — the handheld/props shimmer that sells "drone"
      const jx = (fr() - 0.5) * 0.0015 * p.W
      const jy = (fr() - 0.5) * 0.0015 * p.H
      drawCover(ctx, p.image, p.imageWidth, p.imageHeight, p.W, p.H, scale, panX + jx, panY + jy, rot)
      // Zoom smear while the dive is moving fast (|d alt/dt| peaks mid-sine)
      const speed = Math.abs(loopSin(t, 1, phase + Math.PI / 2))
      const echoA = 0.16 * speed
      if (echoA > 0.02) {
        drawCover(ctx, p.image, p.imageWidth, p.imageHeight, p.W, p.H, scale * 1.02, panX + jx, panY + jy, rot, echoA)
        drawCover(ctx, p.image, p.imageWidth, p.imageHeight, p.W, p.H, scale * 1.04, panX + jx, panY + jy, rot, echoA * 0.5)
      }
      // Cool atmospheric haze at altitude, burning off as the drone dives
      const haze = 0.07 * (1 - alt)
      if (haze > 0.005) {
        ctx.save()
        ctx.globalCompositeOperation = 'screen'
        ctx.globalAlpha = haze
        ctx.fillStyle = 'rgb(180,200,255)'
        ctx.fillRect(0, 0, p.W, p.H)
        ctx.restore()
      }
      drawVignette(ctx, p.W, p.H, 0.45, vig)
      drawGrain(ctx, grain, p.W, p.H, 0.06, fr)
    }
  },
}

const parallax: EffectDef = {
  label: 'Depth Float',
  description: 'Art floats over blurred depth',
  beatSynced: false,
  create(p) {
    const rng = mulberry32(p.seed)
    const phase = rng() * Math.PI * 2
    const grain = makeGrainLayer(p.createLayer, rng)
    const vig: VignetteCache = {}
    // Backdrop blur: two bilinear downscale passes ≈ cheap gaussian; the
    // upscale at draw time keeps it soft. Pre-rendered once — only the pan
    // animates, so no per-frame cost.
    const aW = Math.max(8, Math.round(p.W / 4))
    const aH = Math.max(8, Math.round(p.H / 4))
    const a = p.createLayer(aW, aH)
    drawCover(a.ctx, p.image, p.imageWidth, p.imageHeight, aW, aH, 1)
    const bW = Math.max(4, Math.round(aW / 3))
    const bH = Math.max(4, Math.round(aH / 3))
    const b = p.createLayer(bW, bH)
    b.ctx.drawImage(a.canvas, 0, 0, aW, aH, 0, 0, bW, bH)
    // Foreground card: the artwork contain-fit, floating over its own blur
    const imgAspect = p.imageWidth / p.imageHeight
    let cardW = p.W * 0.52
    let cardH = cardW / imgAspect
    const maxH = p.H * 0.6
    if (cardH > maxH) {
      cardH = maxH
      cardW = cardH * imgAspect
    }
    const corner = Math.min(cardW, cardH) * 0.045
    return (ctx, t, frame) => {
      const fr = frameRng(p.seed, frame)
      fillBg(ctx, p.W, p.H)
      const bgPanX = 0.035 * p.W * loopSin(t, 1, phase + 1.1)
      const bgPanY = 0.02 * p.H * loopSin(t, 1, phase + 3.3)
      drawCover(ctx, b.canvas, bW, bH, p.W, p.H, 1.16 + 0.04 * loopSin(t, 1, phase), bgPanX, bgPanY)
      ctx.save()
      ctx.globalAlpha = 0.34
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, p.W, p.H)
      ctx.restore()
      // Card drifts counter to the backdrop — that opposition is the parallax
      const px = -0.55 * bgPanX
      const py = 0.02 * p.H * loopSin(t, 2, phase + 4.2)
      const tilt = 0.035 * loopSin(t, 1, phase + 5.1)
      const cs = 1 + 0.022 * loopSin(t, 1, phase + 2.4)
      // Soft ground shadow under the card
      ctx.save()
      ctx.globalCompositeOperation = 'source-over'
      ctx.translate(p.W / 2 + px * 1.15, p.H / 2 + py + cardH * 0.62 * cs)
      ctx.scale(1, 0.22)
      const sg = ctx.createRadialGradient(0, 0, 0, 0, 0, cardW * 0.75)
      sg.addColorStop(0, 'rgba(0,0,0,0.55)')
      sg.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = sg
      ctx.fillRect(-cardW, -cardW, cardW * 2, cardW * 2)
      ctx.restore()
      // The card itself: rounded clip, artwork, sheen sweep, hairline edge
      ctx.save()
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
      ctx.translate(p.W / 2 + px, p.H / 2 + py)
      ctx.rotate(tilt)
      ctx.scale(cs, cs)
      roundRectPath(ctx, -cardW / 2, -cardH / 2, cardW, cardH, corner)
      ctx.clip()
      ctx.drawImage(p.image, -cardW / 2, -cardH / 2, cardW, cardH)
      // Diagonal light sheen crossing the card once per loop (enters and
      // exits fully off-card, so the wrap jump is invisible)
      const sheenX = (-1.5 + 3 * t) * cardW
      const g = ctx.createLinearGradient(sheenX - cardW * 0.35, -cardH / 2, sheenX + cardW * 0.35, cardH / 2)
      g.addColorStop(0, 'rgba(255,255,255,0)')
      g.addColorStop(0.5, 'rgba(255,255,255,0.14)')
      g.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.globalCompositeOperation = 'screen'
      ctx.fillStyle = g
      ctx.fillRect(-cardW / 2, -cardH / 2, cardW, cardH)
      ctx.globalCompositeOperation = 'source-over'
      ctx.strokeStyle = 'rgba(255,255,255,0.10)'
      ctx.lineWidth = Math.max(1, 0.004 * Math.min(cardW, cardH))
      roundRectPath(ctx, -cardW / 2, -cardH / 2, cardW, cardH, corner)
      ctx.stroke()
      ctx.restore()
      drawVignette(ctx, p.W, p.H, 0.5, vig)
      drawGrain(ctx, grain, p.W, p.H, 0.06, fr)
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
    return (ctx, t, frame) => {
      const fr = frameRng(p.seed, frame)
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
      drawGrain(ctx, grain, p.W, p.H, 0.06, fr)
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
    return (ctx, t, frame) => {
      const fr = frameRng(p.seed, frame)
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
      drawGrain(ctx, grain, p.W, p.H, 0.05, fr)
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
    return (ctx, t, frame) => {
      const fr = frameRng(p.seed, frame)
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
      drawGrain(ctx, grain, p.W, p.H, 0.06, fr)
    }
  },
}

const zoomblur: EffectDef = {
  label: 'Warp Zoom',
  description: 'Radial warp bursts on the beat',
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
    return (ctx, t, frame) => {
      const fr = frameRng(p.seed, frame)
      fillBg(ctx, p.W, p.H)
      const kick = beatPulse(t, beats, 5)
      // Longer bar-level swell so downbeats detonate harder than every kick.
      // Gentler decay than the default — dies to ~0.01 before the wrap, which
      // is invisible at these alpha levels but keeps the tail long and warpy.
      const surge = beatPulse(t, bars, 4.5)
      const e = Math.min(1, 0.3 * kick + 0.8 * surge)
      const scale = 1.1 + 0.05 * kick + 0.02 * loopSin(t, 1, phase)
      drawCover(ctx, p.image, p.imageWidth, p.imageHeight, p.W, p.H, scale)
      if (e > 0.02) {
        // Radial smear: stacked enlarged ghosts with a slight vortex twist
        const steps = 5
        for (let i = 1; i <= steps; i++) {
          const k = i / steps
          const ga = 0.22 * e * (1 - k * 0.55)
          drawCover(
            ctx, p.image, p.imageWidth, p.imageHeight, p.W, p.H,
            scale * (1 + 0.14 * e * k), 0, 0, 0.02 * e * k, ga,
          )
        }
        // Spectral fringe: red pulled outward, cyan pushed inward
        const d = 1 + 0.05 * e
        drawCover(ctx, red.layer.canvas, red.w, red.h, p.W, p.H, scale * d, 0, 0, 0, 0.3 * e, 'screen')
        drawCover(ctx, cyan.layer.canvas, cyan.w, cyan.h, p.W, p.H, scale / d, 0, 0, 0, 0.3 * e, 'screen')
      }
      drawVignette(ctx, p.W, p.H, 0.4, vig)
      drawGrain(ctx, grain, p.W, p.H, 0.06, fr)
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
    return (ctx, t, frame) => {
      const fr = frameRng(p.seed, frame)
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
      drawGrain(ctx, grain, p.W, p.H, 0.05, fr)
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
    return (ctx, t, frame) => {
      const fr = frameRng(p.seed, frame)
      fillBg(ctx, p.W, p.H)
      const rot = rotMax * loopSin(t, 1, phase)
      const scale = bleed * (1.035 + 0.025 * loopSin(t, 2, phase + 2.2))
      const panX = 0.012 * p.W * loopSin(t, 1, phase + 4.1)
      drawCover(ctx, p.image, p.imageWidth, p.imageHeight, p.W, p.H, scale, panX, 0, rot)
      drawVignette(ctx, p.W, p.H, 0.48, vig)
      drawGrain(ctx, grain, p.W, p.H, 0.06, fr)
    }
  },
}

const kaleido: EffectDef = {
  label: 'Kaleidoscope',
  description: 'Mirrored prism, slow spin',
  beatSynced: false,
  create(p) {
    const rng = mulberry32(p.seed)
    const phase = rng() * Math.PI * 2
    const grain = makeGrainLayer(p.createLayer, rng)
    const vig: VignetteCache = {}
    const src = p.createLayer(p.W, p.H)
    // Only the CENTER half-size region of the rotating source is sampled, so
    // the zoom just has to keep the inscribed circle of the rotated cover
    // over that region (plus pan): scale ≥ 2·(quarter-diagonal + pan) / minDim.
    const minDim = Math.min(p.W, p.H)
    const panAmp = 0.045 * minDim
    const s0 = (2 * (Math.hypot(p.W, p.H) / 4 + panAmp)) / minDim
    return (ctx, t, frame) => {
      const fr = frameRng(p.seed, frame)
      // One full revolution per loop — inherently seamless
      const rot = Math.PI * 2 * t
      const scale = s0 * (1.06 + 0.05 * loopSin(t, 2, phase))
      const panX = panAmp * loopSin(t, 1, phase + 1.8)
      const panY = panAmp * 0.7 * loopSin(t, 2, phase + 3.7)
      fillBg(src.ctx, p.W, p.H)
      drawCover(src.ctx, p.image, p.imageWidth, p.imageHeight, p.W, p.H, scale, panX, panY, rot)
      // Four-way mirror of the source's center region
      fillBg(ctx, p.W, p.H)
      const hw = p.W / 2
      const hh = p.H / 2
      const sx = p.W / 4
      const sy = p.H / 4
      ctx.drawImage(src.canvas, sx, sy, hw, hh, 0, 0, hw, hh)
      ctx.save()
      ctx.translate(p.W, 0)
      ctx.scale(-1, 1)
      ctx.drawImage(src.canvas, sx, sy, hw, hh, 0, 0, hw, hh)
      ctx.restore()
      ctx.save()
      ctx.translate(0, p.H)
      ctx.scale(1, -1)
      ctx.drawImage(src.canvas, sx, sy, hw, hh, 0, 0, hw, hh)
      ctx.restore()
      ctx.save()
      ctx.translate(p.W, p.H)
      ctx.scale(-1, -1)
      ctx.drawImage(src.canvas, sx, sy, hw, hh, 0, 0, hw, hh)
      ctx.restore()
      // Soft bloom at the mirror seam's center where all four folds meet
      const g = ctx.createRadialGradient(hw, hh, 0, hw, hh, minDim * 0.4)
      g.addColorStop(0, 'rgba(255,255,255,0.10)')
      g.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.save()
      ctx.globalCompositeOperation = 'screen'
      ctx.globalAlpha = 0.7 + 0.3 * loopSin(t, 3, phase + 0.5)
      ctx.fillStyle = g
      ctx.fillRect(0, 0, p.W, p.H)
      ctx.restore()
      drawVignette(ctx, p.W, p.H, 0.42, vig)
      drawGrain(ctx, grain, p.W, p.H, 0.06, fr)
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
    return (ctx, t, frame) => {
      const fr = frameRng(p.seed, frame)
      const scale = 1.07 + 0.01 * loopSin(t, 1, phase)
      const jitterY = (fr() - 0.5) * p.H * 0.003
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
      const shift = p.W * (0.01 + 0.015 * fr())
      ctx.drawImage(src.canvas, 0, Math.max(0, bandY), p.W, bandH, shift, Math.max(0, bandY), p.W, bandH)
      ctx.save()
      ctx.beginPath()
      ctx.rect(0, bandY, p.W, bandH)
      ctx.clip()
      ctx.globalAlpha = 0.1
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, bandY, p.W, bandH)
      drawGrain(ctx, grain, p.W, p.H, 0.5, fr)
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
      drawGrain(ctx, grain, p.W, p.H, 0.1, fr)
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
    return (ctx, t, frame) => {
      const fr = frameRng(p.seed, frame)
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
        const slices = 3 + Math.floor(fr() * 4)
        for (let s = 0; s < slices; s++) {
          const sy = Math.floor(fr() * p.H)
          const sh = Math.max(2, Math.floor((0.006 + fr() * 0.03) * p.H))
          const dx = (fr() < 0.5 ? -1 : 1) * (0.03 + fr() * 0.09) * p.W * e
          ctx.drawImage(src.canvas, 0, sy, p.W, sh, dx, sy, p.W, sh)
        }
        // Block echo: a displaced rectangular chunk
        if (fr() < 0.7) {
          const bw = Math.floor((0.15 + fr() * 0.3) * p.W)
          const bh = Math.floor((0.05 + fr() * 0.15) * p.H)
          const bx = Math.floor(fr() * (p.W - bw))
          const by = Math.floor(fr() * (p.H - bh))
          const dx = (fr() < 0.5 ? -1 : 1) * (0.02 + fr() * 0.05) * p.W
          ctx.drawImage(src.canvas, bx, by, bw, bh, bx + dx, by, bw, bh)
        }
        drawGrain(ctx, grain, p.W, p.H, 0.25 * e, fr)
        // Rare full-frame invert pop at burst peaks
        if (e > 0.85 && fr() < 0.25) {
          ctx.save()
          ctx.globalCompositeOperation = 'difference'
          ctx.globalAlpha = 0.9
          ctx.fillStyle = '#fff'
          ctx.fillRect(0, 0, p.W, p.H)
          ctx.restore()
        }
      }
      drawVignette(ctx, p.W, p.H, 0.32, vig)
      drawGrain(ctx, grain, p.W, p.H, 0.05, fr)
    }
  },
}

// Registry — insertion order is the UI display order.
export const EFFECTS: Record<EffectId, EffectDef> = {
  kenburns,
  drone,
  parallax,
  dust,
  pulse,
  strobe,
  zoomblur,
  liquid,
  orbit,
  kaleido,
  vhs,
  glitch,
}

export const EFFECT_IDS = Object.keys(EFFECTS) as EffectId[]
