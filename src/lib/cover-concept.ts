// Cover concept — the art direction behind a Cassette Studio cover.
//
// A song title (and, if the artist typed one, their own idea) becomes ONE
// picture idea in which the artist's cassette plays a part, written as a
// brief an image model can draw (cassette-art.ts artPrompt wraps it), plus
// how that picture should move when it is filmed. After the takes are drawn,
// the same art director looks at them next to the real cassette and picks
// the one to use.
//
//   writeCoverConcept   title (+ idea, genre) → { idea, label, scene, motion }
//   judgeTakes          reference photo + takes → which take, whether any is
//                       usable, where the title sits, what to correct
//
// Both are Claude (claude-opus-5-5) when ANTHROPIC_API_KEY is set. Without it,
// or when a call fails or declines, the concept is a template built from the
// artist's own words and a medium picked at random, and the first take is
// used — the one-click flow never stops on either step.
//
// Relative, extension-full imports only: scripts/cassette-art-test.mjs runs
// the template half under Node.

import Anthropic from '@anthropic-ai/sdk'
import sharp from 'sharp'
import { DEFAULT_MOTION } from './scene-brief.ts'
import { MAX_SCENE } from './cassette-art.ts'
import { LETTERING_POSITIONS, type LetteringPosition } from './cassette-studio.ts'

const MODEL = 'claude-opus-5-5'

export type CoverConcept = {
  /** One plain sentence the artist reads: what the picture is. */
  idea: string
  /** The idea in two to five words. */
  label: string
  /** The brief for the image model: medium, setting, the cassette's role, light, palette, finish. */
  scene: string
  /** How the picture moves when it is filmed (motion only). */
  motion: string
  source: 'claude' | 'template' | 'prompt'
}

export type ConceptRequest = {
  title: string
  /** The artist's own idea, if they typed one. */
  idea?: string
  genre?: string | null
  /** Tempo and key, when the song has them: a slow minor song and a fast major one want different pictures. */
  bpm?: number | null
  key?: string | null
  /** Ideas already used on this artist's recent covers: do something else. */
  avoid?: string[]
}

/**
 * Mediums a cover can be made in. The template concept picks one at random;
 * the art director is shown three (so two runs of the same title start from
 * different places) and is free to choose something else entirely.
 */
export const MEDIUMS: string[] = [
  'a Renaissance ceiling fresco: soft plaster colours, clouds and robed figures, warm gold light',
  'a Dutch golden-age still life in oil: near-black background, one window of side light, rich detail',
  'a 1970s science-fiction paperback cover in gouache: airbrushed gradients, vast scale, a low sun',
  'a 35mm night photograph taken with direct flash: hard shadows, saturated film colour',
  'an archival space-mission photograph: deep black sky, hard raking sunlight, fine film grain',
  'a Japanese woodblock print: flat colour, fine black outlines, visible paper fibre',
  'an architectural photograph at blue hour: clean lines, long exposure, one warm light',
  'a macro photograph: shallow focus, dust and droplets visible, soft window light',
  'a cut-paper collage of vintage magazine photographs: visible paper edges and halftone dots',
  'a two-colour risograph print: slightly misregistered inks, coarse paper grain',
  'a large-format landscape photograph at golden hour: enormous scale, crisp detail to the horizon',
  'an underwater photograph: shafts of light from the surface, drifting particles, blue-green depth',
  'a museum photograph: one object under a spotlight in a dark gallery, glass reflections',
  'a stained-glass window: thick lead lines, light pouring through coloured glass onto stone',
  'a Byzantine mosaic of small stone and gold tiles, uneven and hand-set',
  'a surrealist oil painting of a desert: long shadows, impossible scale, a hard clear sky',
  'an infrared film photograph: pale pink foliage, a dark sky, glowing highlights',
  'a stop-motion diorama of handmade sets and props under soft studio light',
  'a hand-coloured botanical engraving on cream paper: fine hatching, delicate washes',
  'an aerial photograph looking straight down: patterns in the land, long shadows',
  'a film still shot on anamorphic lenses: practical neon light, rain, shallow focus',
  'an impressionist oil painting made outdoors: thick visible brushwork, broken colour, moving light',
  'a baroque oil painting: one shaft of light in deep darkness, heavy drapery, dramatic gesture',
  'a double-exposure film photograph: two scenes blended in camera, soft overlaps',
  'a Polaroid photograph: soft faded colour, a sun flare, shallow depth',
  'a tapestry woven in wool: visible threads, muted dyes, flattened perspective',
  'a chalk pastel drawing on dark paper: soft smudged edges, glowing colour',
  'a snow-dusted miniature model photographed with a tilt-shift lens',
]

