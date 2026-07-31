// Defaults applied when a new mix (mb_versions row) is created.
//
// Dependency-free on purpose: scripts/download-default-test.mjs imports this
// directly, so the rules below are asserted as real behavior rather than being
// pattern-matched out of route source.

/**
 * Decide whether a newly uploaded mix offers a Download button on the project's
 * PUBLIC share page.
 *
 * An explicit boolean from the caller always wins. Otherwise the choice is
 * INHERITED from the project's previous mix, and only falls back to `false` for
 * the very first mix in a project.
 *
 * What this flag is, precisely: it is a CONSENT SIGNAL, not an access control.
 * The mf-audio bucket is public-read and `audio_url` is necessarily part of the
 * anonymous share payload (the page has to be able to play the track), so anyone
 * holding a share link can already fetch the original bytes directly. What
 * `allow_download` decides is whether mixBASE itself hands them a labeled button
 * — i.e. whether the product presents the master as something the artist offered.
 * That makes it a statement of intent, which is exactly why it must not be
 * invented on the artist's behalf.
 *
 * Why inherit rather than pick a constant:
 *
 *  • `true` is wrong as a blanket default. It reads as "they have a share link,
 *    so they meant to publish this", but mb_projects.share_token is minted by a
 *    DB column default (`gen_random_uuid()`) the moment a project row is created
 *    — every one of the 78 projects in production has one, whether or not the
 *    artist ever sent it to anyone, and /api/tracks actively backfills the token
 *    onto any project missing it. Nothing in the app can revoke a token once it
 *    exists. So "has a token" carries no information about the artist's intent,
 *    and a `true` default states a consent that was never given — while the
 *    support copy and the checkbox both describe the setting as something you
 *    tick to turn ON.
 *
 *  • A flat `false` is safe but silently discards the artist's decision. The
 *    "Let people with the share link download this file" checkbox is rendered
 *    only on the current-mix card, and the share page always serves the LATEST
 *    version — so an artist who turns downloads on would find them off again
 *    after the next upload, with no indication why. Restoring an archived mix
 *    re-inserts it as a new row, so it resets there too.
 *
 * Inheriting satisfies both: nothing is ever presented as offered without a
 * deliberate tick, and one tick keeps applying to the mixes that follow it.
 *
 * @param requested   `allow_download` as supplied by the caller (untrusted body value)
 * @param previous    `allow_download` of the project's highest-numbered existing mix
 */
export function resolveAllowDownload(requested: unknown, previous: unknown): boolean {
  // Only a real boolean counts as an explicit choice — a string/number/null from
  // a request body must not be coerced into a consent the artist never gave.
  if (typeof requested === 'boolean') return requested
  return previous === true
}
