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
//
// THIS REGEX HAS A SECOND JOB. planReap (video-orphan-plan.ts) uses it as the
// orphan sweep's shape filter: a key it does not match is counted as
// keptForeignShape and is never deleted, on the reasoning that anything outside
// this shape is not something this app wrote. So the regex is simultaneously
// the gate on what may be WRITTEN and the recognizer for what may be REAPED,
// and the two roles pull in opposite directions — widening it hands the sweep
// permission to delete shapes it currently protects. It is deliberately not
// widened; see VIZ_WEBM_STAMP_MAX for the bound that keeps the app inside it.
export const VIZ_KEY_RE = /^([0-9a-f-]{36})\/viz-([A-Za-z0-9_-]{1,64})\.(mp4|webm)$/

// The extensions VIZ_KEY_RE accepts, as a type the compiler can hold callers to.
//
// This exists because visualizer-store.ts chose its extension from a
// content-type with a free-floating string ternary, and one arm of it minted
// `.mov` — a key this app WROTE and this regex refuses, i.e. unreapable forever
// (the exact shape VIZ_WEBM_STAMP_MAX below was introduced to close). Naming the
// union and annotating the write site turns "add a third extension" from a
// silent storage leak into a compile error, which is a bound no reviewer has to
// remember to enforce.
export type VizKeyExt = 'mp4' | 'webm'

// What mp4TwinPath() (visualizer-encode.ts) appends to a webm basename when the
// finalize webm lane transcodes a claim: `X.webm` → `X-h264.mp4`. Repeated here
// rather than imported because visualizer-encode.ts pulls in ffmpeg and
// child_process, and this module has to stay IO-free — it is imported by
// video-orphan-plan.ts, which scripts/video-orphan-reaper-test.mjs loads in
// plain Node. scripts/viz-key-shape-test.mjs holds the two together by
// exhaustively checking that every claimable webm key's real twin still matches
// VIZ_KEY_RE.
export const VIZ_TWIN_SUFFIX = '-h264'

// The stamp budget VIZ_KEY_RE grants (the `{1,64}` above).
export const VIZ_STAMP_MAX = 64

// The tighter budget a WEBM claim gets, and the whole fix for a leak that had no
// cleanup path at all.
//
// The webm lane is the only one that DERIVES a second key from the claimed one:
// it transcodes and writes the mp4 twin at mp4TwinPath(claimedKey), which spends
// VIZ_TWIN_SUFFIX.length more characters on the basename. A claim whose stamp
// already filled the 64-character budget therefore produced a twin of 65-69
// characters — a key this app WROTE and then refused to recognize. planReap
// counted it as keptForeignShape, so once it fell out of mb_visualizers (a
// deleted row whose storage remove was refused, a heal that half-finished) it
// was unreachable forever: invisible in Media, unnameable by DELETE
// /api/visualizer/[id], missed by /api/auth/delete-account, and skipped by the
// one sweep that exists to catch exactly that.
//
// THE FIX IS THE BOUND, NOT A WIDER REGEX. Teaching VIZ_KEY_RE to match 65-69
// character stamps would close the leak by making the sweep ELIGIBLE TO DELETE a
// shape it currently protects — and every trade in this lane is priced the other
// way round (a leaked object costs storage until someone looks; a wrongly reaped
// one destroys a render the user believes is saved). Refusing the over-long
// claim up front costs nothing that can be observed: the longest stamp any
// client has ever generated is a 13-character Date.now(), and the 83 objects in
// production on 2026-08-17 were all 13 (or 18 for a twin) — see
// scripts/viz-key-shape-test.mjs, which pins that census.
//
// The bound is also STRICTLY narrower than VIZ_KEY_RE, which is what makes it
// safe on its own: an over-long webm that was signed before this shipped and
// uploaded after still matches the recognizer, so the sweep still collects it.
// Nothing is stranded by tightening the gate — only by loosening the recognizer.
export const VIZ_WEBM_STAMP_MAX = VIZ_STAMP_MAX - VIZ_TWIN_SUFFIX.length

export function parseVizStoragePath(
  projectId: string,
  storagePath: unknown,
): { ext: VizKeyExt } | null {
  if (typeof storagePath !== 'string' || storagePath.length > 200) return null
  const m = VIZ_KEY_RE.exec(storagePath)
  if (!m || m[1] !== projectId) return null
  const ext = m[3] as VizKeyExt
  // Only the webm lane derives a twin, so only a webm key has to leave room for
  // one. An mp4 claim is indexed at the key it names and keeps the full budget.
  if (ext === 'webm' && m[2].length > VIZ_WEBM_STAMP_MAX) return null
  return { ext }
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
export function maxFinalizeBytesFor(ext: VizKeyExt): number {
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
export function clipRejectionReason(probe: ClipProbe, ext: VizKeyExt): string | null {
  if (!probe.codec) return 'no video track'
  if (ext === 'mp4' && probe.codec !== 'avc') return `codec ${probe.codec}`
  // Written as !(x >= y) so a NaN duration (unreadable container) rejects too.
  if (!(probe.duration >= MIN_CLIP_SECONDS)) return `duration ${probe.duration}`
  return null
}
