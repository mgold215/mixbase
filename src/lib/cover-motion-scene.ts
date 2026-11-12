// The per-frame scene of a designed moving cover (the plan: cover-motion.ts).
//
// Draws the real cover pixels with a slow camera, and over them the plan's
// elements. Two layers of motion, which is what gives a flat picture depth:
//   anchored  shimmer, glow, trace, sweep: they belong to things IN the
//             picture, so they are drawn inside the camera's transform and
//             move with it;
//   in the air  mist and particles: drawn in the frame's own space, so the
//             picture drifts behind them.
//
// Everything is periodic over the loop. Camera and lights are whole-cycle
// sines. A particle cannot simply fly across (a whole crossing per 8 s loop
// is far too fast for dust), so each one LIVES: it fades in, travels a short
// way, fades out, and starts again a whole number of times per loop. At the
// seam its place in that life is the same as at frame 0.
//
// Canvas 2D only and sharp-free, so the render worker never loads sharp, and
// deterministic per frame (all randomness is frameRng(seed, n)), so frame K
// is the same picture whichever worker draws it.
//
// Relative, extension-full imports only — scripts/cover-motion-test.mjs runs
// this under Node type stripping.

import { frameRng, loopSin } from './free-effects.ts'
import type { MotionLayerFactory } from './cassette-motion-scene.ts'
import {
  areaToFrame, coverSquare, pointToFrame,
  type FrameRect, type MotionElement, type MotionRecipe,
} from './cover-motion.ts'

type Ctx = CanvasRenderingContext2D
type Img = CanvasImageSource & { width: number; height: number }

export type CoverMotionSetup = {
  W: number
  H: number
  /** Frames in the loop. */
  total: number
  seed: number
  /** The cover already fitted to the frame's shape (any resolution of that shape). */
  still: Img
  recipe: MotionRecipe
  createLayer: MotionLayerFactory
  /** Fresh film grain every frame. Default true; tests turn it off to compare frames exactly. */
  grain?: boolean
}

const TAU = Math.PI * 2
const frac = (v: number) => v - Math.floor(v)
const smooth = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

function rgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
}
const rgba = (hex: string, a: number) => { const [r, g, b] = rgb(hex); return `rgba(${r},${g},${b},${a})` }
const luma = (hex: string) => { const [r, g, b] = rgb(hex); return 0.299 * r + 0.587 * g + 0.114 * b }

/**
 * The camera at loop position t: zoom and drift, in frame px. Exported for
 * the test, which checks the picture always covers the frame.
 */
export function cameraAt(move: MotionRecipe['camera']['move'], amount: number, t: number, W: number, H: number): { z: number; dx: number; dy: number } {
  const a = Math.min(1, Math.max(0, amount))
  // Room to move: the picture is always drawn a little larger than the frame.
  const base = 1.04 + 0.08 * a
  // A hand is never perfectly still: a faint higher harmonic under every move.
  const hx = 0.002 * W * a * loopSin(t, 3, 1.3), hy = 0.0015 * H * a * loopSin(t, 2, 0.7)
  switch (move) {
    case 'push':
      return { z: base + 0.07 * a * (1 - Math.cos(TAU * t)) / 2, dx: 0.006 * W * a * loopSin(t, 1, 0.9) + hx, dy: 0.005 * H * a * loopSin(t, 1, 2.3) + hy }
    case 'sway':
      return { z: base + 0.01 * a * loopSin(t, 2, 0.5), dx: 0.032 * W * a * loopSin(t, 1) + hx, dy: 0.006 * H * a * loopSin(t, 1, 1.9) + hy }
    case 'rise':
      return { z: base + 0.01 * a * loopSin(t, 2, 0.5), dx: 0.006 * W * a * loopSin(t, 1, 0.6) + hx, dy: 0.032 * H * a * loopSin(t, 1) + hy }
    case 'still':
      return { z: 1.02, dx: hx * 0.5, dy: hy * 0.5 }
    case 'float':
    default:
      return { z: base + 0.02 * a * loopSin(t, 1), dx: 0.022 * W * a * loopSin(t, 1, 0.4) + hx, dy: 0.017 * H * a * loopSin(t, 1, 2.0) + hy }
  }
}

type Drawer = { anchored: boolean; draw: (ctx: Ctx, t: number, frame: number) => void }

