// Small input-validation helpers used by API routes. Keeping these out of the
// route files lets us reuse them and unit-test in one place if we add Jest.

// Matches v4 UUIDs and the broader RFC 4122 shape that Supabase / pgcrypto use.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
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
const SUPABASE_HOST = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://mdefkqaawrusoaojstpq.supabase.co').hostname
  } catch {
    return 'mdefkqaawrusoaojstpq.supabase.co'
  }
})()

// True only for an https:// URL on the Supabase Storage host — the sole shape
// any legitimately-stored audio / artwork / visualizer URL ever takes.
export function isSupabaseStorageUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return url.protocol === 'https:' && url.hostname === SUPABASE_HOST
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
