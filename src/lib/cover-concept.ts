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
 * the art director is shown a few (so two runs of the same title start from
 * different places) and is free to choose something else entirely.
 *
 * Rebuilt 2026-11-11 after the owner's verdicts on the first drawn covers
 * ("clear AI look", "very AI and fake looking"): every entry is something a
 * person could really have shot or made by hand, with its limits showing.
 * The ones that invite the generated look (vast sci-fi scenes, surreal
 * scale, glowing infrared, neon film stills, tilt-shift worlds) are gone.
 */
export const MEDIUMS: string[] = [
  'a 35mm colour photograph in plain daylight: natural colour, soft grain, nothing retouched',
  'a 35mm photograph taken at night with on-camera flash: hard shadow, quick dark falloff',
  'a photograph looking straight down at the ground: real texture, long natural shadows',
  'a medium-format still life on a table by a window: soft side light, real worn surfaces',
  'a macro photograph: very shallow focus, dust and fine scratches visible',
  'a Polaroid photograph: soft faded colour, slightly careless framing',
  'a black-and-white documentary photograph: available light, visible grain',
  'a flatbed scan of real objects laid on the glass: flat hard light, dust specks, a black surround',
  'a museum catalogue photograph: one object on a plain backdrop with a soft shadow',
  'an underwater photograph in shallow water: rippling light on the floor, a slight blue cast',
  'a night photograph lit by one streetlamp or one bare bulb: deep shadow, a single warm pool of light',
  'a photograph of an old screen in a dark room: scan lines, phosphor colour, a little moire',
  'a chalk pastel drawing on black paper: smudged edges, few colours, the paper tooth showing',
  'a two-colour risograph print: slightly misregistered inks, coarse paper grain',
  'a linocut print in one or two inks: carved marks, uneven ink coverage',
  'a cut-paper collage of old magazine photographs: visible paper edges and halftone dots',
  'a cyanotype print: Prussian blue and white, brush-marked edges',
  'a photocopied collage: harsh black and white, toner speckle, torn edges',
  'a gouache painting on paper: flat shapes, visible brush marks, a limited palette',
  'a pencil and watercolour field sketch on cream paper: loose line, uneven washes',
  'a hand-coloured scientific engraving on cream paper: fine hatching, delicate washes',
  'a Japanese woodblock print: flat colour, fine black outlines, visible paper fibre',
  'an oil still life: a plain table, a near-black background, one window of side light',
  'a faded fresco on cracked plaster: soft chalky colour, missing patches',
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
  const scene = `The medium: ${medium}. The picture: ${subject}. The cassette is the heart of it: its real size, resting in the scene rather than floating over it, lit by the scene's one plain light, with two or three other elements at most and a muted palette of three colours.`
  const label = idea ? (idea.length > 40 ? `${idea.slice(0, 38).replace(/\s+\S*$/, '')}…` : idea) : (title || 'Your cover')
  return { idea: idea || `A cover for ${title || 'this song'} as ${medium.split(':')[0]}`, label, scene: scene.slice(0, MAX_SCENE), motion: DEFAULT_MOTION, source: 'template' }
}

/** A concept from an exact scene brief the caller wrote (used as is). */
export function promptConcept(scene: string, title: string): CoverConcept {
  const s = clean(scene, MAX_SCENE)
  return { idea: s.length > 110 ? `${s.slice(0, 108).replace(/\s+\S*$/, '')}…` : s, label: clean(title, 48) || 'Your cover', scene: s, motion: DEFAULT_MOTION, source: 'prompt' }
}

/**
 * What the owner said about the first drawn covers (2026-11-11), in the
 * words both the art director and the critic are given. This is the line
 * the whole pipeline is tuned to; change it only on a new verdict of theirs.
 */
