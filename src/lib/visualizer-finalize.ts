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
export const VIZ_KEY_RE = /^([0-9a-f-]{36})\/viz-[A-Za-z0-9_-]{1,64}\.(mp4|webm)$/

export function parseVizStoragePath(
  projectId: string,
  storagePath: unknown,
): { ext: 'mp4' | 'webm' } | null {
  if (typeof storagePath !== 'string' || storagePath.length > 200) return null
  const m = VIZ_KEY_RE.exec(storagePath)
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
// bigger than 200 MB in this bucket path is a mistake or abuse. The webm cap
// is tighter on purpose: the fallback recorder budgets ~30 MB (see
// FreeStudio), and webms feed the 60 s-SIGKILL webmToMp4 transcoder — inputs
// bounded near the old assumptions keep that ceiling comfortable.
export const MAX_FINALIZE_BYTES = 200 * 1024 * 1024
export const MAX_FINALIZE_WEBM_BYTES = 48 * 1024 * 1024

// finalize-video rejects clips under 0.5 s; catching it here keeps garbage out
// of the library instead of surfacing later as a confusing render failure.
export const MIN_CLIP_SECONDS = 0.5

// How much of the head of an MP4 we fetch for validation. Both client encoders
// write faststart MP4s (moov before mdat), so the metadata lives in the first
// couple of MB regardless of file size.
export const MP4_PROBE_BYTES = 2 * 1024 * 1024

// The cap that applies to a claim, chosen by the extension the key carries.
// One function so the two lanes can never drift apart on which ceiling is in
// force — the webm number is deliberately the tighter of the two.
export function maxFinalizeBytesFor(ext: 'mp4' | 'webm'): number {
  return ext === 'webm' ? MAX_FINALIZE_WEBM_BYTES : MAX_FINALIZE_BYTES
}

// Total byte length of the stored object as reported by ONE storage response's
// headers, or null when the response does not say.
//
// Both lanes learn an object's size from a cheap Range probe instead of by
// downloading it: a 206 answers `Content-Range: bytes 0-N/TOTAL`, and a server
// that ignores Range answers 200 + `Content-Length: TOTAL` (Supabase public
// URLs have exactly that flakiness — it is why audioProxyUrl exists).
//
// null means UNKNOWN, and unknown must never be read as "small enough". The
// inline version this replaces did `parseInt(header ?? '0', 10)`, so a response
// carrying NEITHER header produced 0 — and `0 > MAX_FINALIZE_BYTES` is false,
// so the size cap silently did not fire and an object of any size sailed
// through. Callers turn null into a retryable 503: failing to MEASURE the
// object is not the same as the object being acceptable.
//
// Number() rather than parseInt() on purpose: parseInt('12abc') is 12, which
// would let a malformed header masquerade as a measurement.
export function totalBytesFromHeaders(headers: { get(name: string): string | null }): number | null {
  const size = (raw: string | null | undefined): number | null => {
    const text = raw?.trim()
    if (!text) return null
    const n = Number(text)
    return Number.isSafeInteger(n) && n >= 0 ? n : null
  }
  // "bytes 0-2097151/524288000" → 524288000. A server that knows the range but
  // not the total writes "…/*", which stays unknown.
  const contentRange = headers.get('content-range')
  if (contentRange) {
    const total = size(contentRange.split('/')[1])
    if (total !== null) return total
  }
  return size(headers.get('content-length'))
}

// What a demux told us about a claimed object: the primary video track's codec
// (null when there is no video track at all) and the container duration.
export type ClipProbe = { codec: string | null; duration: number }

// Why a probed clip is unusable, or null when it passes. Both lanes run this,
// so "indexed" always means "actually a playable clip":
//   - mp4 must be avc (H.264) — the one codec every surface decodes (web,
//     share page, iOS AVPlayer, finalize-video).
//   - webm carries vp8/vp9/av1 by definition, so the codec is only required to
//     EXIST there; the mp4 twin that the route transcodes is what reaches iOS.
//   - either way the clip must be long enough for finalize-video to use.
//
// The webm lane used to check nothing but blob.size, which is why a 0-byte
// MediaRecorder blob (chunks empty because 'dataavailable' never fired) could
// be stored and reported "Saved": ffmpeg failed it with "EBML header parsing
// failed", the route swallowed that as a transcode miss, and the raw bytes got
// indexed anyway.
export function clipRejectionReason(probe: ClipProbe, ext: 'mp4' | 'webm'): string | null {
  if (!probe.codec) return 'no video track'
  if (ext === 'mp4' && probe.codec !== 'avc') return `codec ${probe.codec}`
  // Written as !(x >= y) so a NaN duration (unreadable container) rejects too.
  if (!(probe.duration >= MIN_CLIP_SECONDS)) return `duration ${probe.duration}`
  return null
}
