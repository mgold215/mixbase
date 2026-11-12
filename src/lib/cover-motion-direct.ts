// The motion designer: a model looks at the finished cover and writes the
// plan (cover-motion.ts) that the server then draws over it. One call per
// cover, text out, a few cents; the plan serves both video shapes.
//
// The owner asked for this model by name for their visualizers (2026-11-11);
// the art director's model stands in when it cannot be reached. With no key,
// or when neither answers, the plan is the plain one (templateRecipe): a
// floating camera and a little dust. Never throws.

import Anthropic from '@anthropic-ai/sdk'
import sharp from 'sharp'
import {
  CAMERA_MOVES, ELEMENT_KINDS, GLOW_PACES, PARTICLE_LOOKS, SHIMMER_LOOKS,
  parseMotionRecipe, templateRecipe, type MotionElement, type MotionRecipe,
} from './cover-motion.ts'

/** Tried in order: the first that answers with a plan wins. */
export const MOTION_MODELS = ['claude-fable-5-2', 'claude-opus-5-5'] as const

const POINT = {
  type: 'object',
  properties: { x: { type: 'number' }, y: { type: 'number' } },
  required: ['x', 'y'],
  additionalProperties: false,
} as const

// One flat shape for every element: a field an element does not use is still
// sent (zero, empty, "none") and ignored by the reader. A flat object with
// everything required is the shape structured output follows most reliably.
const ELEMENT = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: [...ELEMENT_KINDS] },
    look: { type: 'string', enum: [...PARTICLE_LOOKS, ...GLOW_PACES, ...SHIMMER_LOOKS, 'none'] },
    area: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
      required: ['x', 'y', 'w', 'h'],
      additionalProperties: false,
    },
    at: POINT,
    path: { type: 'array', items: POINT },
    color: { type: 'string' },
    amount: { type: 'number' },
    angle: { type: 'number' },
    radius: { type: 'number' },
    laps: { type: 'integer' },
  },
  required: ['kind', 'look', 'area', 'at', 'path', 'color', 'amount', 'angle', 'radius', 'laps'],
  additionalProperties: false,
} as const

export const MOTION_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    camera: {
      type: 'object',
      properties: { move: { type: 'string', enum: [...CAMERA_MOVES] }, amount: { type: 'number' } },
      required: ['move', 'amount'],
      additionalProperties: false,
    },
    grain: { type: 'number' },
    elements: { type: 'array', items: ELEMENT },
  },
  required: ['summary', 'camera', 'grain', 'elements'],
  additionalProperties: false,
} as const

