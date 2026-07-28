// src/lib/notifications.ts
// Classification + routing for the notifications bell.
//
// Two different events tell you "somebody engaged with your music", and both
// log an mb_activity row against the TRACK OWNER:
//   • src/app/api/feedback/route.ts      — a curator/listener left feedback on
//                                          a public /share/<token> page
//   • src/app/api/feed/comments/route.ts — another artist commented on your
//                                          track in the community feed
//
// Historically both wrote type 'feedback_received', so the bell could not tell
// them apart. New rows carry distinct types; rows written before that deploy
// are classified by their description prefix, which is a literal template in
// both writers. mb_activity.type is a bare `text` column with no CHECK
// constraint, so introducing a new value needs no migration.
//
// Pure + dependency-free ON PURPOSE so a bare `node scripts/*.mjs` contract
// test can import it. Never import supabaseAdmin here.

export type NotificationSource = 'share_feedback' | 'feed_comment'

export const SHARE_FEEDBACK_TYPE = 'feedback_received'
export const FEED_COMMENT_TYPE = 'feed_comment_received'

// The ONLY activity types the bell surfaces. Both mean "someone else acted on
// your work". Do NOT add self-authored types (version_upload, status_change,
// release_created, project creation): they already have production rows, so
// widening this set would retroactively light up every user's badge to the cap
// on the next 60s poll — and they aren't things "other people did" anyway.
export const NOTIFICATION_TYPES = [SHARE_FEEDBACK_TYPE, FEED_COMMENT_TYPE] as const

/** Literal prefix of the legacy feed-comment description template. */
export const FEED_COMMENT_PREFIX = 'Feed comment from '

/** Longest description the bell will render. Rows written before the write-site
 *  cap landed can be arbitrarily long (reviewer_name was unbounded on a public
 *  route), and the bell re-fetches every 60s — so truncate on read too. */
export const MAX_DESCRIPTION_LENGTH = 200

/**
 * Which source produced this activity row.
 *
 * PRESENTATION ONLY. This must never choose the link destination — see
 * notificationHref. Keeping the href source-independent is what makes a
 * misclassified legacy row cost an icon rather than a dead link.
 */
export function classifyActivitySource(
  row: { type?: string | null; description?: string | null },
): NotificationSource {
  // Authoritative for every row written after the discriminator shipped.
  if (row.type === FEED_COMMENT_TYPE) return 'feed_comment'
  // Legacy fallback. startsWith, NEVER includes: `reviewer_name` is
  // attacker-controlled on the public /api/feedback route, and the share-feedback
  // template always begins "Feedback from ", so it can never satisfy this
  // prefix no matter what a reviewer calls themselves. `includes` would let
  // anyone forge a feed-comment badge by naming themselves "Feed comment from".
  if (row.description?.startsWith(FEED_COMMENT_PREFIX)) return 'feed_comment'
  return 'share_feedback'
}

/**
 * Where a notification links to.
 *
 * Deliberately source-independent, and deliberately NEVER /feed. The community
 * feed only surfaces the newest mix of the 60 newest projects drawn from a
 * 200-version window (src/lib/feed.ts), and it fetches comments only for each
 * project's LATEST version — so a /feed?v=<id> deep link goes dead the moment
 * the artist uploads a revision, which is exactly when they'd click it. The
 * project page is the durable permalink for the artist's own work.
 *
 * `?v=` is a HINT, not a guarantee: mb_activity.version_id has no foreign key
 * and version deletion doesn't clean it up, so the target may not exist. The
 * client must resolve it against versions it actually has and no-op otherwise.
 */
export function notificationHref(
  n: { project_id?: string | null; version_id?: string | null },
): string {
  if (!n.project_id) return '/dashboard'
  return n.version_id
    ? `/projects/${n.project_id}?v=${n.version_id}`
    : `/projects/${n.project_id}`
}

/** Trim a stored description to something the bell can render safely. */
export function clampDescription(description: string | null | undefined): string | null {
  if (description == null) return null
  return description.slice(0, MAX_DESCRIPTION_LENGTH)
}
