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