// What each kind of particle is: how many at amount 1 over a cover-sized
// area, its size and travel as fractions of the cover's side, how many lives
// per loop, how it is blended.
const PARTICLES: Record<string, {
  count: [number, number]; size: [number, number]; travel: [number, number]; lives: number[]
  alpha: [number, number]; wobble: number; streak: number; blend: GlobalCompositeOperation; edge: number
}> = {
  dust:    { count: [26, 150], size: [0.0014, 0.0048], travel: [0.03, 0.13], lives: [1, 1, 2],    alpha: [0.25, 0.8],  wobble: 0.012, streak: 0,     blend: 'screen', edge: 0.5 },
  sand:    { count: [200, 900], size: [0.0006, 0.0015], travel: [0.2, 0.55], lives: [2, 3, 3, 4], alpha: [0.3, 0.75],  wobble: 0.004, streak: 0.0045, blend: 'source-over', edge: 0.25 },
  snow:    { count: [35, 200], size: [0.0016, 0.006],  travel: [0.25, 0.5],  lives: [1, 2, 2],    alpha: [0.3, 0.85],  wobble: 0.02,  streak: 0,     blend: 'screen', edge: 0.25 },
  rain:    { count: [40, 240], size: [0.0006, 0.0012], travel: [0.6, 1.0],   lives: [4, 5, 6, 8], alpha: [0.1, 0.32],  wobble: 0,     streak: 0.05,  blend: 'screen', edge: 0.12 },
  embers:  { count: [10, 60],  size: [0.0012, 0.0036], travel: [0.14, 0.4],  lives: [1, 2, 2],    alpha: [0.5, 1],     wobble: 0.02,  streak: 0,     blend: 'lighter', edge: 0.3 },
  bubbles: { count: [6, 36],   size: [0.004, 0.014],   travel: [0.1, 0.3],   lives: [1, 1, 2],    alpha: [0.25, 0.6],  wobble: 0.012, streak: 0,     blend: 'screen', edge: 0.3 },
  moths:   { count: [1, 5],    size: [0.0028, 0.0052], travel: [0.5, 1.0],   lives: [1],          alpha: [0.6, 0.95],  wobble: 0.05,  streak: 0,     blend: 'screen', edge: 0.16 },
}

/** A soft round dot of one colour, drawn once and stamped for every particle. */
function dotSprite(createLayer: MotionLayerFactory, color: string, hard = 0.25): CanvasImageSource {
  const N = 64
  const l = createLayer(N, N)
  const g = l.ctx.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2)
  g.addColorStop(0, rgba(color, 1))
  g.addColorStop(hard, rgba(color, 0.85))
  g.addColorStop(0.6, rgba(color, 0.22))
  g.addColorStop(1, rgba(color, 0))
  l.ctx.fillStyle = g
  l.ctx.fillRect(0, 0, N, N)
  return l.canvas
}