/** Three different mediums, chosen with `random` (0..1). */
export function pickMediums(random: () => number = Math.random, n = 3): string[] {
  const pool = [...MEDIUMS]
  const out: string[] = []
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(random() * pool.length), 1)[0])
  return out
}

function clean(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : ''
}

/** The concept built from the artist's own words alone (no model). */
export function templateConcept(req: ConceptRequest, random: () => number = Math.random): CoverConcept {
  const title = clean(req.title, 80)
  const idea = clean(req.idea, 400)
  const medium = pickMediums(random, 1)[0]
  const subject = idea || (title ? `a picture that brings the song title "${title}" to life in one clear image` : 'a striking, simple picture with one clear subject')
  const scene = `The medium: ${medium}. The picture: ${subject}. The cassette is the heart of it: large in the frame, tilted a little as if caught mid-motion, lit by the scene's own light, with the setting built around it and a limited palette of three colours.`
  const label = idea ? (idea.length > 40 ? `${idea.slice(0, 38).replace(/\s+\S*$/, '')}…` : idea) : (title || 'Your cover')
  return { idea: idea || `A cover for ${title || 'this song'} as ${medium.split(':')[0]}`, label, scene: scene.slice(0, MAX_SCENE), motion: DEFAULT_MOTION, source: 'template' }
}

/** A concept from an exact scene brief the caller wrote (used as is). */
export function promptConcept(scene: string, title: string): CoverConcept {
  const s = clean(scene, MAX_SCENE)
  return { idea: s.length > 110 ? `${s.slice(0, 108).replace(/\s+\S*$/, '')}…` : s, label: clean(title, 48) || 'Your cover', scene: s, motion: DEFAULT_MOTION, source: 'prompt' }
}

const CONCEPT_SYSTEM = `You are the art director for one musician's record covers. Every cover of theirs stars the same object: the musician's own audio cassette tape, clear plastic with a grey label and red, blue and yellow stripes. That cassette is the brand. Your job is to give each song a cover with one clear IDEA taken from its title, in which the cassette plays a part. The covers you are replacing were all the same lifeless product shot: a cassette standing on a ledge in front of a blurred background. Never write that picture.

How to think:
1. Read the title. What does it evoke: a place, a myth, a time of day, a material, a science, a feeling, a pun? Choose the most visual reading, the one a stranger would get in a second. If the musician gave their own idea, build on it faithfully and make it specific.
2. Give the cassette a ROLE in that picture, not a seat in front of it. It can be the thing every figure in a painting reaches for, a monument in a landscape, an artefact in a museum case, the sun or the moon, a window, a raft, a meteor, a fossil in rock, a fruit on a branch, a stained-glass panel, a kite, an offering on an altar, a building in a skyline. It can be enormous or tiny, tilted, floating, half-buried, falling, glowing, frozen in ice. It must stay whole, recognisable and mostly unobstructed, and there is only ever one.
3. Choose ONE medium and commit to it: a kind of photograph, painting, print or handmade thing, named precisely. Vary it from song to song. A photograph is fine when the idea is strong; a blurred backdrop is not an idea.
4. Compose a square that still reads as a thumbnail: one focal point, strong shapes, real depth, a palette of two to four named colours. Keep the lower-centre of the frame calm, because the handwritten title is added there.

Write:
- idea: what the picture is, in plain words the musician will read. One sentence, at most 110 characters, no quotes.
- label: the idea in two to five words, Title Case.
- scene: the brief for the image model, 80 to 140 words of concrete visual fact in this order: the medium; the setting and what is in it; the cassette's role, where it sits in the frame, its scale and its angle; the light (source, direction, quality); the palette; the finish (grain, brushwork, paper, lens). Say "the cassette", never describe its design (the model is given a photo of it). No abstract praise (stunning, ethereal, cinematic masterpiece), no resolution words, no lists of camera brands. Never ask for text, lettering, logos or a second cassette. No recognisable real people, no brand names.
- motion: two or three short sentences for a video model that will animate this exact picture. MOTION ONLY: one slow camera move (a push-in or a drift, never a cut), the ambient motion that belongs in this scene, and the cassette's two reels turning slowly as if it is playing while the cassette itself holds its place. At most 320 characters.`

