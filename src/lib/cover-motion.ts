// A cover set in motion by DESIGN, not by a video model.
//
// The owner (2026-11-11), on what should move their covers: "I also like
// using fable for visualizer". A filmed clip costs about 80 Runway credits
// and redraws the picture (the first one turned the cassette green); a plain
// drift (still-loop.ts) is free but says nothing about the picture. This is
// the third way: a model LOOKS at the finished cover and writes a short
// motion plan for it (cover-motion-direct.ts) out of a small set of
// hand-coded elements, and the server draws that plan over the real cover
// pixels (cover-motion-scene.ts). Sand blows across the sand cover, the
// monitor's pulse line runs, lava breathes. Nothing in the picture is
// regenerated, so the cassette cannot change.
//
// This file is the plan itself: its shape, the strict reader that clamps
// whatever a model wrote into something safe to draw, and the geometry that
// carries a plan written against the SQUARE cover into the 9:16 and 16:9
// frames (the cover sits in the middle of both, see buildOutpaintRequest).
//
// Pure and dependency-free: scripts/cover-motion-test.mjs runs it under Node.

export type MotionPoint = { x: number; y: number }
/** A rectangle of the square cover, in fractions of its side. */
export type MotionArea = { x: number; y: number; w: number; h: number }

export const PARTICLE_LOOKS = ['dust', 'sand', 'snow', 'rain', 'embers', 'bubbles', 'moths'] as const
export type ParticleLook = (typeof PARTICLE_LOOKS)[number]
export const GLOW_PACES = ['breathe', 'flicker', 'pulse'] as const
export type GlowPace = (typeof GLOW_PACES)[number]
export const SHIMMER_LOOKS = ['heat', 'water', 'breeze'] as const
export type ShimmerLook = (typeof SHIMMER_LOOKS)[number]
export const CAMERA_MOVES = ['float', 'push', 'sway', 'rise', 'still'] as const
export type CameraMove = (typeof CAMERA_MOVES)[number]
export const ELEMENT_KINDS = ['particles', 'glow', 'shimmer', 'sweep', 'mist', 'trace', 'spin'] as const
export type ElementKind = (typeof ELEMENT_KINDS)[number]

export type MotionElement =
  /** Small things carried through the air: each lives, travels a little way along `angle` and fades. */
  | { kind: 'particles'; look: ParticleLook; area: MotionArea; color: string; amount: number; angle: number }
  /** A light that is already in the picture, made to breathe, flicker or beat. */
  | { kind: 'glow'; pace: GlowPace; at: MotionPoint; radius: number; color: string; amount: number }
  /** The picture itself wavering inside an area: hot air, water, or leaves and cloth in a breeze. */
  | { kind: 'shimmer'; look: ShimmerLook; area: MotionArea; amount: number }
  /** One glint of light crossing an area once per loop (glass, a bubble, the cassette's shell). */
  | { kind: 'sweep'; area: MotionArea; color: string; amount: number; angle: number }
  /** Slow soft haze drifting along `angle`. */
  | { kind: 'mist'; area: MotionArea; color: string; amount: number; angle: number }
  /** A point of light running along a line that is drawn in the picture. */
  | { kind: 'trace'; path: MotionPoint[]; color: string; amount: number; laps: number }
  /** A cassette reel turning about its centre, `laps` whole turns per loop. Seen at an angle it is an ellipse: `squash` is its short axis over its long one, `tilt` the long axis's lean in degrees (both found in the picture by refineSpins, never asked of a model). */
  | { kind: 'spin'; at: MotionPoint; radius: number; laps: number; squash?: number; tilt?: number }

export type MotionRecipe = {
  /** One plain sentence the artist can read: what moves. */
  summary: string
  camera: { move: CameraMove; amount: number }
  /** Live film grain, 0 to 1. */
  grain: number
  elements: MotionElement[]
}

/** Most elements one plan may carry (the two reels are two of them): more than this is a busy picture, not a designed one. */
export const MAX_ELEMENTS = 7
const MAX_PATH = 16

const num = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : dflt
  return Math.min(hi, Math.max(lo, n))
}

const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | null =>
  typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null

