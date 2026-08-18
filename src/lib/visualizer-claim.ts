// Pure decision rules for a REPEATED visualizer claim — the case where the same
// mf-video object is registered with /api/visualizer/finalize more than once.
//
// fx/upload.ts re-POSTs the claim when its response is lost, deliberately:
// retrying a few hundred bytes of JSON beats re-uploading the video, and beats
// the caller falling back to the legacy multipart save (which would store a
// second COPY of the bytes). The cost is that indexVisualizer() must be
// idempotent on the storage path, or a retried claim writes a SECOND
// mb_visualizers row over one object — a duplicate in Media, and a delete of
// either row that takes the shared bytes and leaves the other pointing at a 404.
//
// Kept dependency-free so scripts/viz-claim-idempotency-test.mjs can assert the
// rules directly (src/lib/visualizer-store.ts reaches for the '@/' alias and a
// live Supabase client, so it cannot be loaded under Node type stripping).

/**
 * What a "is this object already indexed?" lookup found.
 *
 *  - a row     — some mb_visualizers row already points at this exact object
 *  - null      — definitively no row
 *  - undefined — the LOOKUP ITSELF failed; the question is unanswered
 *
 * The third state is the whole point of this type. Collapsing "we don't know"
 * into "there is no row" is what turns a transient PostgREST blip into a delete
 * of somebody's finished render.
 */
export type ExistingClaim = { id: string; user_id: string } | null | undefined

/** What to do with a claim BEFORE attempting the insert. */
export type ClaimPrecheck = 'reuse' | 'insert' | 'foreign'

/**
 * `reuse`   — hand back the existing row; the client gets the success it
 *             would have got the first time, and no duplicate is created.
 * `insert`  — no row is known to exist, so write one. An UNANSWERED lookup
 *             lands here too: the insert is the authority, and once migration
 *             033 is applied the unique index refuses a real duplicate.
 * `foreign` — a row over this key belongs to someone else. Impossible by
 *             construction (the key is prefixed with a project the caller was
 *             already proven to own), so refuse rather than write over it.
 */
export function claimPrecheck(existing: ExistingClaim, userId: string): ClaimPrecheck {
  if (existing === undefined || existing === null) return 'insert'
  return existing.user_id === userId ? 'reuse' : 'foreign'
}

/** What to do once the insert itself has failed. */
export type ClaimAfterFailure = 'reuse' | 'keep-bytes' | 'remove-bytes'

/**
 * Two concurrent retries of the SAME claim can both pass claimPrecheck. Once
 * migration 033 is applied, the loser's insert fails on the unique index rather
 * than writing a duplicate — and the winner's row is the right answer for both.
 *
 * `remove-bytes` is the ONLY outcome that licenses deleting the object, and it
 * requires a definitive "no row exists". An unanswered lookup (`undefined`) and
 * a row owned by someone else both keep the bytes: the orphan sweep in
 * video-orphan-reaper.ts collects them 24 h later if they really were abandoned,
 * which is a recoverable mistake in a way that deleting a live video is not.
 */
export function claimAfterInsertFailure(existing: ExistingClaim, userId: string): ClaimAfterFailure {
  if (existing === undefined) return 'keep-bytes'
  if (existing === null) return 'remove-bytes'
  return existing.user_id === userId ? 'reuse' : 'keep-bytes'
}
