// Cassette Studio — the ART ENGINE: covers with an idea, not a product shot.
//
// The first engine (cassette-studio.ts) pastes the artist's real cassette
// photo, untouched, into a scene painted around it. That keeps every pixel of
// the cassette real, and it is exactly why those covers all look the same:
// one frontal, upright cassette on a ledge, lit by the light it was
// photographed in, in front of a blurred backdrop. A cassette that cannot
// turn, float, catch the scene's light or be painted in the scene's medium
// can only ever be laid on top of a picture.
//
// This engine hands an image model the artist's cassette as a REFERENCE
// PHOTO and asks for the whole picture at once: the cassette redrawn inside
// the idea — tilted in a fresco, half-buried in a dune, hanging in a window —
// lit by that picture's light, in that picture's medium. The cassette is
// re-rendered, so each take is checked against the real one (cover-concept.ts
// judgeTakes) and the classic engine stays one fold away for a cover whose
// cassette must be the photographed pixels.
//
//   reference   the cut-out cassette on a plain studio backdrop (buildReference)
//   prompt      the cassette's identity, then the concept, then the rules
//               that keep it a cover (artPrompt)
//   takes       several candidates from the best available model
//               (ART_MODELS, tried in order — cassette-server.ts generateTakes),
//               kept in the studio folder as take-<projectId>-<run>-<i>.jpg
//   cover       the chosen take at 3000×3000 with one fine grain pass
//               (finishTake), lettered like any other cover
//
// Pure image maths plus sharp, relative imports only — the model calls live
// in cassette-server.ts. scripts/cassette-art-test.mjs drives this under Node.

import sharp from 'sharp'
import { applyFilmFinish } from './film-finish.ts'
import { COVER, studioPrefix } from './cassette-studio.ts'

// ── Takes ───────────────────────────────────────────────────────────────────

/** Edge a take is asked for at (the largest square the first model draws natively). */
export const TAKE_SIZE = 2048
/** Takes per run: enough to choose from, few enough to stay cheap. */
export const DEFAULT_TAKES = 3
export const MAX_TAKES = 4

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const TAKE_LEAF = new RegExp(`^take-(${UUID})-(\\d{10,16})-([0-9])\\.jpg$`)

/** studio/<userId>/take-<projectId>-<run>-<i>.jpg — candidate i of one run for one song. */
export const takeKey = (userId: string, projectId: string, run: string | number, index: number) =>
  `${studioPrefix(userId)}take-${projectId}-${run}-${index}.jpg`

/** Parse one of THIS user's take keys (the prefix pins the owner, the leaf the shape), or null. */
export function parseTakeKey(key: unknown, userId: string): { projectId: string; run: string; index: number } | null {
  if (typeof key !== 'string') return null
  const prefix = studioPrefix(userId)
  if (!key.startsWith(prefix)) return null
  const m = TAKE_LEAF.exec(key.slice(prefix.length))
  return m ? { projectId: m[1], run: m[2], index: Number(m[3]) } : null
}

// ── Models ──────────────────────────────────────────────────────────────────

export type ArtModelId = 'gpt-image-2' | 'nano-banana-pro' | 'flux-2-max'

export type ArtModel = {
  id: ArtModelId
  /** Replicate model slug. */
  slug: string
  label: string
  /** How many images one call can return (the rest are separate calls). */
  perCall: number
  /** Minutes a call may run before it is given up on. */
  budgetMin: number
}

/**
 * Reference-conditioned image models, best first. The first is the model the
 * owner's reference cover was made with (it keeps the cassette's design and
 * follows a long art-direction brief); the others are what still draws a
 * cover if it is unavailable or refuses a prompt.
 */
export const ART_MODELS: ArtModel[] = [
  { id: 'gpt-image-2', slug: 'openai/gpt-image-2', label: 'GPT Image 2', perCall: MAX_TAKES, budgetMin: 7 },
  { id: 'nano-banana-pro', slug: 'google/nano-banana-pro', label: 'Nano Banana Pro', perCall: 1, budgetMin: 4 },
  { id: 'flux-2-max', slug: 'black-forest-labs/flux-2-max', label: 'FLUX.2 max', perCall: 1, budgetMin: 4 },
]

export function isArtModelId(v: unknown): v is ArtModelId {
  return typeof v === 'string' && ART_MODELS.some(m => m.id === v)
}

/**
 * The inputs for one call to `model`, richest first: Replicate rejects an
 * input it does not know with a 422, and the runner then tries the next
 * (plainer) shape, so a renamed option never costs the cover.
 */
export function artModelInputs(model: ArtModelId, prompt: string, referenceUrl: string, count: number): Record<string, unknown>[] {
  if (model === 'gpt-image-2') {
    const n = Math.max(1, Math.min(MAX_TAKES, Math.round(count)))
    const core = { prompt, input_images: [referenceUrl], number_of_images: n }
    return [
      { ...core, aspect_ratio: `${TAKE_SIZE}x${TAKE_SIZE}`, quality: 'high', output_format: 'jpeg', output_compression: 95, background: 'opaque', moderation: 'auto' },
      { ...core, aspect_ratio: '1:1', quality: 'high', output_format: 'jpeg' },
      { ...core, aspect_ratio: '1:1' },
    ]
  }
  if (model === 'nano-banana-pro') {
    const core = { prompt, image_input: [referenceUrl], aspect_ratio: '1:1' }
    return [{ ...core, resolution: '2K', output_format: 'jpg', safety_filter_level: 'block_only_high' }, core]
  }
  const core = { prompt, input_images: [referenceUrl], aspect_ratio: '1:1' }
  return [{ ...core, resolution: '4 MP', output_format: 'jpg', output_quality: 95, safety_tolerance: 2 }, core]
}

