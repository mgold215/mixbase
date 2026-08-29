// Artwork-generation model registry + prompt "vary" composer.
//
// Extracted from src/app/api/generate-artwork/route.ts so the model-key
// resolution and look composition are pure and unit-testable off the server
// route (scripts/artwork-models-test.mjs). No server-only imports live here —
// keep it that way so the test can import it under Node type-stripping.

// Photorealism-first lineup. flux-ultra runs FLUX 1.1 Pro Ultra in raw mode,
// which is specifically tuned to avoid the over-processed "AI art" look.
//
// The Google slots run the Nano Banana (Gemini image) family — NOT Imagen.
// Google retired every Imagen 4 API endpoint on 2026-08-17
// (imagen-4.0-{generate,ultra-generate,fast-generate}-001), so Replicate's
// google/imagen-4[-ultra] wrappers hard-404 out of Vertex for every caller.
// Nano Banana is Google's own designated replacement, and its instruction
// following (e.g. actually honoring "no text") is the best in this lineup.
// Stale clients that still send 'imagen'/'imagen-ultra' collapse to the
// default via resolveModelKey — no crash, no burned quota.
//
// `satisfies` (not a `Record<string, string>` annotation) keeps the literal keys
// so `keyof typeof MODEL_ENDPOINTS` is the real id union, not `string` — that's
// what lets IMAGE_MODELS and resolveModelKey be checked against the registry at
// compile time instead of only at runtime.
export const MODEL_ENDPOINTS = {
  'flux-ultra': 'https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro-ultra/predictions',
  seedream:     'https://api.replicate.com/v1/models/bytedance/seedream-4/predictions',
  'nano-pro':   'https://api.replicate.com/v1/models/google/nano-banana-pro/predictions',
  recraft:      'https://api.replicate.com/v1/models/recraft-ai/recraft-v3/predictions',
  flux:         'https://api.replicate.com/v1/models/black-forest-labs/flux-2-pro/predictions',
  nano:         'https://api.replicate.com/v1/models/google/nano-banana-2/predictions',
} satisfies Record<string, string>

// The registry's real ids as a literal union. Everything model-keyed downstream
// (the resolver's return type, the UI list) is checked against this.
export type ModelKey = keyof typeof MODEL_ENDPOINTS

export const MODEL_INPUTS = {
  'flux-ultra': (prompt: string) => ({ prompt, aspect_ratio: '1:1', raw: true }),
  seedream:     (prompt: string) => ({ prompt, aspect_ratio: '1:1', size: '2K' }),
  // Minimal inputs for the Nano Banana pair on purpose: Replicate 422s unknown
  // properties, and these three are the documented core schema.
  'nano-pro':   (prompt: string) => ({ prompt, aspect_ratio: '1:1', resolution: '2K', output_format: 'png' }),
  recraft:      (prompt: string) => ({ prompt, size: '1024x1024', style: 'realistic_image' }),
  flux:         (prompt: string) => ({ prompt, aspect_ratio: '1:1', output_format: 'webp', output_quality: 95 }),
  nano:         (prompt: string) => ({ prompt, aspect_ratio: '1:1', output_format: 'png' }),
} satisfies Record<ModelKey, (prompt: string) => Record<string, unknown>>

// Default model when the caller sends nothing (or something unusable).
export const DEFAULT_MODEL: ModelKey = 'flux'

/**
 * Resolve a client-supplied `model` value to a real registry key.
 *
 * Why not just `MODEL_ENDPOINTS[model] ?? MODEL_ENDPOINTS.flux`: a hand-crafted
 * request naming an INHERITED Object.prototype member — `__proto__`,
 * `constructor`, `toString`, `valueOf`, `hasOwnProperty` — makes that lookup
 * resolve to a TRUTHY value (the prototype object / a built-in function), so the
 * `??` fallback never fires. The route would then call `inputFn(prompt)` on a
 * non-function (or `fetch()` a non-URL endpoint) and throw — a 500 that lands
 * AFTER the monthly artwork slot was reserved and is NOT on a refund path, so it
 * silently burns the user's quota. An own-property gate lets only the six real
 * keys through; everything else (crafted names, unknown strings, non-strings)
 * collapses to `flux`, keeping endpoint + input paired and the route crash-free.
 */