const CONCEPT_SCHEMA = {
  type: 'object',
  properties: {
    idea: { type: 'string' },
    label: { type: 'string' },
    scene: { type: 'string' },
    motion: { type: 'string' },
  },
  required: ['idea', 'label', 'scene', 'motion'],
  additionalProperties: false,
} as const

function textOf(response: Anthropic.Message): string {
  return response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join('')
}

/** Write the cover concept for a song (see the top of this file). Never throws. */
export async function writeCoverConcept(req: ConceptRequest, random: () => number = Math.random): Promise<CoverConcept> {
  const fallback = templateConcept(req, random)
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return fallback
  const title = clean(req.title, 80)
  const idea = clean(req.idea, 400)
  const avoid = (req.avoid ?? []).map(a => clean(a, 120)).filter(Boolean).slice(0, 8)
  const brief = [
    `Song title: ${title || '(untitled)'}`,
    idea ? `The musician's own idea for this cover: ${idea}` : 'The musician gave no idea of their own: work from the title.',
    req.genre ? `Genre: ${clean(req.genre, 60)}` : '',
    typeof req.bpm === 'number' && req.bpm > 0 ? `Tempo: ${Math.round(req.bpm)} BPM` : '',
    req.key ? `Key: ${clean(req.key, 24)}` : '',
    `Three mediums to consider first (picked at random; choose another if the title clearly calls for it): ${pickMediums(random).map(m => m.split(':')[0]).join('; ')}.`,
    avoid.length ? `Already used on this musician's recent covers, so do something different: ${avoid.join(' | ')}` : '',
  ].filter(Boolean).join('\n')
  try {
    const client = new Anthropic({ apiKey, timeout: 90_000, maxRetries: 1 })
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 12000,
      system: CONCEPT_SYSTEM,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: CONCEPT_SCHEMA as unknown as Record<string, unknown> } },
      messages: [{ role: 'user', content: brief }],
    })
    if (response.stop_reason !== 'end_turn') return fallback
    const raw = JSON.parse(textOf(response)) as Record<string, unknown>
    const scene = clean(raw.scene, MAX_SCENE)
    if (scene.length < 60) return fallback
    return {
      idea: clean(raw.idea, 160) || fallback.idea,
      label: clean(raw.label, 48) || fallback.label,
      scene,
      motion: clean(raw.motion, 600) || DEFAULT_MOTION,
      source: 'claude',
    }
  } catch (err) {
    if (err instanceof Anthropic.APIError) console.error('[cover-concept] API error:', err.status, err.message)
    else console.error('[cover-concept] failed:', err instanceof Error ? err.message : err)
    return fallback
  }
}

// ── Choosing the take ───────────────────────────────────────────────────────

export type TakeVerdict = {
  /** Index of the take to use. */
  best: number
  /** False when no take shows the real cassette well enough to publish. */
  usable: boolean
  /** Where the handwritten title reads best on the chosen take, or null (decide from the pixels). */
  spot: LetteringPosition | null
  /** What to tell the image model to correct, when nothing was usable. */
  fix: string
  /** One short remark per take, for the logs. */
  notes: string[]
  source: 'claude' | 'first'
}

