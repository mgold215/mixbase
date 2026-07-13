// Artwork-generation model registry + prompt "vary" composer.
//
// Extracted from src/app/api/generate-artwork/route.ts so the model-key
// resolution and look composition are pure and unit-testable off the server
// route (scripts/artwork-models-test.mjs). No server-only imports live here —
// keep it that way so the test can import it under Node type-stripping.

// Photorealism-first lineup. flux-ultra runs FLUX 1.1 Pro Ultra in raw mode,
// which is specifically tuned to avoid the over-processed "AI art" look.
export const MODEL_ENDPOINTS: Record<string, string> = {
  'flux-ultra':   'https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro-ultra/predictions',
  seedream:       'https://api.replicate.com/v1/models/bytedance/seedream-4/predictions',
  'imagen-ultra': 'https://api.replicate.com/v1/models/google/imagen-4-ultra/predictions',
  recraft:        'https://api.replicate.com/v1/models/recraft-ai/recraft-v3/predictions',
  flux:           'https://api.replicate.com/v1/models/black-forest-labs/flux-2-pro/predictions',
  imagen:         'https://api.replicate.com/v1/models/google/imagen-4/predictions',
}

export const MODEL_INPUTS: Record<string, (prompt: string) => Record<string, unknown>> = {
  'flux-ultra':   (prompt) => ({ prompt, aspect_ratio: '1:1', raw: true }),
  seedream:       (prompt) => ({ prompt, aspect_ratio: '1:1', size: '2K' }),
  'imagen-ultra': (prompt) => ({ prompt, aspect_ratio: '1:1', safety_filter_level: 'block_only_high' }),
  recraft:        (prompt) => ({ prompt, size: '1024x1024', style: 'realistic_image' }),
  flux:           (prompt) => ({ prompt, aspect_ratio: '1:1', output_format: 'webp', output_quality: 95 }),
  imagen:         (prompt) => ({ prompt, aspect_ratio: '1:1', safety_filter_level: 'block_only_high' }),
}

// Default model when the caller sends nothing (or something unusable).
export const DEFAULT_MODEL = 'flux'

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
export function resolveModelKey(model: unknown): string {
  return typeof model === 'string' && Object.prototype.hasOwnProperty.call(MODEL_ENDPOINTS, model)
    ? model
    : DEFAULT_MODEL
}

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
  'night scene, neon signage reflecting on wet asphalt',
  'dawn light breaking through low clouds',
]
export const LOOK_WEATHER = [
  'dense fog rolling between structures',
  'light rain, wet reflective surfaces',
  'dust haze in the air',
  'crystal clear air, extreme detail',
  'low storm clouds gathering overhead',
]
export const LOOK_MOOD = [
  'ominous looming scale, tiny human figures dwarfed below',
  'dystopian corporate megastructure, uncanny emptiness',
  'abandoned and partially overgrown, nature reclaiming the facade',
  'pristine futuristic campus, sterile and unsettling',
  'brutalist monolith against an empty sky',
]

export function composeLook(): string {
  const pick = (pool: string[]) => pool[Math.floor(Math.random() * pool.length)]
  return [pick(LOOK_VANTAGE), pick(LOOK_LIGHT), pick(LOOK_WEATHER), pick(LOOK_MOOD)].join(', ')
}
