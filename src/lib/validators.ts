// Small input-validation helpers used by API routes. Keeping these out of the
// route files lets us reuse them and unit-test in one place if we add Jest.

// Matches v4 UUIDs and the broader RFC 4122 shape that Supabase / pgcrypto use.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

/**
 * True only for a JSON object — the one body shape a handler can read keys off.
 *
 * `await request.json()` returns whatever parsed, and `JSON.parse('5')` is 5,
 * which is TRUTHY. So the common `if (!body) return 400` guard waves through
 * numbers, booleans and strings, and the next line — `'field' in body` or
 * `body.field?.trim()` — throws a TypeError that surfaces as an opaque 500 on
 * what is really a malformed request. `typeof null === 'object'` and arrays are
 * objects too, so both are named explicitly rather than assumed away.
 *
 * Lives here rather than in a route because six handlers need the same guard,
 * and a validation rule copied into six files is one edit away from drifting —
 * the exact failure that let mb_collections fall out of the survivor scan.
 */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The ONE spelling of a UUID that may become a Supabase Storage object key.
 *
 * WHY THIS EXISTS RATHER THAN JUST DROPPING THE `/i` ABOVE
 * Three facts compose into a defect that neither one causes alone:
 *
 *   1. UUID_RE carries `/i`, so isUuid() accepts `ABCDEF01-…` as readily as
 *      `abcdef01-…`. That is deliberate and must stay: Swift's
 *      `UUID.uuidString` is UPPERCASE, the shipped native app calls these
 *      routes, and MixbaseAPI.swift's `.lowercased()` is written per call site.
 *      A case-sensitive isUuid() would turn any missed call site into a hard
 *      400 — a functional regression in an app that is already in the store.
 *   2. Every ownership gate resolves against a Postgres `uuid` COLUMN, and
 *      Postgres compares uuids by value, not by text:
 *      `'ABCDEF01-…'::uuid = 'abcdef01-…'::uuid` is true (verified against
 *      production). So an uppercase id passes `ownsProject` / `.eq('id', …)`
 *      exactly like the lowercase one. The gate is not the problem.
 *   3. Supabase Storage keys are plain text and are stored VERBATIM — case and
 *      all. Postgres normalises; the bucket does not.
 *
 * Compose them and an authenticated owner, posting their OWN project id in
 * uppercase, mints `<UPPERCASE-UUID>/<file>` — a real object, in a bucket the
 * user is billed for, that no cleanup path can name. Every reaper, survivor
 * scan and orphan census starts from a project id READ BACK from Postgres,
 * which always renders lowercase, and matches it as text (`listProjectPrefix`
 * walks `${projectId}/`, planReap filters on VIZ_KEY_RE's lowercase
 * `[0-9a-f-]{36}`). None of them can see an uppercase prefix. The object is
 * unreapable, and it is mintable on demand.
 *
 * So the bound goes where the id CROSSES from the case-insensitive world
 * (Postgres, ownership) into the case-sensitive one (storage keys): validate
 * and canonicalise in a single step, so a caller cannot accidentally take the
 * validated-but-uncanonical value. `isUuid` stays exactly as it is — routes
 * that merely READ by id keep working with either spelling.
 *
 * Returns null (never throws, never a wrong id) when the value is not a UUID,
 * so callers refuse with the same 400 they already had.
 */
export function canonicalUuid(value: unknown): string | null {
  return isUuid(value) ? value.toLowerCase() : null
}

// ── Server-side fetch allowlist (SSRF guard) ────────────────────────────────
// Every media asset the app stores is a Supabase Storage *public* URL on the
// project host (mf-audio / mf-artwork / mf-video buckets, all produced by
// getPublicUrl). Several routes fetch these URLs server-side on Railway
// (finalize-artwork, finalize-video), so if an attacker plants an internal URL
// (e.g. http://169.254.169.254/… or an internal service) in a user-writable
// field like audio_url / artwork_url, those fetches become a blind SSRF.
// Restrict server fetches to the Supabase host — mirrors the check already in
// /api/visualizer/runway. Host is read from the env (falls back to the prod
// project) so it follows the project if it is ever re-pointed.
export const SUPABASE_HOST = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://mdefkqaawrusoaojstpq.supabase.co').hostname
  } catch {
    return 'mdefkqaawrusoaojstpq.supabase.co'
  }
})()

/**
 * The one path prefix a public Storage object URL ever has. Exported because
 * project-assets.ts must anchor on the SAME string it is validated against —
 * two spellings of this marker is how a guard and its consumer drift apart.
 */