/** White with soft edges: what a layer is multiplied by (destination-in) so it has no visible border. */
function featherMask(createLayer: MotionLayerFactory, w: number, h: number, round: boolean): CanvasImageSource {
  const l = createLayer(w, h)
  const c = l.ctx
  if (round) {
    c.save()
    c.translate(w / 2, h / 2)
    c.scale(w / 2, h / 2)
    const g = c.createRadialGradient(0, 0, 0, 0, 0, 1)
    g.addColorStop(0, 'rgba(255,255,255,1)')
    g.addColorStop(0.55, 'rgba(255,255,255,1)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    c.fillStyle = g
    c.fillRect(-1, -1, 2, 2)
    c.restore()
    return l.canvas
  }
  const fx = Math.min(w * 0.3, Math.max(8, w * 0.18)) / w, fy = Math.min(h * 0.3, Math.max(8, h * 0.18)) / h
  const gx = c.createLinearGradient(0, 0, w, 0)
  gx.addColorStop(0, 'rgba(255,255,255,0)'); gx.addColorStop(fx, 'rgba(255,255,255,1)')
  gx.addColorStop(1 - fx, 'rgba(255,255,255,1)'); gx.addColorStop(1, 'rgba(255,255,255,0)')
  c.fillStyle = gx
  c.fillRect(0, 0, w, h)
  const gy = c.createLinearGradient(0, 0, 0, h)
  gy.addColorStop(0, 'rgba(255,255,255,0)'); gy.addColorStop(fy, 'rgba(255,255,255,1)')
  gy.addColorStop(1 - fy, 'rgba(255,255,255,1)'); gy.addColorStop(1, 'rgba(255,255,255,0)')
  c.globalCompositeOperation = 'destination-in'
  c.fillStyle = gy
  c.fillRect(0, 0, w, h)
  return l.canvas
}

function makeParticles(s: CoverMotionSetup, e: Extract<MotionElement, { kind: 'particles' }>, salt: number): Drawer {
  const { W, H } = s
  const S = coverSquare(W, H).size
  const spec = PARTICLES[e.look]
  const R = areaToFrame(e.area, W, H)
  const share = Math.min(1.6, Math.max(0.35, Math.sqrt((R.w * R.h) / (S * S))))
  const n = Math.round((spec.count[0] + (spec.count[1] - spec.count[0]) * e.amount) * share)
  const dir = { x: Math.cos((e.angle * Math.PI) / 180), y: Math.sin((e.angle * Math.PI) / 180) }
  const r = frameRng(s.seed ^ salt, 0)
  const sprite = dotSprite(s.createLayer, e.color, e.look === 'dust' || e.look === 'snow' ? 0.18 : 0.35)
  const parts = Array.from({ length: n }, () => {
    const depth = r()                           // 0 far … 1 near: nearer is larger, faster, fainter-edged
    // A few dust motes sit close to the lens: large, soft and barely there.
    const bokeh = e.look === 'dust' && r() < 0.1
    return {
      x: R.x + r() * R.w, y: R.y + r() * R.h,
      size: (spec.size[0] + (spec.size[1] - spec.size[0]) * depth) * S * (bokeh ? 5 : 1),
      travel: (spec.travel[0] + (spec.travel[1] - spec.travel[0]) * (0.3 + 0.7 * depth)) * S,
      lives: spec.lives[Math.floor(r() * spec.lives.length)],
      phase: r(),
      alpha: (spec.alpha[0] + (spec.alpha[1] - spec.alpha[0]) * r()) * (bokeh ? 0.22 : 1),
      wobA: spec.wobble * S * (0.4 + r()), wobC: 1 + Math.floor(r() * 3), wobP: r() * TAU,
      twC: 2 + Math.floor(r() * 5), twP: r() * TAU,
    }
  })
  // Blown sand is not an even rain of grains: it comes over the ground in
  // gusts, and with it thin veils of finer dust too small to see as grains.
  const sand = e.look === 'sand'
  const gustLen = 1.3 * S, gustPh = r() * TAU
  const gust = (x: number, y: number, t: number) => {
    const g = Math.sin(TAU * ((x * dir.x + y * dir.y) / gustLen - 2 * t) + gustPh + 0.8 * Math.sin(TAU * (x * dir.y - y * dir.x) / (0.9 * S)))
    return 0.2 + 0.8 * Math.max(0, g) ** 1.5
  }
  const veils = sand
    ? Array.from({ length: Math.round((6 + 14 * e.amount) * share) }, () => ({
        x: R.x + r() * R.w, y: R.y + r() * R.h,
        rx: (0.1 + 0.16 * r()) * S, ry: (0.005 + 0.011 * r()) * S,
        travel: (0.35 + 0.4 * r()) * S, lives: 2 + Math.floor(r() * 2), phase: r(), alpha: 0.05 + 0.09 * r(),
      }))
    : []
  const veil = sand ? dotSprite(s.createLayer, e.color, 0.05) : null
  const turn = Math.atan2(dir.y, dir.x)
  return {
    anchored: false,
    draw(ctx, t) {
      ctx.globalCompositeOperation = spec.blend
      ctx.lineCap = 'round'
      for (const v of veils) {
        const u = frac(v.lives * t + v.phase)
        const env = Math.sin(Math.PI * u) ** 2
        const along = (u - 0.5) * v.travel
        const x = v.x + dir.x * along, y = v.y + dir.y * along
        ctx.globalAlpha = v.alpha * env * gust(x, y, t) * (0.5 + 0.5 * e.amount)
        ctx.save()
        ctx.translate(x, y)
        ctx.rotate(turn)
        ctx.drawImage(veil!, -v.rx, -v.ry, v.rx * 2, v.ry * 2)
        ctx.restore()
      }
      for (const p of parts) {
        const u = frac(p.lives * t + p.phase)
        // Its life: in over the first part, out over the last.
        const env = smooth(0, spec.edge, u) * (1 - smooth(1 - spec.edge, 1, u))
        if (env <= 0.004) continue
        let wob = p.wobA * loopSin(t, p.wobC, p.wobP)
        let along = (u - 0.5) * p.travel
        if (e.look === 'moths') {
          // Never a straight line: it dips, doubles back and jitters.
          wob += p.wobA * (0.8 * loopSin(t, p.wobC + 3, p.twP) + 0.35 * loopSin(t, p.twC + 9, p.wobP))
          along += p.wobA * 0.9 * loopSin(t, p.wobC + 2, p.twP + 1)
        }
        const x = p.x + dir.x * along - dir.y * wob
        const y = p.y + dir.y * along + dir.x * wob
        let a = p.alpha * env
        if (sand) a *= gust(x, y, t)
        if (e.look === 'dust' || e.look === 'embers') a *= 0.62 + 0.38 * loopSin(t, p.twC, p.twP)
        // A moth is seen by its wings: it beats bright and dim many times a second.
        if (e.look === 'moths') a *= 0.45 + 0.55 * Math.abs(loopSin(t, 36 + p.twC * 4, p.twP))
        if (spec.streak > 0) {
          const len = spec.streak * S * (0.5 + p.size / (spec.size[1] * S))
          ctx.globalAlpha = a
          ctx.strokeStyle = e.color
          ctx.lineWidth = Math.max(1, p.size * 2)
          ctx.beginPath()
          ctx.moveTo(x - dir.x * len, y - dir.y * len)
          ctx.lineTo(x, y)
          ctx.stroke()
        } else if (e.look === 'bubbles') {
          ctx.globalAlpha = a
          ctx.strokeStyle = e.color
          ctx.lineWidth = Math.max(1, p.size * 0.16)
          ctx.beginPath()
          ctx.arc(x, y, p.size, 0, TAU)
          ctx.stroke()
          ctx.globalAlpha = a * 0.9
          ctx.drawImage(sprite, x - p.size * 0.75, y - p.size * 0.75, p.size * 0.6, p.size * 0.6)
        } else {
          const d = p.size * 4
          ctx.globalAlpha = a
          ctx.drawImage(sprite, x - d / 2, y - d / 2, d, d)
        }
      }
    },
  }
}

function makeGlow(s: CoverMotionSetup, e: Extract<MotionElement, { kind: 'glow' }>, salt: number): Drawer {
  const { W, H } = s
  const S = coverSquare(W, H).size
  const c = pointToFrame(e.at, W, H)
  const radius = e.radius * S
  const r = frameRng(s.seed ^ salt, 0)
  const ph = [r() * TAU, r() * TAU, r() * TAU, r() * TAU]
  const beats = Math.max(2, Math.round(s.total / 30))        // about one a second
  const level = (t: number) => {
    if (e.pace === 'pulse') {
      const p = frac(beats * t + ph[0] / TAU)
      return 0.22 + 0.78 * Math.exp(-5.5 * p)
    }
    if (e.pace === 'flicker') {
      return Math.min(1, Math.max(0, 0.62 + 0.2 * loopSin(t, 3, ph[0]) + 0.11 * loopSin(t, 7, ph[1]) + 0.07 * loopSin(t, 13, ph[2])))
    }
    return 0.5 + 0.5 * (0.8 * loopSin(t, 1, ph[0]) + 0.2 * loopSin(t, 2, ph[1]))
  }
  return {
    anchored: true,
    draw(ctx, t) {
      const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, radius)
      g.addColorStop(0, rgba(e.color, 1))
      g.addColorStop(0.35, rgba(e.color, 0.42))
      g.addColorStop(1, rgba(e.color, 0))
      ctx.globalCompositeOperation = 'screen'
      ctx.globalAlpha = Math.min(1, 0.85 * e.amount * level(t))
      ctx.fillStyle = g
      ctx.fillRect(c.x - radius, c.y - radius, radius * 2, radius * 2)
    },
  }
}