export const MOTION_SYSTEM = `You design how a still album cover moves. The result is a short silent loop, 8 seconds, that repeats forever behind the song on a phone. Nothing is filmed and nothing is generated: you choose from a small set of hand-coded motion elements and say exactly where each one goes, and a renderer draws them over the real picture. The picture itself never changes, which is the point: the cassette in it must stay exactly as it is.

The musician has two complaints to steer between. Anything that looks AI-made or like a stock filter is out. But so is timidity: of a clip in which the picture only drifted a little, they said "all the video did was slightly move around. Very underwhelming". The loop has to read as ALIVE at a glance on a phone: several things in the picture visibly doing what they would really do. What works is what a patient camera operator would have caught had this picture been a shot of a real place.

RULES
1. Motion comes from the picture. Look at what is actually there and move what would move: reels turn, leaves and grass lean in a breeze, sand blows, a screen flickers, lava breathes, water ripples, dust hangs in a beam of light that is already there, glass catches a glint, an insect crosses a night scene. Never add a thing the picture has no source for: no snow indoors, no embers without fire, no mist in a clear dry photograph, no dust where there is no light to show it.
2. Make it readable. Besides the reels, use three or four elements that cover different parts of the picture, at amounts a viewer notices without looking for them. One faint effect is a failure. A busy mess is a failure too: every element must have its reason in the picture.
3. The cassette's body never wavers and nothing covers it: no shimmer or mist over it. Its two reels turning (spin) and one glint across its clear shell (sweep) are the only things allowed on it.
4. The lower-centre of the cover holds the title. Keep it calm: no glow, trace or sweep there.
5. Colours are taken from the picture itself, as hex: the colour of ITS light, ITS sand, ITS sparks. Never pure white unless the light in the picture is white.

COORDINATES
x and y run from 0 to 1 across the square cover, from its top-left corner. An area is {x, y, w, h}. The cover is later extended sideways or up and down to fill a video frame, and an area that reaches the cover's edge continues to the edge of the frame, so give weather, foliage and haze the full width or height where the picture has them.
angle is the direction of travel in degrees: 0 moves right, 90 moves down, 180 left, 270 up.
amount runs from 0 to 1. Most things belong between 0.45 and 0.8.

ELEMENTS (kind, and the fields each one reads)
- spin: a cassette reel turning. Use it on BOTH reels whenever the two toothed hubs are visible, each as its own element: it is the one movement every cover should have, because it says the tape is playing. Reads at (the exact centre of the hub's hole), radius (from that centre to the outside of the toothed white ring, as a fraction of the cover's width: usually 0.015 to 0.045), laps (whole turns per loop: 2). The renderer finds the hub's precise centre and the angle it is seen from near the point you give, and quietly drops a reel it cannot find, so always try.
- particles: small things carried through the air. look = dust (motes hanging in light, drifting), sand (grains and thin veils blown low over the ground in gusts), snow, rain, embers (sparks rising from fire or lava), bubbles, moths (one to five pale insects fluttering across a night or lamp-lit scene). Reads area, color, amount, angle.
- glow: a light that is already in the picture, made to live. look = breathe (slow swell: lava, a lamp, a window), flicker (unsteady: a screen, a flame, a bad tube) or pulse (a beat about once a second: an indicator light, a heart monitor). Reads at (the centre of the light), radius (how far its light reaches, as a fraction of the cover's width), color, amount. One glow per light, at most three.
- shimmer: the picture itself moving inside an area. look = breeze (leaves, grass, flowers, cloth, hair leaning one way and back: use it on every patch of foliage or fabric, as two or three areas that go round the cassette), heat (air wavering over hot ground, a road, a flame) or water (a surface with ripples, a reflection). Reads area, amount. Never over the cassette, never over the title.
- sweep: one soft glint of light crossing an area once per loop, for glass, a bubble, polished metal, the cassette's clear shell. Reads area (fit it closely round the shiny thing), color, amount, angle.
- mist: slow soft haze drifting. Only where the picture already has haze, steam, smoke or fog. Reads area, color, amount, angle.
- trace: a point of light running along a line that is DRAWN in the picture, such as a monitor's pulse line, a neon tube, a wire or a road at night. Reads path (2 to 16 points that follow the line closely, in order), color, amount, laps (how many times it runs per loop, 1 to 3).
For fields an element does not read, send 0, an empty path, "none" or "#000000". At most seven elements, the two reels included.

CAMERA
push: a slow push-in and back out, the default: it gives a flat picture depth. float: a hand-held drift. sway: side to side, for wide scenes. rise: up and down, for tall subjects. still: locked off, only when the elements carry the picture by themselves (a screen, a graphic print). amount is usually 0.55 to 0.8.

GRAIN
Live film grain. 0.35 to 0.55 for photographs, 0.25 to 0.35 for prints and drawings, 0.15 to 0.3 for clean digital art.

summary: one plain sentence for the musician saying what moves, with no technical words.

EXAMPLES OF GOOD PLANS
- A night flash photo of the cassette lying in wild undergrowth: both reels spin, breeze shimmer on the foliage left of the cassette, right of it and above it (three areas), one or two moths, dust in the flash, a push at 0.7.
- A cassette half-buried in rippled sand, photographed from above in low sun: both reels spin, sand particles across the whole cover blowing the way the shadows fall at 0.7, one sweep across the cassette's shell, a push at 0.7.
- A chalk drawing of a heart monitor whose green line climbs over the cassette: both reels spin, a trace along that line, a green flicker glow over the screen, a red pulse glow on the indicator light, camera still.
- A cassette under a soap-bubble dome in a cave with seams of lava: both reels spin, a breathe glow on each of two lava seams, one sweep across the dome, mist low around the bowl where the picture already has mist, embers above the lava, a push at 0.65.`