export const OWNER_VERDICTS = `- APPROVED: the cassette half-buried in real sand, photographed from above in plain late sun, wind ripples spreading out from it like echoes. A real thing at its real size in a real place: someone could go and shoot it.
- APPROVED: a chalk pastel drawing of an old hospital monitor whose green pulse line climbs over the cassette as its spike. One graphic idea, few elements, mostly dark, visibly drawn by hand.
- LIKED, WITH RESERVATIONS: an old-master painting of gods at a feast lunging for the cassette. A strong idea, but a crowd of painted figures is where a generated picture gives itself away.
- REJECTED as "very AI and fake looking": a cassette the size of an office tower standing in a city skyline at golden hour. Impossible scale pasted into a glossy photograph.
- REJECTED as "clear AI look": the cassette among purple nightshade flowers under a huge glowing moon. Stock fantasy decoration: a moon, a glow, a purple haze.`

const CONCEPT_SYSTEM = `You are the art director for one musician's record covers. Every cover stars the same real object: the musician's own audio cassette tape, clear plastic with a grey label and red, blue and yellow stripes. That cassette is the brand. Each song gets a cover with one clear IDEA taken from its title, in which the cassette plays a part.

The pictures are drawn by an image model, and the one thing they must never do is look like it. The musician: "it can't obviously look like AI. We're walking a thin line here." A cover that reads as AI art in the first second has failed, however clever its idea. Their verdicts so far, which draw the line:
${OWNER_VERDICTS}

The rules that follow from them:
1. PLAUSIBLE. Write a picture a person could really have made. Best of all a photograph of the actual cassette at its actual size (about 10 cm wide), placed or found somewhere real and specific, staged the way a photographer with one prop could stage it. Or a physical handmade piece (a print, a drawing, a collage) with the limits of its medium showing. The idea comes from WHERE the cassette is and WHAT has happened to it there, never from magic.
2. NEVER: a giant cassette or a miniature world (the cassette as a building, monument, sun, moon, island, vehicle); a floating, flying, glowing, melting or exploding cassette; moons, planets, galaxies, auroras; neon; mist, haze or shafts of light; anything that glows; purple-and-teal or orange-and-teal colour; golden-hour skylines; wet reflective streets; crystals, butterflies, feathers, roses, smoke; vast epic landscapes; crowds of figures, or faces and hands close up; a centred, symmetrical, spotlit hero shot; anything you would call dreamlike, ethereal, surreal, cinematic or epic.
3. RESTRAINT. One idea, two or three elements, plenty of quiet space. Ordinary light from a named real source: an overcast window, noon sun, one bare bulb, an on-camera flash. Colour that belongs to the place, a little muted. Imperfection is welcome: dust, wear, an uneven edge, a frame that is slightly off-centre. The cassette may be small in the frame when the picture leads the eye to it.
4. Read the title for a concrete, physical reading: a place, a material, a kind of weather, an object, a trace something leaves behind, a quiet visual pun a stranger gets in a second. If the musician gave their own idea, build on it faithfully and bring it inside these rules.
5. The cassette stays whole, recognisable and mostly unobstructed, and there is only ever one. Never the old product shot either: a cassette standing on a ledge in front of a blurred background. Keep the lower-centre of the square calm, because the handwritten title is added there.

You will be asked for a number of ideas. Make each a different reading of the title, in a different place and a different medium, so the musician has a real choice. Draft more than you need and throw away every one a designer would call AI art at a glance.

For each idea write:
- idea: what the picture is, in plain words the musician will read before paying for it. One sentence, at most 110 characters, no quotes.
- label: the idea in two to five words, Title Case.
- scene: the brief for the image model, 80 to 140 words of concrete visual fact in this order: the medium, named as the real thing it is; the place and what is in it; where the cassette is, what has happened to it, where it sits in the frame and how large; the light (its real source, direction, quality); the colours; the finish (grain, paper, lens, wear). Say "the cassette", never describe its design (the model is given a photo of it). No praise words (stunning, ethereal, cinematic, masterpiece), no resolution words, no camera brands. Never ask for text, lettering, logos or a second cassette. No recognisable real people, no brand names.
- motion: two or three short sentences for a video model that will animate this exact picture. MOTION ONLY: one slow camera move (a push-in or a drift, never a cut), the small natural motion that belongs in this place, and the cassette's two reels turning slowly as if it is playing while the cassette itself holds its place. At most 320 characters.`

