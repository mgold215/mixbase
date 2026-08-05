// Failure classification for the Supabase Management API channel that every
// schema heal talks to.
//
// WHY THIS IS ITS OWN MODULE — `schema-heal.ts` imports the `@/` path alias,
// which plain Node type-stripping cannot resolve, so the logic deciding
// "retry or give up" could never be exercised by a real test where it lived;
// only the source TEXT could be asserted on. Splitting the pure half out is the
// same move that made `proc-deadline.ts` and `visualizer-encode.ts` testable.
// Keep this file dependency-free.
//
// WHY IT CHANGED — on 2026-08-04T20:51:52Z, six seconds into a production boot,
// four heals failed at once (`mb_library_tracks table`, `mb_releases DistroKid
// columns`, `mb_usage write lockdown`, Sentry MIXBASE-5/7/8). The payload was
// not a Postgres error at all: it was Cloudflare's `supabase.com | 502: Bad
// gateway` HTML page. The classifier below used to match on the response BODY
// only, looking for Postgres catalog-race text — so a gateway page could never
// be recognised as transient, every one of those heals was tagged
// `transient:false`, none retried, and each was charged against its per-label
// failure budget. A 502 is the single most likely Management API failure during
// a deploy, and it was the one class the retry could not see.

/**
 * Postgres catalog contention — two healers rewriting the same pg_proc/pg_class
 * row at once. Not a defect in the SQL, and it self-clears on a retry, so it
 * must not page anyone; the advisory locks in schema-heal make it rare, and
 * this keeps the residual (a lock taken on a connection that dies mid-flight,
 * say) from looking like a real failure.
 */
export function isTransientCatalogRace(detail: string): boolean {
  return /tuple concurrently updated|deadlock detected|could not serialize access/i.test(detail)
}

/**
 * Statuses where a proxy, gateway or rate limiter answered INSTEAD of Postgres,
 * so the SQL never reached a decision and re-sending it is both safe and
 * correct.
 *
 * 500 is deliberately EXCLUDED. The Management API answers malformed SQL with
 * 400, so a 500 is its own internal fault and may well be deterministic —
 * retrying it just doubles the load on an API we reach from a public endpoint.
 * 401/403 are excluded for the stronger reason that a bad credential never
 * self-recovers; schema-heal escalates those to Sentry at error level.
 */
const TRANSIENT_STATUSES = new Set([408, 429, 502, 503, 504])

export function isTransientStatus(status: number): boolean {
  return TRANSIENT_STATUSES.has(status)
}

/**
 * A heal attempt that did not succeed. `network` covers everything that never
 * produced an HTTP status at all — DNS failure, connection reset, or the
 * request deadline firing — which is the same situation as a 502 from the
 * caller's point of view: nothing reached Postgres.
 */
export type HealFailure =
  | { kind: 'status'; status: number; detail: string }
  | { kind: 'network' }

/**
 * Should this failure be re-sent once? True for anything that did not reach a
 * decision, plus the catalog race, which reaches one and loses a coin flip.
 */
export function isRetryableHealFailure(failure: HealFailure): boolean {
  if (failure.kind === 'network') return true
  return isTransientStatus(failure.status) || isTransientCatalogRace(failure.detail)
}