const JUDGE_SYSTEM = `You are the art director choosing which candidate becomes a musician's record cover. You are shown a studio photo of the musician's real cassette tape, then the candidates. Each candidate was drawn by an image model that was asked to put THAT cassette into a picture.

Judge each candidate on two things, each 0 to 10:
- cassette: is it the same cassette as the photo? Check, in this order: exactly one cassette; a clear colourless plastic shell; a grey label; a white strip across the top of the label with a small black "A" tag at its left end; two white toothed reel hubs behind one dark window; three stripes across the label in the order red, blue, yellow from the top. A different colour scheme, missing or re-ordered stripes, extra writing on the label, a second cassette or a melted, warped shape all score 5 or lower. A tilt, a different angle, the scene's lighting or being painted in the picture's medium are NOT faults.
- picture: is it a strong cover? One clear idea, the cassette doing something in the picture rather than laid on top of it, light and shadow that agree, a composition that reads as a thumbnail, no stray text, letters, logos, watermarks or borders anywhere (the "A" on the cassette is fine), no broken anatomy or smeared detail.

Choose the best candidate: the highest picture score among those whose cassette score is 7 or more. If none reaches 7 on cassette, or every candidate has stray text or a border, say usable is false and write, in fix, one or two plain sentences telling the image model what to correct. Otherwise fix is an empty string.

For the candidate you choose, say where a small two-line handwritten title would read best without covering the cassette or the main subject: bottom-center, bottom-left, bottom-right, top-center, top-left or top-right. Prefer bottom-center whenever it is calm.`

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          cassette: { type: 'integer' },
          picture: { type: 'integer' },
          remark: { type: 'string' },
        },
        required: ['index', 'cassette', 'picture', 'remark'],
        additionalProperties: false,
      },
    },
    best: { type: 'integer' },
    usable: { type: 'boolean' },
    spot: { type: 'string', enum: [...LETTERING_POSITIONS] },
    fix: { type: 'string' },
  },
  required: ['candidates', 'best', 'usable', 'spot', 'fix'],
  additionalProperties: false,
} as const

async function forVision(image: Buffer, edge: number): Promise<string> {
  const jpeg = await sharp(image).rotate().removeAlpha().resize(edge, edge, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer()
  return jpeg.toString('base64')
}

/**
 * Look at the takes next to the real cassette and choose (see the top of
 * this file). With no key, one take, or any failure: the first take, usable,
 * spot undecided. Never throws.
 */
export async function judgeTakes(reference: Buffer, takes: Buffer[], concept: { idea: string }): Promise<TakeVerdict> {
  const first: TakeVerdict = { best: 0, usable: true, spot: null, fix: '', notes: [], source: 'first' }
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey || takes.length === 0) return first
  try {
    const content: Anthropic.ContentBlockParam[] = [
      { type: 'text', text: 'The real cassette (studio photo):' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await forVision(reference, 768) } },
    ]
    for (let i = 0; i < takes.length; i++) {
      content.push({ type: 'text', text: `Candidate ${i}:` })
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await forVision(takes[i], 1024) } })
    }
    content.push({ type: 'text', text: `The idea the picture was meant to show: ${clean(concept.idea, 300) || '(none given)'}\nThere are ${takes.length} candidate${takes.length === 1 ? '' : 's'}, numbered from 0.` })
    const client = new Anthropic({ apiKey, timeout: 120_000, maxRetries: 1 })
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      system: JUDGE_SYSTEM,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: JUDGE_SCHEMA as unknown as Record<string, unknown> } },
      messages: [{ role: 'user', content }],
    })
    if (response.stop_reason !== 'end_turn') return first
    const raw = JSON.parse(textOf(response)) as Record<string, unknown>
    const best = typeof raw.best === 'number' && Number.isInteger(raw.best) && raw.best >= 0 && raw.best < takes.length ? raw.best : 0
    const spot = (LETTERING_POSITIONS as readonly string[]).includes(String(raw.spot)) ? raw.spot as LetteringPosition : null
    const notes = Array.isArray(raw.candidates)
      ? raw.candidates.map(c => {
          const v = c as Record<string, unknown>
          return `#${String(v.index)} cassette ${String(v.cassette)}/10, picture ${String(v.picture)}/10: ${clean(v.remark, 200)}`
        })
      : []
    return { best, usable: raw.usable !== false, spot, fix: clean(raw.fix, 400), notes, source: 'claude' }
  } catch (err) {
    if (err instanceof Anthropic.APIError) console.error('[cover-concept] judge API error:', err.status, err.message)
    else console.error('[cover-concept] judge failed:', err instanceof Error ? err.message : err)
    return first
  }
}
