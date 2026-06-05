// Small input-validation helpers used by API routes. Keeping these out of the
// route files lets us reuse them and unit-test in one place if we add Jest.

// Matches v4 UUIDs and the broader RFC 4122 shape that Supabase / pgcrypto use.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}