async function forVision(image: Buffer, edge: number): Promise<string> {
  const jpeg = await sharp(image).rotate().removeAlpha().resize(edge, edge, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer()
  return jpeg.toString('base64')
}

// ── Reels ────────────────────────────────────────────────────────────────────
// A model points at a reel's centre to within a few percent of the cover. A
// disc turned about a centre that far off wobbles like a bent wheel, so each
// spin is searched for in the picture itself: a cassette hub has six teeth,
// so around its true centre the picture looks the same after a sixth of a
// turn and different after a twelfth. Covers show the cassette in the
// scene's own perspective, so the hub is usually an ellipse: the search also
// finds how flat it is and which way it leans, and the reel is turned in that
// plane. Where no hub is found (hidden, too small, too oblique), the spin is
// dropped, and a lone reel with it: a still cassette beats a wrong one.

const HUB_EDGE = 1400
const STEPS = 72                 // 5° apart: a sixth of a turn is 12 steps, a twelfth 6

type Shape = { x: number; y: number; r: number; squash: number; tilt: number }

/** One ring of the hub, read at 72 points round the (possibly flattened, leaning) circle. */
function readRing(g: Uint8Array | Buffer, N: number, h: Shape, k: number, ring: Float32Array): void {
  const ct = Math.cos(h.tilt), st = Math.sin(h.tilt)
  for (let i = 0; i < STEPS; i++) {
    const a = (i / STEPS) * Math.PI * 2
    const u = Math.cos(a) * h.r * k, v = Math.sin(a) * h.r * k * h.squash
    const x = Math.min(N - 1, Math.max(0, Math.round(h.x + u * ct - v * st)))
    const y = Math.min(N - 1, Math.max(0, Math.round(h.y + u * st + v * ct)))
    ring[i] = g[y * N + x]
  }
}

function ringScore(ring: Float32Array): { six: number; twelfth: number } {
  let six = 0, twelfth = 0
  for (let i = 0; i < STEPS; i++) {
    six += Math.abs(ring[i] - ring[(i + 12) % STEPS])
    twelfth += Math.abs(ring[i] - ring[(i + 6) % STEPS])
  }
  return { six: six / STEPS, twelfth: twelfth / STEPS }
}

const RINGS = [0.3, 0.42, 0.54, 0.66, 0.78, 0.9]

function hubScore(g: Uint8Array | Buffer, N: number, h: Shape, ring: Float32Array): { six: number; twelfth: number } {
  let six = 0, twelfth = 0
  for (const k of RINGS) {
    readRing(g, N, h, k, ring)
    const sc = ringScore(ring)
    six += sc.six; twelfth += sc.twelfth
  }
  return { six: six / RINGS.length, twelfth: twelfth / RINGS.length }
}

/** How much less the picture must change under a sixth of a turn than under a twelfth for a spin to be kept (1 = no sign of six teeth). */
export const HUB_SYMMETRY = 0.72
/** Teeth must be there at all: a flat patch is "symmetric" too. Mean grey-level change under a twelfth of a turn. */
const HUB_CONTRAST = 6

/** The hub nearest a model's aim, or null. Exported for the test. */
export function findHub(g: Uint8Array | Buffer, N: number, aim: { x: number; y: number; r: number }, any = false): (Shape & { q: number }) | null {
  const ring = new Float32Array(STEPS)
  let best: (Shape & { q: number }) | null = null
  const consider = (h: Shape) => {
    if (h.r < 5 || h.r * h.squash < 4) return
    const sc = hubScore(g, N, h, ring)
    if (sc.twelfth < HUB_CONTRAST) return
    const q = sc.six / sc.twelfth
    if (!best || q < best.q) best = { ...h, q }
  }
  // Coarse: every centre near the aim, a few sizes, round and three degrees of flat at six leans.
  const reach = Math.max(6, aim.r * 0.9), step = Math.max(1.5, aim.r / 7)
  const shapes: { squash: number; tilt: number }[] = [{ squash: 1, tilt: 0 }]
  for (const squash of [0.85, 0.7, 0.55]) for (let d = 0; d < 180; d += 30) shapes.push({ squash, tilt: (d * Math.PI) / 180 })
  for (const k of [0.7, 1, 1.3]) for (const sh of shapes) {
    for (let dy = -reach; dy <= reach; dy += step) for (let dx = -reach; dx <= reach; dx += step) {
      consider({ x: aim.x + dx, y: aim.y + dy, r: aim.r * k, ...sh })
    }
  }
  if (!best) return null
  // Fine: around the best, twice.
  for (let pass = 0; pass < 2; pass++) {
    const b: Shape & { q: number } = best
    const cs = step / (pass === 0 ? 3 : 8), ds = pass === 0 ? 0.05 : 0.025, dt = ((pass === 0 ? 10 : 4) * Math.PI) / 180
    for (const kr of [0.92, 1, 1.08]) for (const sq of [-ds, 0, ds]) for (const tl of [-dt, 0, dt]) {
      const squash = Math.min(1, Math.max(0.45, b.squash + sq))
      for (let iy = -2; iy <= 2; iy++) for (let ix = -2; ix <= 2; ix++) {
        consider({ x: b.x + ix * cs, y: b.y + iy * cs, r: b.r * kr, squash, tilt: b.tilt + tl })
      }
    }
  }
  const found: Shape & { q: number } = best
  if (found.q > HUB_SYMMETRY && !any) return null
  // How far out does the hub go? Ring by ring: the reel reaches as far as the
  // rings still show teeth (they change under a twelfth of a turn and not
  // under a sixth) and stops where the picture no longer survives a sixth of
  // a turn (the label, the stripes). Plain rings beyond the teeth are left
  // out: turning them shows nothing but their grain going round.
  let twelfth = 0
  for (const k of RINGS) { readRing(g, N, found, k, ring); twelfth = Math.max(twelfth, ringScore(ring).twelfth) }
  const limit = Math.max(7, twelfth * 0.45), toothed = Math.max(HUB_CONTRAST * 0.6, twelfth * 0.25)
  let r = found.r * 0.5, bad = 0
  for (let rho = found.r * 0.5; rho <= found.r * 2.4; rho += Math.max(1, found.r * 0.04)) {
    readRing(g, N, { ...found, r: rho }, 1, ring)
    const sc = ringScore(ring)
    if (sc.six > limit) { if (++bad >= 2) break } else { bad = 0; if (sc.twelfth >= toothed) r = rho }
  }
  r *= 1.1
  return { ...found, r }
}

/**
 * Move each spin onto the reel it points at, in the plane the reel lies in,
 * and drop the ones that point at no reel. `cover` is the square cover.
 * Never throws.
 */
export async function refineSpins(cover: Buffer, recipe: MotionRecipe): Promise<MotionRecipe> {
  const asked = recipe.elements.filter(e => e.kind === 'spin').length
  if (!asked) return recipe
  const without = { ...recipe, elements: recipe.elements.filter(e => e.kind !== 'spin') }
  let g: Buffer
  try {
    g = await sharp(cover).rotate().removeAlpha().greyscale().resize(HUB_EDGE, HUB_EDGE, { fit: 'fill' }).blur(1).raw().toBuffer()
  } catch {
    return without
  }
  const N = HUB_EDGE
  const elements: MotionElement[] = []
  let kept = 0
  for (const e of recipe.elements) {
    if (e.kind !== 'spin') { elements.push(e); continue }
    const hub = findHub(g, N, { x: e.at.x * N, y: e.at.y * N, r: e.radius * N })
    if (!hub) continue
    kept++
    const tilt = ((((hub.tilt * 180) / Math.PI) % 180) + 180) % 180
    elements.push({ ...e, at: { x: hub.x / N, y: hub.y / N }, radius: Math.min(0.2, hub.r / N), squash: hub.squash, tilt })
  }
  // A cassette's two reels turn together: one turning beside one standing still reads as a mistake.
  return asked >= 2 && kept < 2 ? without : { ...recipe, elements }
}

export type MotionPlan = {
  recipe: MotionRecipe
  /** The model that wrote it; null when it is the plain plan. */
  model: string | null
}

/**
 * Look at `cover` (the finished square cover, without its title) and plan
 * how it moves. `concept` is what the art director meant the picture to be,
 * when that is known.
 */
export async function writeMotionRecipe(cover: Buffer, concept?: { idea?: string; motion?: string }): Promise<MotionPlan> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return { recipe: templateRecipe(), model: null }
  let image: string
  try {
    image = await forVision(cover, 1280)
  } catch (err) {
    console.error('[cover-motion] cover unreadable:', err instanceof Error ? err.message : err)
    return { recipe: templateRecipe(), model: null }
  }
  const about = [
    concept?.idea ? `What the picture is meant to be: ${concept.idea.slice(0, 300)}` : '',
    concept?.motion ? `The art director's note on movement (written before the picture existed; trust what you see over it): ${concept.motion.slice(0, 400)}` : '',
  ].filter(Boolean).join('\n')
  const content: Anthropic.ContentBlockParam[] = [
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
    { type: 'text', text: `${about ? `${about}\n\n` : ''}This is the cover. Plan how it moves.` },
  ]
  const client = new Anthropic({ apiKey, timeout: 90_000, maxRetries: 1 })
  for (const model of MOTION_MODELS) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: 6000,
        system: MOTION_SYSTEM,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: MOTION_SCHEMA as unknown as Record<string, unknown> } },
        messages: [{ role: 'user', content }],
      })
      if (response.stop_reason !== 'end_turn') {
        console.error(`[cover-motion] ${model} stopped with ${response.stop_reason}`)
        continue
      }
      const text = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join('')
      const recipe = parseMotionRecipe(JSON.parse(text))
      if (recipe) return { recipe: await refineSpins(cover, recipe), model }
      console.error(`[cover-motion] ${model} wrote something that is not a plan`)
    } catch (err) {
      if (err instanceof Anthropic.APIError) console.error(`[cover-motion] ${model} API error:`, err.status, err.message)
      else console.error(`[cover-motion] ${model} failed:`, err instanceof Error ? err.message : err)
    }
  }
  return { recipe: templateRecipe(), model: null }
}
