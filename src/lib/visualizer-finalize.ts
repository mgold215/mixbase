// Pure validation helpers for /api/visualizer/finalize — the JSON endpoint
// that indexes a clip the browser already PUT directly into mf-video via a
// signed URL (bytes never traverse Railway; see upload-audio-architecture).
// Kept DOM/IO-free so scripts/viz-finalize-test.mjs can exercise every rule in
// Node (relative .ts imports, same pattern as the other Node-tested libs).

import { validateRecipe } from './fx/recipe.ts'
import type { VizRecipe } from './fx/types.ts'

// A finalize claim must be an object the CALLER's project owns by
// construction: the key's first segment is the projectId (checked against the
// authenticated owner by the route), the basename is the viz-<stamp> shape the
// clients generate, and the extension decides the pipeline (mp4 = validate +
// index; webm = server transcode like /api/visualizer/save always did).
// Anything else — traversal, foreign prefixes, exotic extensions — is rejected.
export function parseVizStoragePath(
  projectId: string,
  storagePath: unknown,
): { ext: 'mp4' | 'webm' } | null {
  if (typeof storagePath !== 'string' || storagePath.length > 200) return null
  const m = /^([0-9a-f-]{36})\/viz-[A-Za-z0-9_-]{1,64}\.(mp4|webm)$/.exec(storagePath)
  if (!m || m[1] !== projectId) return null
  return { ext: m[2] as 'mp4' | 'webm' }
}

// Recipe payloads re-enter through the same validator the editor uses: the
// stored value is always a canonical, clamped VizRecipe or nothing. The route
// never fails a save over a bad recipe — a clip without its recipe is still a
// saved clip.
export function sanitizeSettings(raw: unknown): VizRecipe | null {
  if (raw === undefined || raw === null) return null
  try {
    return validateRecipe(raw)
  } catch {
    return null
  }
}

// Upper bound on a finalized clip. 4K 30s at ~40 Mbps is ~150 MB; anything
// bigger than 200 MB in this bucket path is a mistake or abuse. (The webm
// fallback records at ≤ ~12 Mbps, so it gets a tighter cap.)
export const MAX_FINALIZE_BYTES = 200 * 1024 * 1024
export const MAX_FINALIZE_WEBM_BYTES = 80 * 1024 * 1024

// finalize-video rejects clips under 0.5 s; catching it here keeps garbage out
// of the library instead of surfacing later as a confusing render failure.
export const MIN_CLIP_SECONDS = 0.5

// How much of the head of an MP4 we fetch for validation. Both client encoders
// write faststart MP4s (moov before mdat), so the metadata lives in the first
// couple of MB regardless of file size.
export const MP4_PROBE_BYTES = 2 * 1024 * 1024