export function resolveModelKey(model: unknown): ModelKey {
  return typeof model === 'string' && Object.prototype.hasOwnProperty.call(MODEL_ENDPOINTS, model)
    ? (model as ModelKey)
    : DEFAULT_MODEL
}

// UI-facing model list — the single source for every client model selector
// (the Artwork tab + the collection cover picker) so they can't drift from the
// endpoint/input registry. `satisfies` proves each id is a real ModelKey at
// compile time (a typo or a removed model fails the build); the runtime contract
// test additionally proves the list stays 1:1 with the registry. The first
// entry is the selectors' default — ordered photorealism-first to match.
export const IMAGE_MODELS = [
  { id: 'flux-ultra', label: 'FLUX Ultra Raw' },
  { id: 'seedream',   label: 'Seedream 4' },
  { id: 'nano-pro',   label: 'Nano Banana Pro' },
  { id: 'recraft',    label: 'Recraft V3' },
  { id: 'flux',       label: 'Flux 2 Pro' },
  { id: 'nano',       label: 'Nano Banana 2' },
] satisfies { id: ModelKey; label: string }[]

// Randomized photographic treatment, appended when the client asks to vary the
// look. One pick per axis — vantage × light × weather × mood — so consecutive
// generations of the same subject land on visibly different photographs instead
// of the model's single house style.
export const LOOK_VANTAGE = [
  'shot on 35mm film, Kodak Portra 400, subtle grain',
  'medium format Hasselblad capture, razor-sharp 8k architectural photography',
  'aerial drone photograph from 120 meters',
  'low-angle street-level shot on a 24mm wide lens, dramatic perspective',
  'telephoto compression from a distant rooftop, layered against the skyline',
  'tilt-shift photograph with selective focus',
]
export const LOOK_LIGHT = [
  'golden hour, long shadows and warm sun flare',
  'overcast flat daylight, muted tones',
  'blue hour, sodium streetlights glowing',
  'harsh midday sun, deep black shadows',
  'night scene, neon glow reflecting on wet asphalt',
  'dawn light breaking through low clouds',
]
export const LOOK_WEATHER = [
  'dense fog rolling between structures',
  'light rain, wet reflective surfaces',
  'dust haze in the air',
  'crystal clear air, extreme detail',
  'low storm clouds gathering overhead',
]
// Every look string must stay free of people and text/signage cues — the
// composer runs on ARTWORK, where finalize adds the lockup text later and
// stray humans read as stock photography. The contract test greps these pools.
export const LOOK_MOOD = [
  'ominous looming scale, vast and deserted',
  'dystopian corporate megastructure, uncanny emptiness',
  'abandoned and partially overgrown, nature reclaiming the facade',
  'pristine futuristic campus, sterile and unsettling',
  'brutalist monolith against an empty sky',
]

export function composeLook(): string {
  const pick = (pool: string[]) => pool[Math.floor(Math.random() * pool.length)]
  return [pick(LOOK_VANTAGE), pick(LOOK_LIGHT), pick(LOOK_WEATHER), pick(LOOK_MOOD)].join(', ')
}

// Words that mean the artist ASKED for a person — the no-people guard must
// never fight an explicit request.
const PEOPLE_RE = /\b(people|person|man|men|woman|women|girl|boy|kid|child|children|face|faces|portrait|crowd|figure|figures|silhouette|silhouettes|dancer|dancers|artist|band|dj|singer|musician|model|couple|hand|hands|body)\b/i

/**
 * Hard constraints appended to EVERY generation prompt, after any vary-look.
 *
 * The text clause is unconditional: the title/artist lockup is rendered later
 * by /api/finalize-artwork, so any lettering the model bakes into the pixels
 * is wrong by construction. The people clause applies only when the artist's
 * own prompt doesn't mention anyone — asking for "a portrait of a dancer"
 * must not carry a contradictory "no people" rider.
 */
export function composeConstraints(userPrompt: string): string {
  const parts = ['no text, no lettering, no typography, no logos, no watermarks']
  if (!PEOPLE_RE.test(userPrompt)) parts.push('no people, no human figures')
  return parts.join(', ')
}