function makeShimmer(s: CoverMotionSetup, e: Extract<MotionElement, { kind: 'shimmer' }>, salt: number): Drawer {
  const { W, H } = s
  const S = coverSquare(W, H).size
  const R = clampRect(areaToFrame(e.area, W, H), W, H)
  const w = Math.max(2, Math.round(R.w)), h = Math.max(2, Math.round(R.h))
  const layer = s.createLayer(w, h)
  const mask = featherMask(s.createLayer, w, h, false)
  const kx = s.still.width / W, ky = s.still.height / H
  // heat: fine fast waver. water: broader ripples. breeze: long slow bands,
  // so leaves, grass and cloth lean one way and back instead of rippling.
  const water = e.look === 'water', breeze = e.look === 'breeze'
  const A = e.amount * S * (breeze ? 0.0085 : water ? 0.0095 : 0.0045)
  const l1 = S * (breeze ? 0.42 : water ? 0.07 : 0.034), l2 = S * (breeze ? 0.17 : water ? 0.027 : 0.013)
  const c1 = breeze ? 1 : water ? 2 : 3, c2 = breeze ? 2 : water ? 3 : 5
  const strip = water ? 3 : 2
  const r = frameRng(s.seed ^ salt, 0)
  const p1 = r() * TAU, p2 = r() * TAU
  return {
    anchored: true,
    draw(ctx, t) {
      const lc = layer.ctx
      lc.reset()
      for (let y = 0; y < h; y += strip) {
        // Rows slide sideways by a wave that travels up the area (hot air rises; ripples run).
        const dx = A * (Math.sin(TAU * (y / l1 + c1 * t) + p1) + 0.5 * Math.sin(TAU * (y / l2 + c2 * t) + p2))
        const sx = Math.min(Math.max(0, (R.x + dx) * kx), s.still.width - w * kx)
        lc.drawImage(s.still, sx, (R.y + y) * ky, w * kx, strip * ky, 0, y, w, strip)
      }
      lc.globalCompositeOperation = 'destination-in'
      lc.drawImage(mask, 0, 0)
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
      ctx.drawImage(layer.canvas, R.x, R.y)
    },
  }
}

