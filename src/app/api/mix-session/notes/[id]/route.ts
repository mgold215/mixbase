import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { canonicalUuid, isJsonObject } from '@/lib/validators'
import { checkUserLimit, mixSessionLimiter, rateLimitHeaders } from '@/lib/rate-limit'
import { ensureFeedbackResolvedColumn, isMissingFeedbackResolvedColumn } from '@/lib/schema-heal'

// PATCH /api/mix-session/notes/[id] — tick a note off (or back on).
//
// Body: { done: boolean }
// Returns: { id, done, done_at }
//
// Works on any note on one of the caller's own mixes — their own mix notes and
// listener feedback alike (it is their worklist). Only resolved_at is written;
// the note itself is never edited.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const id = canonicalUuid((await params).id)
  if (!id) return NextResponse.json({ error: 'Valid note id is required' }, { status: 400 })

  const body: unknown = await request.json().catch(() => null)
  if (!isJsonObject(body) || typeof body.done !== 'boolean') {
    return NextResponse.json({ error: 'Body must be { done: true | false }' }, { status: 400 })
  }
  const done = body.done

  const rl = await checkUserLimit(mixSessionLimiter, userId)
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many changes — try again shortly.' }, { status: 429, headers: rateLimitHeaders(rl) })
  }

  // Owner-only: the note's mix must belong to one of the caller's projects.
  const { data: note } = await supabaseAdmin
    .from('mb_feedback')
    .select('id, mb_versions!inner(mb_projects!inner(user_id))')
    .eq('id', id)
    .eq('mb_versions.mb_projects.user_id', userId)
    .maybeSingle()
  if (!note) {
    mixSessionLimiter.rollback(userId)
    return NextResponse.json({ error: 'Note not found' }, { status: 404 })
  }

  const doneAt = done ? new Date().toISOString() : null
  const write = () => supabaseAdmin.from('mb_feedback').update({ resolved_at: doneAt }).eq('id', id)

  let { error } = await write()
  if (error && isMissingFeedbackResolvedColumn(error) && await ensureFeedbackResolvedColumn()) {
    ({ error } = await write())
  }
  if (error) {
    console.error('[mix-session] tick failed:', error.message)
    const missing = isMissingFeedbackResolvedColumn(error)
    return NextResponse.json(
      { error: missing ? 'Ticking notes off isn’t available yet. Try again in a minute.' : 'Could not save that. Try again.' },
      { status: missing ? 503 : 500 },
    )
  }

  return NextResponse.json({ id, done, done_at: doneAt })
}
