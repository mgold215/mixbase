// Which PostgREST / Postgres errors mean "the relation this heal creates does
// not exist yet".
//
// PURE BY DESIGN: no imports at all, so scripts/schema-heal-matcher-test.mjs can
// load it under `node --experimental-strip-types` and test the REAL predicate
// against real captured wire payloads, instead of re-deriving its regex in the
// test and proving only that a copy of the bug agrees with itself. Same reason
// heal-retry.ts and validators.ts are import-free.

/** Postgres: undefined_table, straight from the Management API / db-init channel. */
export const PG_UNDEFINED_TABLE = '42P01'
/** PostgREST: table absent from the schema cache. */
export const PGRST_MISSING_TABLE = 'PGRST205'
/** PostgREST: column absent from the schema cache. */
export const PGRST_MISSING_COLUMN = 'PGRST204'

/**
 * True when `error` reports that a relation is missing. `namePattern` must match
 * the relation name inside the message, so one table's absence never triggers
 * another table's heal.
 *
 * THIS FUNCTION EXISTS BECAUSE THE OBVIOUS GUARD IS WRONG. PostgREST does not
 * say "does not exist" for an unknown table. It answers PGRST205 with:
 *
 *   Could not find the table 'public.mb_user_blocks' in the schema cache
 *
 * — which contains neither "does not exist" nor "relation". A guard written as
 * `name && /does not exist|relation/` therefore NEVER fires against a live
 * PostgREST client. That is not hypothetical. It is exactly how UGC moderation
 * (App Store Guideline 1.2) shipped dead: `ensureUgcModerationTables` was
 * correctly wired into all three of its consumers — the feed's filter query and
 * the report and block routes — and was unreachable from every one of them,
 * because the guard in front of each call site answered false. The tables were
 * still absent in production weeks later, iOS's Report button returned 500 on
 * every tap, and Sentry stayed green the whole time because the feed
 * deliberately degrades to "no filtering" rather than failing.
 *
 * The identical defect was found and fixed once before, for mb_library_tracks
 * (d702c23), and not backported to its two siblings. Centralising it here is
 * what prevents the third recurrence: a new heal calls this and inherits every
 * format, instead of re-deriving the list from memory and getting it wrong.
 *
 * 42P01 and the "does not exist" / "relation" phrasings stay accepted because
 * these matchers are also fed raw Postgres errors, which do use that wording.
 */
export function isMissingRelationError(
  error: { code?: string; message?: string } | null | undefined,
  namePattern: RegExp,
): boolean {
  if (!error) return false
  const message = error.message ?? ''
  if (!namePattern.test(message)) return false
  if (
    error.code === PGRST_MISSING_TABLE ||
    error.code === PGRST_MISSING_COLUMN ||
    error.code === PG_UNDEFINED_TABLE
  ) return true
  return /does not exist|relation|schema cache/.test(message)
}