function makeSweep(s: CoverMotionSetup, e: Extract<MotionElement, { kind: 'sweep' }>, salt: number): Drawer {
  const { W, H } = s
  const R = clampRect(areaToFrame(e.area, W, H), W, H)
  const w = Math.max(2, Math.round(R.w)), h = Math.max(2, Math.round(R.h))
  const layer = s.createLayer(w, h)
  const mask = featherMask(s.createLayer, w, h, true)
  const dir = { x: Math.cos((e.angle * Math.PI) / 180), y: Math.sin((e.angle * Math.PI) / 180) }
  const reach = Math.abs(dir.x) * w + Math.abs(dir.y) * h
  const band = reach * 0.22
  const phase = frameRng(s.seed ^ salt, 0)()
  /** The share of the loop the glint takes to cross; the rest of the time there is none. */
  const CROSS = 0.3
  return {
    anchored: true,
    draw(ctx, t) {
      const u = frac(t + phase)
      if (u >= CROSS) return
      const p = u / CROSS
      const pos = -band + (reach + 2 * band) * p - reach / 2      // along dir, from the area's centre
      const cx = w / 2 + dir.x * pos, cy = h / 2 + dir.y * pos
      const lc = layer.ctx
      lc.reset()
      const g = lc.createLinearGradient(cx - dir.x * band, cy - dir.y * band, cx + dir.x * band, cy + dir.y * band)
      g.addColorStop(0, rgba(e.color, 0))
      g.addColorStop(0.5, rgba(e.color, 1))
      g.addColorStop(1, rgba(e.color, 0))
      lc.fillStyle = g
      lc.fillRect(0, 0, w, h)
      lc.globalCompositeOperation = 'destination-in'
      lc.drawImage(mask, 0, 0)
      ctx.globalCompositeOperation = 'screen'
      ctx.globalAlpha = Math.min(1, 0.75 * e.amount * Math.sin(Math.PI * p))
      ctx.drawImage(layer.canvas, R.x, R.y)
    },
  }
}