export const STORAGE_PUBLIC_PREFIX = '/storage/v1/object/public/'

/** The only buckets this app stores assets in. */
export const ASSET_BUCKETS = ['mf-audio', 'mf-artwork', 'mf-video'] as const

// True only for an https:// URL to a public object in one of OUR buckets on the
// Supabase Storage host — the sole shape any legitimately-stored audio /
// artwork / visualizer URL ever takes.
//
// The path half of this check was missing until 2026-08-22: host+protocol alone
// accepted e.g. https://<ref>.supabase.co/rest/v1/profiles?select=*, which the
// server-side fetchers (finalize-artwork, visualizer/free, video-render) would
// then dutifully request. Nothing was exploitable — those APIs need an apikey
// header these fetches don't send — but the guard was materially weaker than
// its name and than every call site's comment claimed. Verified before
// tightening: all 565 asset URLs stored in production match this shape, so no
// existing row changes meaning.
export function isSupabaseStorageUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.hostname !== SUPABASE_HOST) return false
  if (!url.pathname.startsWith(STORAGE_PUBLIC_PREFIX)) return false
  const bucket = url.pathname.slice(STORAGE_PUBLIC_PREFIX.length).split('/')[0]
  return (ASSET_BUCKETS as readonly string[]).includes(bucket)
}

// A TUS resumable-upload id, safe to interpolate into the upstream Storage URL.
//
// `/api/tus/[uploadId]` concatenates this into a URL it then authenticates with
// the SERVICE-ROLE key, and URL parsing collapses `..` segments — so a decoded
// `../../rest/v1/<table>` would re-aim an authenticated PATCH/HEAD at a
// different Supabase API root. Deliberately the narrowest possible guard rather
// than a character allow-list: Supabase's ids are base64/base64url, whose
// alphabets contain no `.` at all, and a raw `/` could never have matched that
// single-segment dynamic route in the first place — so this rejects nothing a
// real upload would ever send.
// Percent-encoded dot segments are included deliberately: the WHATWG URL parser
// decodes `%2e` before resolving, so `%2e%2e` collapses exactly like `..`, and
// Next decodes a route segment once — so `/api/tus/%252e%252e` arrives here as
// `%2e%2e`. Base64/base64url contain no `%` either, so this still rejects
// nothing a real upload would send.
export function isSafeUploadId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  if (value.includes('/') || value.includes('\\') || value.includes('%')) return false
  return !value.includes('..')
}

/**
 * Recover the owning project id from an opaque Supabase TUS upload id.
 *
 * Why this exists: POST /api/tus does the full ownership job (session + bucket
 * allow-list + ownsProject), but PATCH/HEAD on /api/tus/<uploadId> only check
 * that SOMEONE is signed in before forwarding the chunk with the SERVICE-ROLE
 * key. If an upload id is guessable or derivable, any signed-in user could
 * write bytes into another user's in-flight upload.
 *
 * Supabase issues the id from its resumable-upload endpoint and does not
 * document the encoding as a contract. It is base64url-ish and cannot contain
 * `/` or `%` (isSafeUploadId would already reject those, and real uploads
 * work), which is consistent with base64url of `<bucket>/<objectName>` — and
 * our object keys are `<projectId>/<timestamp>.<ext>`, so a project UUID should
 * fall out of a successful decode.
 *
 * Returns null when the id does not decode to something containing a UUID
 * segment. Callers MUST treat null as "cannot determine" and fall back to the
 * previous behaviour rather than denying: guessing the format wrong and failing
 * closed would break every upload in the app, which is a far worse outcome than
 * the narrow hole this closes. A null is reported (shape only, never the id
 * itself — it is an unguessable capability credential) so the real format can be
 * learned from production instead of guessed.
 */
export function projectIdFromUploadId(uploadId: unknown): string | null {
  if (typeof uploadId !== 'string' || uploadId.length === 0) return null
  // base64url → base64, then pad. An id that isn't base64 at all decodes to
  // mojibake, which simply won't contain a UUID segment.
  const b64 = uploadId.replace(/-/g, '+').replace(/_/g, '/')
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
  let decoded: string
  try {
    decoded = Buffer.from(padded, 'base64').toString('utf8')
  } catch {
    return null
  }
  if (!decoded.includes('/')) return null
  for (const segment of decoded.split('/')) {
    if (isUuid(segment)) return segment
  }
  return null
}