const CONCEPT_ITEM = {
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

const IDEAS_SCHEMA = {
  type: 'object',
  properties: { ideas: { type: 'array', items: CONCEPT_ITEM } },
  required: ['ideas'],
  additionalProperties: false,
} as const

function textOf(response: Anthropic.Message): string {
  return response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join('')
}

/** Most ideas one call may be asked for. */
export const MAX_IDEAS = 4

/**
 * A concept the caller hands back (the artist picked one of the ideas they
 * were shown): the same fields, trimmed to the same limits. Null when it is
 * not one.
 */
export function parseConcept(v: unknown): CoverConcept | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const scene = clean(o.scene, MAX_SCENE)
  const idea = clean(o.idea, 160)
  if (scene.length < 60 || !idea) return null
  return { idea, label: clean(o.label, 48) || idea.slice(0, 48), scene, motion: clean(o.motion, 600) || DEFAULT_MOTION, source: 'claude' }
}

/**
 * `count` different ideas for a song's cover, for the artist to choose from
 * before anything is drawn (an idea costs about a cent; a cover costs forty).
 * Without a key, or when the call fails, they are template concepts in
 * different mediums. `instructions` replaces the art director's standing
 * instructions (tuning only). Never throws, never returns fewer than one.
 */
export async function writeCoverIdeas(
  req: ConceptRequest, count = 3, random: () => number = Math.random, instructions?: string,
): Promise<CoverConcept[]> {
  const n = Math.max(1, Math.min(MAX_IDEAS, Math.round(count)))
  const fallback = (): CoverConcept[] => {
    const out: CoverConcept[] = []
    const seen = new Set<string>()
    for (let guard = 0; out.length < n && guard < 40; guard++) {
      const c = templateConcept(req, random)
      if (seen.has(c.scene)) continue
      seen.add(c.scene)
      out.push(c)
    }
    return out.length ? out : [templateConcept(req, random)]
  }
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return fallback()
  const title = clean(req.title, 80)
  const idea = clean(req.idea, 400)
  const avoid = (req.avoid ?? []).map(a => clean(a, 120)).filter(Boolean).slice(0, 12)
  const brief = [
    `Song title: ${title || '(untitled)'}`,
    idea ? `The musician's own idea for this cover: ${idea}` : 'The musician gave no idea of their own: work from the title.',
    req.genre ? `Genre: ${clean(req.genre, 60)}` : '',
    typeof req.bpm === 'number' && req.bpm > 0 ? `Tempo: ${Math.round(req.bpm)} BPM` : '',
    req.key ? `Key: ${clean(req.key, 24)}` : '',
    `Mediums to consider first (picked at random; choose others if the title calls for it): ${pickMediums(random, Math.max(4, n + 2)).map(m => m.split(':')[0]).join('; ')}.`,
    avoid.length ? `Already used or already shown to this musician, so do something different: ${avoid.join(' | ')}` : '',
    `Give exactly ${n} idea${n === 1 ? '' : 's'}.`,
  ].filter(Boolean).join('\n')
  try {
    const client = new Anthropic({ apiKey, timeout: 100_000, maxRetries: 1 })
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: instructions?.trim() || CONCEPT_SYSTEM,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: IDEAS_SCHEMA as unknown as Record<string, unknown> } },
      messages: [{ role: 'user', content: brief }],
    })
    if (response.stop_reason !== 'end_turn') return fallback()
    const raw = JSON.parse(textOf(response)) as { ideas?: unknown }
    const ideas = (Array.isArray(raw.ideas) ? raw.ideas : []).map(parseConcept).filter((c): c is CoverConcept => c !== null).slice(0, n)
    return ideas.length ? ideas : fallback()
  } catch (err) {
    if (err instanceof Anthropic.APIError) console.error('[cover-concept] API error:', err.status, err.message)
    else console.error('[cover-concept] failed:', err instanceof Error ? err.message : err)
    return fallback()
  }
}