// ── Reference ───────────────────────────────────────────────────────────────

/**
 * The cassette as the image model sees it: the cut-out, upright and centred
 * with air around it, on a plain light studio backdrop with a soft contact
 * shadow. A neutral backdrop matters twice: the clear shell reads as clear
 * (the grey shows through it), and nothing else in the photo can leak into
 * the cover. Returns a JPEG (1536×1152).
 */
export async function buildReference(subject: Buffer): Promise<Buffer> {
  const W = 1536, H = 1152
  const meta = await sharp(subject).metadata()
  const sw = meta.width ?? 1, sh = meta.height ?? 1
  let cw = Math.round(W * 0.7)
  let ch = Math.round(cw * (sh / sw))
  if (ch > H * 0.74) { ch = Math.round(H * 0.74); cw = Math.round(ch * (sw / sh)) }
  const left = Math.round((W - cw) / 2), top = Math.round((H - ch) / 2)
  const cassette = await sharp(subject).ensureAlpha().resize(cw, ch, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer()

  // Backdrop: a soft top-to-bottom studio gradient, a touch darker at the floor.
  const bg = Buffer.alloc(W * H * 3)
  for (let y = 0; y < H; y++) {
    const t = y / (H - 1)
    const v = Math.round(232 - 26 * t * t)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3
      bg[i] = v; bg[i + 1] = v; bg[i + 2] = Math.min(255, v + 1)
    }
  }
  // Contact shadow: a wide soft ellipse just under the cassette's bottom edge
  // (rendered, then blurred in its own pass: sharp composites after it blurs).
  const shadowW = Math.round(cw * 1.02), shadowH = Math.max(8, Math.round(ch * 0.07))
  const ellipse = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><ellipse cx="${W / 2}" cy="${top + ch + shadowH * 0.1}" rx="${shadowW / 2}" ry="${shadowH / 2}" fill="rgba(20,20,24,0.42)"/></svg>`,
  )
  const shadow = await sharp(ellipse).blur(Math.max(6, Math.round(ch * 0.045))).png().toBuffer()
  return sharp(bg, { raw: { width: W, height: H, channels: 3 } })
    .composite([{ input: shadow, left: 0, top: 0 }, { input: cassette, left, top }])
    .jpeg({ quality: 93, chromaSubsampling: '4:4:4' })
    .toBuffer()
}

// ── Prompt ──────────────────────────────────────────────────────────────────

/** Longest scene brief accepted (characters). */
export const MAX_SCENE = 1600

/**
 * What the cassette is, in words — the reference photo carries the detail,
 * this names what must not drift (the parts models most often restyle).
 */
export const CASSETTE_IDENTITY =
  'Image 1 is a studio photo of a real object: the musician\'s own audio cassette tape. Draw THIS exact cassette in the new picture. ' +
  'It has a clear, colourless transparent plastic shell with visible screws and moulded ridges; a grey paper label with a white write-on strip across the top that carries two thin ruled lines and a small black square tag with a white letter "A" at its left end; ' +
  'two white toothed reel hubs behind one dark window in the middle; and three horizontal stripes running across the label through the window\'s height: red on top, then blue, then yellow. ' +
  'Keep its design, proportions, colours and details exactly as in the photo. Never restyle it into a different cassette, never write anything on its label, and show exactly one cassette.'

const ART_RULES = [
  'The cassette belongs to the picture: lit by this scene\'s own light from the same direction as everything else, with the shadows, reflections, depth and focus that light would give it, and rendered in the same medium as the rest of the image. Its shell is clear plastic, so whatever is behind it shows faintly through the transparent parts.',
  'Compose it as a square album cover that still reads when it is tiny: one clear focal point, strong shapes, real depth. Keep the lower-centre of the frame calm and free of important detail (the title is added there afterwards).',
  'No text, letters, numbers, captions, signatures, logos, watermarks, frames or borders anywhere in the image, apart from the small "A" on the cassette\'s label.',
]

/** The full prompt for a take: the cassette's identity, the scene brief, the rules. */
export function artPrompt(scene: string): string {
  const s = scene.trim().replace(/\s+/g, ' ').slice(0, MAX_SCENE).replace(/[\s.]+$/, '')
  return [CASSETTE_IDENTITY, `Create a square album cover artwork. ${s}.`, ...ART_RULES].join('\n\n')
}

// ── Finish ──────────────────────────────────────────────────────────────────

/**
 * A take as the clean cover (artwork_url): exactly 3000×3000, a gentle
 * resharpen after the upscale, and one fine grain pass so a painted or
 * rendered picture and a photographed one share the same surface. No
 * vignette or colour shift — the take's own light and palette are the art
 * direction. Returns JPEG.
 */
export async function finishTake(take: Buffer, seed: number): Promise<Buffer> {
  const sized = await sharp(take)
    .rotate()
    .removeAlpha()
    .resize(COVER, COVER, { fit: 'cover', position: 'centre', kernel: 'lanczos3' })
    .sharpen({ sigma: 0.8, m1: 0.6, m2: 1.2 })
    .jpeg({ quality: 97, chromaSubsampling: '4:4:4' })
    .toBuffer()
  return applyFilmFinish(sized, { seed, grain: 0.3, vignette: 0, saturation: 1, quality: 93 })
}

/** A take as stored: sRGB JPEG at its native size (never enlarged), EXIF rotation baked in. */
export async function storeTake(take: Buffer): Promise<Buffer> {
  return sharp(take).rotate().removeAlpha().jpeg({ quality: 93, chromaSubsampling: '4:4:4' }).toBuffer()
}