/** `#rgb` or `#rrggbb` → `#rrggbb`; anything else → the fallback. */
export function hexColor(v: unknown, dflt = '#fff4e0'): string {
  if (typeof v !== 'string') return dflt
  const s = v.trim().toLowerCase()
  if (/^#[0-9a-f]{6}$/.test(s)) return s
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`
  return dflt
}

function point(v: unknown): MotionPoint | null {
  if (!v || typeof v !== 'object') return null
  const p = v as Record<string, unknown>
  if (typeof p.x !== 'number' || typeof p.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null
  return { x: num(p.x, 0, 1, 0.5), y: num(p.y, 0, 1, 0.5) }
}

/** An area kept inside the cover and never thinner than a twentieth of it. */
function area(v: unknown): MotionArea | null {
  if (!v || typeof v !== 'object') return null
  const a = v as Record<string, unknown>
  if ([a.x, a.y, a.w, a.h].some(n => typeof n !== 'number' || !Number.isFinite(n))) return null
  const x = num(a.x, 0, 0.95, 0), y = num(a.y, 0, 0.95, 0)
  const w = num(a.w, 0, 1 - x, 1 - x), h = num(a.h, 0, 1 - y, 1 - y)
  if (w < 0.05 || h < 0.05) return null
  return { x, y, w, h }
}

function element(v: unknown): MotionElement | null {
  if (!v || typeof v !== 'object') return null
  const e = v as Record<string, unknown>
  const kind = oneOf(e.kind, ELEMENT_KINDS)
  const amount = num(e.amount, 0, 1, 0.4)
  if (!kind || (amount < 0.02 && kind !== 'spin')) return null
  const angle = ((num(e.angle, -3600, 3600, 0) % 360) + 360) % 360
  switch (kind) {
    case 'particles': {
      const a = area(e.area), look = oneOf(e.look, PARTICLE_LOOKS)
      return a && look ? { kind, look, area: a, color: hexColor(e.color), amount, angle } : null
    }
    case 'glow': {
      const at = point(e.at)
      return at ? { kind, pace: oneOf(e.look, GLOW_PACES) ?? oneOf(e.pace, GLOW_PACES) ?? 'breathe', at, radius: num(e.radius, 0.03, 0.6, 0.15), color: hexColor(e.color), amount } : null
    }
    case 'shimmer': {
      const a = area(e.area)
      return a ? { kind, look: oneOf(e.look, SHIMMER_LOOKS) ?? 'heat', area: a, amount } : null
    }
    case 'sweep': {
      const a = area(e.area)
      return a ? { kind, area: a, color: hexColor(e.color, '#ffffff'), amount, angle } : null
    }
    case 'mist': {
      const a = area(e.area)
      return a ? { kind, area: a, color: hexColor(e.color, '#e8e4dc'), amount, angle } : null
    }
    case 'trace': {
      const path = (Array.isArray(e.path) ? e.path : []).map(point).filter((p): p is MotionPoint => p !== null).slice(0, MAX_PATH)
      return path.length >= 2 ? { kind, path, color: hexColor(e.color), amount, laps: Math.round(num(e.laps, 1, 3, 1)) } : null
    }
    case 'spin': {
      const at = point(e.at)
      if (!at) return null
      const spin: MotionElement = { kind, at, radius: num(e.radius, 0.005, 0.2, 0.03), laps: Math.round(num(e.laps, 1, 4, 2)) }
      if (typeof e.squash === 'number' && Number.isFinite(e.squash)) spin.squash = num(e.squash, 0.4, 1, 1)
      if (typeof e.tilt === 'number' && Number.isFinite(e.tilt)) spin.tilt = ((num(e.tilt, -3600, 3600, 0) % 180) + 180) % 180
      return spin
    }
  }
}

/**
 * Whatever a model (or a stored clip's settings) says a plan is, read into a
 * plan that is safe to draw: every number in range, every element whole, at
 * most MAX_ELEMENTS of them. Null when it is not a plan at all. A plan with
 * no usable element is still a plan (the camera and the grain move it).
 */
export function parseMotionRecipe(v: unknown): MotionRecipe | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const cam = (r.camera && typeof r.camera === 'object' ? r.camera : null) as Record<string, unknown> | null
  if (!cam || !Array.isArray(r.elements)) return null
  const move = oneOf(cam.move, CAMERA_MOVES)
  if (!move) return null
  return {
    summary: typeof r.summary === 'string' ? r.summary.replace(/\s+/g, ' ').trim().slice(0, 200) : '',
    camera: { move, amount: num(cam.amount, 0, 1, 0.4) },
    grain: num(r.grain, 0, 1, 0.4),
    elements: r.elements.map(element).filter((e): e is MotionElement => e !== null).slice(0, MAX_ELEMENTS),
  }
}

/**
 * The plan used when no model can be asked: the camera eases in and back
 * over live grain. No elements: nothing has looked at the picture, and dust
 * or sparks added blind are exactly the stock effect the owner cannot stand.
 */
export function templateRecipe(): MotionRecipe {
  return {
    summary: 'The camera eases in and back.',
    camera: { move: 'push', amount: 0.6 },
    grain: 0.4,
    elements: [],
  }
}

// ── Square cover → video frame ───────────────────────────────────────────────

export type FrameRect = { x: number; y: number; w: number; h: number }

/** Where the square cover sits in a W×H frame: centred, as big as the short edge. */
export function coverSquare(W: number, H: number): { left: number; top: number; size: number } {
  const size = Math.min(W, H)
  return { left: (W - size) / 2, top: (H - size) / 2, size }
}

export function pointToFrame(p: MotionPoint, W: number, H: number): { x: number; y: number } {
  const sq = coverSquare(W, H)
  return { x: sq.left + p.x * sq.size, y: sq.top + p.y * sq.size }
}

/** An area edge this close to the cover's edge is taken to mean "to the edge of the picture". */
const EDGE = 0.03

/**
 * A cover area in frame pixels. The cover is only the middle of a video
 * frame, so an area that runs to the cover's edge runs on to the frame's:
 * weather drawn "across the whole cover" has to cross the whole video.
 */
export function areaToFrame(a: MotionArea, W: number, H: number): FrameRect {
  const sq = coverSquare(W, H)
  const x0 = a.x <= EDGE ? 0 : sq.left + a.x * sq.size
  const y0 = a.y <= EDGE ? 0 : sq.top + a.y * sq.size
  const x1 = a.x + a.w >= 1 - EDGE ? W : sq.left + (a.x + a.w) * sq.size
  const y1 = a.y + a.h >= 1 - EDGE ? H : sq.top + (a.y + a.h) * sq.size
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}