/** One concept for a song (the first of writeCoverIdeas). Never throws. */
export async function writeCoverConcept(req: ConceptRequest, random: () => number = Math.random): Promise<CoverConcept> {
  return (await writeCoverIdeas(req, 1, random))[0]
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
  /** Each take's marks by index (empty when nothing was judged). */
  scores: { cassette: number; picture: number }[]
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
  const first: TakeVerdict = { best: 0, usable: true, spot: null, fix: '', notes: [], scores: [], source: 'first' }
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
    const scores = takes.map(() => ({ cassette: 0, picture: 0 }))
    if (Array.isArray(raw.candidates)) {
      for (const c of raw.candidates) {
        const v = c as Record<string, unknown>
        const i = typeof v.index === 'number' ? v.index : -1
        if (Number.isInteger(i) && i >= 0 && i < scores.length) scores[i] = { cassette: mark(v.cassette), picture: mark(v.picture) }
      }
    }
    return { best, usable: raw.usable !== false, spot, fix: clean(raw.fix, 400), notes, scores, source: 'claude' }
  } catch (err) {
    if (err instanceof Anthropic.APIError) console.error('[cover-concept] judge API error:', err.status, err.message)
    else console.error('[cover-concept] judge failed:', err instanceof Error ? err.message : err)
    return first
  }
}


function mark(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(10, Math.round(v))) : 0
}

// ── Does it look AI-made? ───────────────────────────────────────────────────
// The second pair of eyes (2026-11-11, the owner: "there needs to be some
// kind of anti-slop agent that ensures it doesn't obviously look like AI").
// It sees only the candidates, knows nothing of the idea or the cassette's
// design, and answers one question about each.

export type TakeCritique = {
  /** 0–10: how far the picture passes for something a person shot or made by hand. */
  real: number
  /** What gives it away, in a few words ('' when nothing does). */
  tells: string
  /** What to tell the image model so the next attempt stops looking generated. */
  fix: string
}

/** A take must reach this on `real` to be published without a redraw. */
export const REAL_PASS = 7
/** ...and this on the judge's `cassette` mark. */
export const CASSETTE_PASS = 7

const CRITIC_SYSTEM = `You are the last check before a picture becomes a musician's record cover. The candidates were drawn by an image model. The musician rejects any cover that obviously looks AI-generated, so you answer one question about each candidate and nothing else: how much does it LOOK generated, to a design-literate person who sees it first as a small thumbnail and then up close?

Give each candidate a mark called real, from 0 to 10:
10 = I would assume a person photographed this or made it by hand.
7 = believable; nothing gives it away at a glance, and only small things up close.
5 = I would suspect it.
3 = obviously generated.
0 = a cliche of AI art.

What gives a picture away (each lowers the mark):
- Impossible or theatrical content shown as if photographed: an everyday object at an impossible size, objects that float or glow, weather and light arranged for drama.
- The stock generated mood: glow, bloom, haze, shafts of light, neon, purple-and-teal or orange-and-teal colour, a saturated golden hour, everything crisp and high-contrast at once.
- Surfaces: waxy or airbrushed smoothness; every part equally sharp and equally detailed; texture that looks painted on; objects too clean and new, with no dust, wear or handling.
- Composition: a perfectly centred, symmetrical, spotlit hero object; decoration added for prettiness (a moon, flowers, sparkles, drifting particles, a halo).
- Faults on inspection: warped geometry, melted small parts, nonsense marks, wrong hands or faces, shadows and reflections that disagree with the light.
- A handmade medium that is too perfect: brush, pencil or paper texture laid on evenly like a filter, impossible precision, no real edge to the sheet.
What does NOT lower the mark: an unusual idea, a dark or plain picture, grain, blur, a small subject, an off-centre frame, a medium whose texture behaves like the real thing.

This musician's own verdicts, to calibrate against:
${OWNER_VERDICTS}
Mark those roughly 9, 8, 6, 2 and 4.

For each candidate also write:
- tells: the two or three specific things in THIS picture that most give it away, at most 160 characters. An empty string if nothing does.
- fix: when real is below 7, one sentence telling the image model what to change so the picture stops looking generated (for example: put the cassette at its real size on the ground instead of towering over the buildings; take out the moon and the glow and light it with one plain window). Otherwise an empty string.`

const CRITIC_SCHEMA = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          real: { type: 'integer' },
          tells: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['index', 'real', 'tells', 'fix'],
        additionalProperties: false,
      },
    },
  },
  required: ['candidates'],
  additionalProperties: false,
} as const

