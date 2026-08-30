import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, serviceRoleKeyValid } from '@/lib/supabase'
import { feedCommentLimiter, rateLimitHeaders , checkUserLimit } from '@/lib/rate-limit'
import { isUuid } from '@/lib/validators'
import { publicArtistName, unwrapJoin, type FeedComment } from '@/lib/feed'
import { ensureFeedCommentsTable, isMissingFeedCommentsTable } from '@/lib/schema-heal'
import { FEED_COMMENT_TYPE, FEED_COMMENT_PREFIX } from '@/lib/notifications'
import { versionDisplayLabel } from '@/lib/mix-status'

const MAX_COMMENT_LENGTH = 2000

// POST /api/feed/comments — leave a comment on another artist's upload.
// Authenticated; the commenter identity comes from the middleware-verified
// X-User-Id header, never the request body.
export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Defense in depth behind the middleware chokepoint: a process without real
  // service-role power can't write anything — say so honestly.
  if (!serviceRoleKeyValid) {
    console.error('[feed] comment rejected: server has no valid service-role key')
    return NextResponse.json({ error: 'Server is misconfigured — please try again shortly' }, { status: 503 })
  }

  const limit = await checkUserLimit(feedCommentLimiter, userId)
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Too many comments. Try again later.' }, { status: 429, headers: rateLimitHeaders(limit) })
  }

  // A credit is spent above, before we know the request is even well-formed.
  // Every failure exit from here on refunds it — otherwise a client looping on
  // a deleted track (404) or a validation slip burns the 30/hr window and locks
  // the user out of commenting for an hour over requests that never wrote a
  // row. Mirrors the rollback pattern in /api/finalize-video.
  const reject = (error: string, status: number) => {
    feedCommentLimiter.rollback(userId)
    return NextResponse.json({ error }, { status })
  }

  const body = await request.json().catch(() => null)
  if (!body) return reject('Invalid JSON body', 400)
  const { version_id, comment } = body

  if (!isUuid(version_id)) {
    return reject('Valid version_id is required', 400)
  }
  const text = typeof comment === 'string' ? comment.trim() : ''
  if (!text) return reject('Comment is required', 400)
  if (text.length > MAX_COMMENT_LENGTH) {
    return reject(`Comment must be under ${MAX_COMMENT_LENGTH} characters`, 400)
  }

  // Insert directly — the version_id FK enforces "track exists" atomically, so
  // there's no pre-lookup whose failure modes could be misreported as a
  // missing track. Read back ONLY the comment's own columns: an earlier version
  // pulled the track owner via an `mb_versions!inner(...mb_projects!inner(...))`
  // embed in the same RETURNING, but that embed reads ANOTHER artist's rows, so
  // when it came back empty the whole `.single()` failed to coerce and PostgREST
  // rolled the insert back — commenting on anyone else's track died with
  // "Cannot coerce the result to a single JSON object" and saved nothing. The
  // owner (for the activity log) is fetched separately below, best-effort.
  const runInsert = () => supabaseAdmin
    .from('mb_feed_comments')
    .insert({ version_id, user_id: userId, comment: text })
    .select('id, version_id, user_id, comment, created_at')
    .single()

  const parallel = await Promise.all([
    runInsert(),
    supabaseAdmin.from('profiles').select('artist_name, display_name').eq('id', userId).single(),
  ])
  let insertRes = parallel[0]
  const profileRes = parallel[1]

  // Deploy may have beaten migration 022 — heal the table and retry once.
  if (insertRes.error && isMissingFeedCommentsTable(insertRes.error) && await ensureFeedCommentsTable()) {
    insertRes = await runInsert()
  }

  const { data, error } = insertRes
  if (error || !data) {
    // 23503 = FK violation. The insert has TWO FKs — only a version_id
    // violation means the track is gone. A user_id violation (deleted account
    // with a still-valid token) must not masquerade as a missing track.
    if (error?.code === '23503') {
      const detail = `${error.details ?? ''} ${error.message ?? ''}`
      if (detail.includes('version_id') || detail.includes('mb_versions')) {
        return reject('Track not found', 404)
      }
      return reject('Account not found — please sign in again', 401)
    }
    // 42501 = RLS violation → this process is writing as anon (bad key).
    if (error?.code === '42501') {
      console.error('[feed] comment insert hit RLS — admin client is running as anon')
      return reject('Server is misconfigured — please try again shortly', 503)
    }
    console.error('[feed] comment insert failed:', error?.message)
    return reject(error?.message ?? 'Failed to save comment', 500)
  }

  const artist = publicArtistName(profileRes.data)

  // Surface the comment in the track owner's activity feed. Best-effort:
  // failures here must never fail the comment itself. Fetched in a SEPARATE
  // service-role query (not embedded in the insert's RETURNING) so reading the
  // other artist's track can never roll back the comment write.
  try {
    const { data: version } = await supabaseAdmin
      .from('mb_versions')
      .select('project_id, version_number, label, audio_filename, status, mb_projects(user_id)')
      .eq('id', version_id)
      .maybeSingle()
    const ownerId = (unwrapJoin(version?.mb_projects) as { user_id?: string } | null)?.user_id ?? null
    if (version && ownerId && ownerId !== userId) {
      await supabaseAdmin.from('mb_activity').insert({
        // Distinct from share-page feedback so the bell can label the two
        // sources apart without parsing this description. Legacy rows (written
        // when both sources used 'feedback_received') still classify correctly
        // via the FEED_COMMENT_PREFIX fallback in src/lib/notifications.ts.
        type: FEED_COMMENT_TYPE,
        project_id: version.project_id,
        version_id,
        user_id: ownerId,
        description: `${FEED_COMMENT_PREFIX}${artist} on ${versionDisplayLabel(version)}`,
      })
    }
  } catch (e) {
    console.warn('[feed] activity log for comment failed:', e instanceof Error ? e.message : e)
  }

  const created: FeedComment = {
    id: data.id,
    version_id: data.version_id,
    user_id: data.user_id,
    artist,
    comment: data.comment,
    created_at: data.created_at,
  }
  return NextResponse.json(created, { status: 201 })
}
