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
  parseMotionRecipe, templateRecipe, type MotionRecipe,
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

The musician cannot stand anything that looks AI-made or like a stock filter. What works is what a patient camera operator would have caught had this picture been a locked-off shot of a real place: the few things in it that would really move, moving a little.

RULES
1. Motion comes from the picture. Look at what is actually there and move only what would move: sand blows, a screen flickers, lava breathes, water ripples, dust hangs in a beam of light that is already in the picture, a glass surface catches one glint. Never add a thing the picture has no source for: no snow indoors, no embers without fire, no mist in a clear dry photograph, no dust where there is no light to show it.
2. Restraint. One to three elements plus the camera, four at the very most, at low amounts. If you are unsure about an element, leave it out. A nearly still picture with breathing light and grain is better than a busy one.
3. The cassette never wavers and nothing covers it. No shimmer over it. One glint (sweep) across its clear shell is allowed, and only when the light in the picture would make one.
4. The lower-centre of the cover holds the title. Keep it calm: no glow, trace or sweep there.
5. Colours are taken from the picture itself, as hex: the colour of ITS light, ITS sand, ITS sparks. Never pure white unless the light in the picture is white.

COORDINATES
x and y run from 0 to 1 across the square cover, from its top-left corner. An area is {x, y, w, h}. The cover is later extended sideways or up and down to fill a video frame, and an area that reaches the cover's edge continues to the edge of the frame, so give weather and haze the full width or height.
angle is the direction of travel in degrees: 0 moves right, 90 moves down, 180 left, 270 up.
amount runs from 0 to 1. Most things belong between 0.25 and 0.6.

ELEMENTS (kind, and the fields each one reads)
- particles: small things carried through the air. look = dust (motes hanging in light, barely drifting), sand (grains and thin veils blown low over the ground in gusts), snow, rain, embers (sparks rising from fire or lava), bubbles. Reads area, color, amount, angle.
- glow: a light that is already in the picture, made to live. look = breathe (slow swell: lava, a lamp, a window), flicker (unsteady: a screen, a flame, a bad tube) or pulse (a beat about once a second: an indicator light, a heart monitor). Reads at (the centre of the light), radius (how far its light reaches, as a fraction of the cover's width), color, amount. Use one glow per light, at most three.
- shimmer: the picture itself wavering inside an area. look = heat (air over hot ground, a road, a flame) or water (a surface with ripples, a reflection). Reads area, amount. Never over the cassette, never over the title.
- sweep: one soft glint of light crossing an area once per loop, for glass, a bubble, polished metal, the cassette's clear shell. Reads area (fit it closely round the shiny thing), color, amount, angle.
- mist: slow soft haze drifting. Only where the picture already has haze, steam, smoke or fog. Reads area, color, amount, angle.
- trace: a point of light running along a line that is DRAWN in the picture, such as a monitor's pulse line, a neon tube, a wire or a road at night. Reads path (2 to 16 points that follow the line closely, in order), color, amount, laps (how many times it runs per loop, 1 to 3).
For fields an element does not read, send 0, an empty path, "none" or "#000000".

CAMERA
float: a slow hand-held drift, the default. push: a slow breathing push-in, for a picture with one strong centre. sway: side to side, for wide scenes. rise: up and down, for tall subjects. still: locked off, when the elements carry the picture (a screen, a graphic print, a drawing). amount is usually 0.3 to 0.6.

GRAIN
Live film grain. 0.35 to 0.55 for photographs, 0.25 to 0.35 for prints and drawings, 0.15 to 0.3 for clean digital art.

summary: one plain sentence for the musician saying what moves, with no technical words.

EXAMPLES OF GOOD PLANS
- A cassette half-buried in rippled sand, photographed from above in low sun: sand particles across the whole cover blowing the way the shadows fall, one sweep across the cassette's shell, a slow push. Nothing else.
- A chalk drawing of a heart monitor whose green line climbs over the cassette: a trace along that line, a faint green flicker glow over the screen, a red pulse glow on the indicator light, camera still.
- A cassette under a soap-bubble dome in a cave with seams of lava: a breathe glow on each of two lava seams, one sweep across the dome, mist low around the bowl where the picture already has mist, a few embers above the lava, a gentle float.`

async function forVision(image: Buffer, edge: number): Promise<string> {
  const jpeg = await sharp(image).rotate().removeAlpha().resize(edge, edge, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer()
  return jpeg.toString('base64')
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
      if (recipe) return { recipe, model }
      console.error(`[cover-motion] ${model} wrote something that is not a plan`)
    } catch (err) {
      if (err instanceof Anthropic.APIError) console.error(`[cover-motion] ${model} API error:`, err.status, err.message)
      else console.error(`[cover-motion] ${model} failed:`, err instanceof Error ? err.message : err)
    }
  }
  return { recipe: templateRecipe(), model: null }
}