/**
 * How AI-made each picture looks (see above), one entry per picture in
 * order. Null when there is no key or the call fails: the caller then goes
 * on without this check. `instructions` replaces the critic's standing
 * instructions (tuning only). Never throws.
 */
export async function critiqueTakes(takes: Buffer[], instructions?: string): Promise<TakeCritique[] | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey || takes.length === 0) return null
  try {
    const content: Anthropic.ContentBlockParam[] = []
    for (let i = 0; i < takes.length; i++) {
      content.push({ type: 'text', text: `Candidate ${i}:` })
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await forVision(takes[i], 1280) } })
    }
    content.push({ type: 'text', text: `There ${takes.length === 1 ? 'is 1 candidate' : `are ${takes.length} candidates`}, numbered from 0. Mark every one.` })
    const client = new Anthropic({ apiKey, timeout: 120_000, maxRetries: 1 })
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      system: instructions?.trim() || CRITIC_SYSTEM,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: CRITIC_SCHEMA as unknown as Record<string, unknown> } },
      messages: [{ role: 'user', content }],
    })
    if (response.stop_reason !== 'end_turn') return null
    const raw = JSON.parse(textOf(response)) as { candidates?: unknown }
    if (!Array.isArray(raw.candidates)) return null
    const out: (TakeCritique | null)[] = takes.map(() => null)
    for (const c of raw.candidates) {
      const v = c as Record<string, unknown>
      const i = typeof v.index === 'number' ? v.index : -1
      if (Number.isInteger(i) && i >= 0 && i < out.length) out[i] = { real: mark(v.real), tells: clean(v.tells, 200), fix: clean(v.fix, 300) }
    }
    return out.every(c => c !== null) ? out as TakeCritique[] : null
  } catch (err) {
    if (err instanceof Anthropic.APIError) console.error('[cover-concept] critic API error:', err.status, err.message)
    else console.error('[cover-concept] critic failed:', err instanceof Error ? err.message : err)
    return null
  }
}

export type TakeChoice = {
  best: number
  /** The chosen take shows the real cassette well enough. */
  cassetteOk: boolean
  /** The chosen take passes for something a person made. */
  realOk: boolean
  /** What to tell the image model on a redraw ('' when both are fine). */
  fix: string
}

/**
 * Which take becomes the cover, from the judge's marks (is it the cassette,
 * is it a cover) and the critic's (does it look AI-made). A take has to pass
 * both to be chosen outright; among those the best picture that looks most
 * real wins. If none passes both, the right cassette that looks most real is
 * the pick and the choice says what failed, so the caller can redraw once.
 * A check that did not run counts as passed. Pure.
 */
export function chooseTake(count: number, verdict: TakeVerdict, critique: TakeCritique[] | null): TakeChoice {
  const n = Math.max(1, count)
  const judged = verdict.scores.length === n
  const cassette = (i: number) => (judged ? verdict.scores[i].cassette : 10)
  const picture = (i: number) => (judged ? verdict.scores[i].picture : i === verdict.best ? 10 : 5)
  const real = (i: number) => (critique && critique.length === n ? critique[i].real : 10)
  const all = Array.from({ length: n }, (_, i) => i)
  const top = (ids: number[], score: (i: number) => number) => ids.reduce((a, b) => (score(b) > score(a) ? b : a))
  const right = all.filter(i => cassette(i) >= CASSETTE_PASS && (judged || verdict.usable))
  const both = right.filter(i => real(i) >= REAL_PASS)
  if (both.length) return { best: top(both, i => picture(i) + real(i)), cassetteOk: true, realOk: true, fix: '' }
  if (right.length) {
    const best = top(right, i => real(i) * 2 + picture(i))
    return { best, cassetteOk: true, realOk: false, fix: critique?.[best]?.fix || 'Make it look like a real photograph or a real handmade piece: plain natural light, the cassette at its real size, no glow, no haze, no added decoration.' }
  }
  const best = Math.min(Math.max(0, verdict.best), n - 1)
  const looks = real(best) >= REAL_PASS
  return { best, cassetteOk: false, realOk: looks, fix: [verdict.fix, looks ? '' : critique?.[best]?.fix ?? ''].filter(Boolean).join(' ') }
}
