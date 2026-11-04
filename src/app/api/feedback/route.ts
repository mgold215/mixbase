import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { feedbackLimiter, ipKey, rateLimitHeaders } from '@/lib/rate-limit'
import { isUuid } from '@/lib/validators'
import { versionDisplayLabel } from '@/lib/mix-status'
import { resolveShareTarget } from '@/lib/share-target'

// Caps for the two free-text fields on this PUBLIC, unauthenticated route.
// Both are stored in unbounded `text` columns, and `reviewer_name` is also
// interpolated into the mb_activity description that the nav bell renders and
// re-polls every 60s (src/components/Nav.tsx) — so an uncapped name is a
// persistent payload in the victim's UI that they cannot clear. 80 chars is a
// display name; 2000 matches MAX_COMMENT_LENGTH on the feed-comment route.
const MAX_REVIEWER_NAME_LENGTH = 80
const MAX_COMMENT_LENGTH = 2000

// POST /api/feedback — submit feedback for a shared version (public route)
export async function POST(request: NextRequest) {
  const limit = feedbackLimiter.check(ipKey(request))
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Too many requests. Try again later.' }, { status: 429, headers: rateLimitHeaders(limit) })
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  const { version_id, reviewer_name, rating, comment, timestamp_seconds, share_token, project_id } = body

  // Public route — `comment` may be any JSON type. `comment?.trim()` only guards
  // null/undefined, so a number or array reached `.trim` as undefined and threw
  // an uncaught TypeError (500) on an unauthenticated endpoint.
  const commentText = typeof comment === 'string' ? comment.trim() : ''
  // The target is named one of two ways:
  //   · version_id                — the single-track share page, which has it;
  //   · share_token + project_id  — the album share page, whose payload carries
  //     no version ids at all (deliberately). The token is the capability and
  //     the project id can only narrow it: src/lib/share-target.ts resolves the
  //     pair to the newest mix of that track, and refuses a project the
  //     collection does not contain.
  const namesVersion = version_id != null
  const namesShare = !namesVersion && typeof share_token === 'string' && typeof project_id === 'string'
  if ((!namesVersion && !namesShare) || !commentText) {
    return NextResponse.json({ error: 'version_id and comment are required' }, { status: 400 })
  }
  if (commentText.length > MAX_COMMENT_LENGTH) {
    return NextResponse.json({ error: `Comment must be under ${MAX_COMMENT_LENGTH} characters` }, { status: 400 })
  }

  // Public endpoint — validate the id shape before it reaches a DB insert/lookup so a
  // malformed value can't surface a raw Postgres error message to an anonymous caller.
  if (namesVersion && !isUuid(version_id)) {
    return NextResponse.json({ error: 'Valid version_id is required' }, { status: 400 })
  }
  if (namesShare && !isUuid(project_id)) {
    return NextResponse.json({ error: 'Valid project_id is required' }, { status: 400 })
  }

  // Rating is optional, but if present it must be a whole number 1–5 — the UI
  // renders it as stars. This is a public route, so don't trust the value.
  //
  // 0 means "no star clicked", not an invalid rating. FeedbackForm initialises
  // its rating state to 0 and posts it raw, and `0 != null` is true, so the
  // range check below rejected EVERY unrated submission with "Rating must be a
  // whole number from 1 to 5" — i.e. a listener could not leave a comment at
  // all without also clicking a star. Normalise first, then validate.
  const hasRating = rating != null && rating !== 0
  if (hasRating && (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5)) {
    return NextResponse.json({ error: 'Rating must be a whole number from 1 to 5' }, { status: 400 })
  }

  // Optional playback position the listener pinned their comment to (e.g. "the
  // kick is too loud at 1:32"). Public route — never trust the value: it must be
  // a finite, non-negative number, stored as whole seconds and capped at 24h so a
  // bogus value can't push a marker off the end of the scrubber in the artist view.
  let ts: number | null = null
  if (timestamp_seconds != null) {
    if (typeof timestamp_seconds !== 'number' || !Number.isFinite(timestamp_seconds) || timestamp_seconds < 0) {
      return NextResponse.json({ error: 'timestamp_seconds must be a non-negative number' }, { status: 400 })
    }
    ts = Math.min(Math.floor(timestamp_seconds), 86400)
  }

  // One sanitized name used EVERYWHERE below. The insert and the activity-log
  // description previously derived it separately (`.trim()` vs raw), so the
  // stored name and the notification text could disagree.
  const rawName = typeof reviewer_name === 'string' ? reviewer_name.trim() : ''
  const safeName = (rawName || 'Anonymous').slice(0, MAX_REVIEWER_NAME_LENGTH)

  let versionId: string = version_id
  if (namesShare) {
    const target = await resolveShareTarget(share_token, project_id)
    // A token that is unknown, or that does not cover this project, reads the
    // same as a share that does not exist.
    if (!target || target.projectId !== project_id) {
      return NextResponse.json({ error: 'Share not found' }, { status: 404 })
    }
    versionId = target.versionId
  }

  const { data, error } = await supabaseAdmin
    .from('mb_feedback')
    .insert({
      version_id: versionId,
      reviewer_name: safeName,
      rating: hasRating ? rating : null,
      comment: commentText,
      timestamp_seconds: ts,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Fetch the version + project owner for the activity log
  const { data: version } = await supabaseAdmin
    .from('mb_versions')
    .select('project_id, version_number, label, audio_filename, status, mb_projects!inner(user_id)')
    .eq('id', versionId)
    .single()

  if (version) {
    const proj = version.mb_projects
    const projectUserId: string | null = Array.isArray(proj)
      ? (proj[0]?.user_id ?? null)
      : ((proj as { user_id: string } | null)?.user_id ?? null)
    await supabaseAdmin.from('mb_activity').insert({
      type: 'feedback_received',
      project_id: version.project_id,
      version_id: versionId,
      user_id: projectUserId,
      description: `Feedback from ${safeName} on ${versionDisplayLabel(version)}`,
    })
  }

  return NextResponse.json(data, { status: 201 })
}
