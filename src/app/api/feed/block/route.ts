import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, serviceRoleKeyValid } from '@/lib/supabase'
import { moderationLimiter, rateLimitHeaders, checkUserLimit } from '@/lib/rate-limit'
import { isUuid } from '@/lib/validators'
import { ensureUgcModerationTables, isMissingUgcModerationTable } from '@/lib/schema-heal'

// POST /api/feed/block — block another artist (App Store Guideline 1.2).
// DELETE /api/feed/block — unblock. Authenticated; blocker identity comes from
// the middleware-verified X-User-Id header. A block hides ALL of the blocked
// user's feed items and comments from the blocker (filtered in getFeed).

async function withHeal<T extends { error: { code?: string; message?: string } | null }>(run: () => PromiseLike<T>): Promise<T> {
  let res = await run()
  if (res.error && isMissingUgcModerationTable(res.error) && await ensureUgcModerationTables()) {
    res = await run()
  }
  return res
}

async function guard(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return { fail: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  if (!serviceRoleKeyValid) {
    console.error('[block] rejected: server has no valid service-role key')
    return { fail: NextResponse.json({ error: 'Server is misconfigured — please try again shortly' }, { status: 503 }) }
  }
  const limit = await checkUserLimit(moderationLimiter, userId)
  if (!limit.allowed) {
    return { fail: NextResponse.json({ error: 'Too many requests. Try again later.' }, { status: 429, headers: rateLimitHeaders(limit) }) }
  }
  const body = await request.json().catch(() => null)
  const targetId = body?.user_id
  if (!isUuid(targetId)) {
    moderationLimiter.rollback(userId)
    return { fail: NextResponse.json({ error: 'Valid user_id is required' }, { status: 400 }) }
  }
  if (targetId === userId) {
    moderationLimiter.rollback(userId)
    return { fail: NextResponse.json({ error: 'You cannot block yourself' }, { status: 400 }) }
  }
  return { userId, targetId }
}

export async function POST(request: NextRequest) {
  const g = await guard(request)
  if ('fail' in g) return g.fail

  const res = await withHeal(() => supabaseAdmin
    .from('mb_user_blocks')
    .upsert(
      { blocker_id: g.userId, blocked_id: g.targetId },
      { onConflict: 'blocker_id,blocked_id', ignoreDuplicates: true }
    ))
  if (res.error) {
    moderationLimiter.rollback(g.userId)
    // 23503 on blocked_id = target account doesn't exist
    if (res.error.code === '23503') return NextResponse.json({ error: 'User not found' }, { status: 404 })
    console.error('[block] insert failed:', res.error.message)
    return NextResponse.json({ error: 'Failed to block user' }, { status: 500 })
  }
  return NextResponse.json({ ok: true }, { status: 201 })
}

export async function DELETE(request: NextRequest) {
  const g = await guard(request)
  if ('fail' in g) return g.fail

  const res = await withHeal(() => supabaseAdmin
    .from('mb_user_blocks')
    .delete()
    .eq('blocker_id', g.userId)
    .eq('blocked_id', g.targetId))
  if (res.error) {
    moderationLimiter.rollback(g.userId)
    console.error('[block] delete failed:', res.error.message)
    return NextResponse.json({ error: 'Failed to unblock user' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