function makeMist(s: CoverMotionSetup, e: Extract<MotionElement, { kind: 'mist' }>, salt: number): Drawer {
  const { W, H } = s
  const S = coverSquare(W, H).size
  const R = areaToFrame(e.area, W, H)
  const dir = { x: Math.cos((e.angle * Math.PI) / 180), y: Math.sin((e.angle * Math.PI) / 180) }
  const sprite = dotSprite(s.createLayer, e.color, 0.05)
  const r = frameRng(s.seed ^ salt, 0)
  const n = Math.round(5 + 7 * e.amount)
  const blobs = Array.from({ length: n }, () => ({
    x: R.x + r() * R.w, y: R.y + (0.15 + 0.7 * r()) * R.h,
    rx: (0.22 + 0.3 * r()) * S, ry: (0.07 + 0.1 * r()) * S,
    travel: (0.18 + 0.3 * r()) * S, phase: r(), alpha: 0.5 + 0.5 * r(),
  }))
  const light = luma(e.color) > 105
  return {
    anchored: false,
    draw(ctx, t) {
      ctx.globalCompositeOperation = light ? 'screen' : 'source-over'
      for (const b of blobs) {
        const u = frac(t + b.phase)
        const env = Math.sin(Math.PI * u) ** 2
        if (env <= 0.004) continue
        const along = (u - 0.5) * b.travel
        ctx.globalAlpha = 0.42 * e.amount * b.alpha * env
        ctx.drawImage(sprite, b.x + dir.x * along - b.rx, b.y + dir.y * along - b.ry, b.rx * 2, b.ry * 2)
      }
    },
  }
}

function makeTrace(s: CoverMotionSetup, e: Extract<MotionElement, { kind: 'trace' }>): Drawer {
  const { W, H } = s
  const S = coverSquare(W, H).size
  const pts = e.path.map(p => pointToFrame(p, W, H))
  const cum = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y))
  const length = cum[cum.length - 1] || 1
  const at = (d: number) => {
    const v = Math.min(length, Math.max(0, d))
    let i = 1
    while (i < cum.length - 1 && cum[i] < v) i++
    const k = (v - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1])
    return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * k, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * k }
  }
  const sprite = dotSprite(s.createLayer, e.color, 0.3)
  const width = S * 0.0042 * (0.7 + 0.8 * e.amount)
  const TAIL = 0.2, STEPS = 46
  return {
    anchored: true,
    draw(ctx, t) {
      const head = frac(e.laps * t)
      // It appears at the start of the line and is gone by its end, so the next lap starts clean.
      const life = smooth(0, 0.05, head) * (1 - smooth(0.93, 1, head))
      if (life <= 0.004) return
      ctx.globalCompositeOperation = 'lighter'
      for (let i = STEPS; i >= 0; i--) {
        const k = i / STEPS
        const d = (head - TAIL * k) * length
        if (d < 0) continue
        const p = at(d)
        const size = width * (i === 0 ? 5.5 : 2.6 * (1 - 0.6 * k))
        ctx.globalAlpha = Math.min(1, e.amount * life * (i === 0 ? 0.95 : 0.34 * (1 - k) ** 1.6))
        ctx.drawImage(sprite, p.x - size, p.y - size, size * 2, size * 2)
      }
    },
  }
}

/** A hard-edged disc with only its rim softened: what a turning reel is cut out with. */
function discMask(createLayer: MotionLayerFactory, d: number): CanvasImageSource {
  const l = createLayer(d, d)
  const g = l.ctx.createRadialGradient(d / 2, d / 2, 0, d / 2, d / 2, d / 2)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.86, 'rgba(255,255,255,1)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  l.ctx.fillStyle = g
  l.ctx.fillRect(0, 0, d, d)
  return l.canvas
}

function makeSpin(s: CoverMotionSetup, e: Extract<MotionElement, { kind: 'spin' }>): Drawer {
  const { W, H } = s
  const S = coverSquare(W, H).size
  const c = pointToFrame(e.at, W, H)
  const R = Math.max(3, e.radius * S)
  const d = Math.ceil(R * 2) + 2
  const layer = s.createLayer(d, d)
  const disc = discMask(s.createLayer, d)
  const kx = s.still.width / W, ky = s.still.height / H
  // The reel's own plane: a circle seen at an angle is an ellipse leaning by `tilt`.
  const squash = e.squash ?? 1, tilt = ((e.tilt ?? 0) * Math.PI) / 180
  const mask = s.createLayer(d, d)
  mask.ctx.translate(d / 2, d / 2)
  mask.ctx.rotate(tilt)
  mask.ctx.scale(1, squash)
  mask.ctx.rotate(-tilt)
  mask.ctx.drawImage(disc, -d / 2, -d / 2)
  return {
    anchored: true,
    draw(ctx, t) {
      const lc = layer.ctx
      lc.reset()
      lc.imageSmoothingQuality = 'high'
      // The picture's own pixels, turned about the reel's centre in the
      // reel's plane: lean, flatten, turn, and back (a tape plays anticlockwise).
      lc.translate(d / 2, d / 2)
      lc.rotate(tilt)
      lc.scale(1, squash)
      lc.rotate(-TAU * e.laps * t)
      lc.scale(1, 1 / squash)
      lc.rotate(-tilt)
      lc.drawImage(s.still, (c.x - d / 2) * kx, (c.y - d / 2) * ky, d * kx, d * ky, -d / 2, -d / 2, d, d)
      lc.setTransform(1, 0, 0, 1, 0, 0)
      lc.globalCompositeOperation = 'destination-in'
      lc.drawImage(mask.canvas, 0, 0)
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
      ctx.drawImage(layer.canvas, c.x - d / 2, c.y - d / 2)
    },
  }
}

