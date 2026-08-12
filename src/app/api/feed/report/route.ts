import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, serviceRoleKeyValid } from '@/lib/supabase'
import { moderationLimiter, rateLimitHeaders, checkUserLimit } from '@/lib/rate-limit'
import { isUuid } from '@/lib/validators'
import { ensureUgcModerationTables, isMissingUgcModerationTable } from '@/lib/schema-heal'

// POST /api/feed/report — report objectionable community-feed content
// (App Store Guideline 1.2). Authenticated; reporter identity comes from the
// middleware-verified X-User-Id header, never the body.
//
// Moderation model:
// - The reporter never sees the content again (feed queries exclude anything
//   the viewer has reported).
// - At AUTO_HIDE_THRESHOLD distinct reporters, a comment is hard-deleted and a
//   version drops out of everyone's feed (exclusion in getFeed). Report rows
//   are retained as the audit trail either way.

const AUTO_HIDE_THRESHOLD = 3
const MAX_REASON_LENGTH = 500
const CONTENT_TYPES = ['version', 'comment'] as const

export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (!serviceRoleKeyValid) {
    console.error('[report] rejected: server has no valid service-role key')
    return NextResponse.json({ error: 'Server is misconfigured — please try again shortly' }, { status: 503 })
  }

  const limit = await checkUserLimit(moderationLimiter, userId)
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Too many requests. Try again later.' }, { status: 429, headers: rateLimitHeaders(limit) })
  }
  const reject = (error: string, status: number) => {
    moderationLimiter.rollback(userId)
    return NextResponse.json({ error }, { status })
  }

  const body = await request.json().catch(() => null)
  if (!body) return reject('Invalid JSON body', 400)
  const { content_type, content_id } = body
  if (!CONTENT_TYPES.includes(content_type)) return reject('content_type must be "version" or "comment"', 400)
  if (!isUuid(content_id)) return reject('Valid content_id is required', 400)
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, MAX_REASON_LENGTH) : null

  // Upsert-ignore: reporting twice is a no-op, not an error — the client can
  // safely re-send on flaky networks.
  const runInsert = () => supabaseAdmin
    .from('mb_content_reports')
    .upsert(
      { reporter_id: userId, content_type, content_id, reason },
      { onConflict: 'reporter_id,content_type,content_id', ignoreDuplicates: true }
    )

  let res = await runInsert()
  if (res.error && isMissingUgcModerationTable(res.error) && await ensureUgcModerationTables()) {
    res = await runInsert()
  }
  if (res.error) {
    if (res.error.code === '23503') return reject('Account not found — please sign in again', 401)
    console.error('[report] insert failed:', res.error.message)
    return reject('Failed to save report', 500)
  }

  // Threshold enforcement — act on reports rather than just collecting them.
  // Best-effort: a counting failure must not fail the report itself.
  try {
    const { count } = await supabaseAdmin
      .from('mb_content_reports')
      .select('id', { count: 'exact', head: true })
      .eq('content_type', content_type)
      .eq('content_id', content_id)
    if ((count ?? 0) >= AUTO_HIDE_THRESHOLD && content_type === 'comment') {
      await supabaseAdmin.from('mb_feed_comments').delete().eq('id', content_id)
      console.warn(`[report] comment ${content_id} auto-removed after ${count} reports`)
    }
    // Versions at threshold are excluded for everyone inside getFeed(); the
    // uploader keeps their own audio — it just stops being broadcast.
  } catch (e) {
    console.warn('[report] threshold check failed:', e instanceof Error ? e.message : e)
  }

  return NextResponse.json({ ok: true }, { status: 201 })
}