function clampRect(r: FrameRect, W: number, H: number): FrameRect {
  const x = Math.min(W - 2, Math.max(0, r.x)), y = Math.min(H - 2, Math.max(0, r.y))
  return { x, y, w: Math.min(W - x, r.w), h: Math.min(H - y, r.h) }
}

/**
 * Returns draw(ctx, frame) for the loop. The caller resets ctx before each
 * frame (the @napi-rs/canvas snapshot leak, see cover-motion-worker.ts); the
 * draw paints the whole frame, so the reset changes no pixel.
 */
export function createCoverMotion(s: CoverMotionSetup) {
  const { W, H, recipe } = s
  const total = Math.max(1, s.total)
  const grain = s.grain !== false && recipe.grain > 0.01
  const C = { x: W / 2, y: H / 2 }

  const drawers: Drawer[] = recipe.elements.map((e, i) => {
    const salt = Math.imul(i + 1, 0x85ebca6b)
    switch (e.kind) {
      case 'particles': return makeParticles(s, e, salt)
      case 'glow': return makeGlow(s, e, salt)
      case 'shimmer': return makeShimmer(s, e, salt)
      case 'sweep': return makeSweep(s, e, salt)
      case 'mist': return makeMist(s, e, salt)
      case 'trace': return makeTrace(s, e)
      case 'spin': return makeSpin(s, e)
    }
  })
  // The picture's own wavering first, then its lights; in the air, haze behind what it carries.
  const order = (e: MotionElement) => (e.kind === 'shimmer' ? 0 : e.kind === 'spin' ? 1 : e.kind === 'mist' ? 2 : 3)
  const sorted = drawers.map((d, i) => ({ d, k: order(recipe.elements[i]), i })).sort((a, b) => a.k - b.k || a.i - b.i).map(v => v.d)
  const anchored = sorted.filter(d => d.anchored), air = sorted.filter(d => !d.anchored)

  // Static grain tiles; each frame picks one and an offset from frameRng.
  const TILE = 256
  const tiles = grain
    ? Array.from({ length: 4 }, (_, n) => {
        const t = s.createLayer(TILE, TILE)
        const img = t.ctx.createImageData(TILE, TILE)
        const r = frameRng(s.seed ^ 0x51ed, n)
        for (let i = 0; i < TILE * TILE; i++) {
          const v = 128 + (r() + r() + r() - 1.5) * 70
          img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v
          img.data[i * 4 + 3] = 255
        }
        t.ctx.putImageData(img, 0, 0)
        return t.canvas
      })
    : []

  return function draw(ctx: Ctx, frame: number) {
    const f = ((frame % total) + total) % total
    const t = f / total
    const cam = cameraAt(recipe.camera.move, recipe.camera.amount, t, W, H)

    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    // Frame px → zoomed about the frame's centre, then drifted.
    ctx.setTransform(cam.z, 0, 0, cam.z, C.x * (1 - cam.z) + cam.dx, C.y * (1 - cam.z) + cam.dy)
    ctx.drawImage(s.still, 0, 0, W, H)
    for (const d of anchored) d.draw(ctx, t, f)

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    for (const d of air) d.draw(ctx, t, f)

    if (grain) {
      const fr = frameRng(s.seed, f)
      ctx.globalCompositeOperation = 'overlay'
      ctx.globalAlpha = 0.05 + 0.15 * recipe.grain
      const tile = tiles[Math.floor(fr() * tiles.length)]
      const ox = -Math.floor(fr() * TILE), oy = -Math.floor(fr() * TILE)
      for (let y = oy; y < H; y += TILE) for (let x = ox; x < W; x += TILE) ctx.drawImage(tile, x, y)
    }
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
  }
}
