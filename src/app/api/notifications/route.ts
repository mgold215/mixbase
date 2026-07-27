import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { ensureActivitySeenColumn, isMissingActivitySeenColumn } from '@/lib/schema-heal'

export type NotificationItem = {
  id: string
  description: string | null
  project_id: string | null
  created_at: string
}

// GET /api/notifications — recent things OTHER people did to the user's work
// (feed comments + share-page feedback both log mb_activity type
// 'feedback_received' against the owner), plus how many arrived since the
// user last opened the bell.
export async function GET(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const readCursor = () => supabaseAdmin
    .from('profiles')
    .select('activity_seen_at')
    .eq('id', userId)
    .maybeSingle()

  const [itemsRes, firstCursorRes] = await Promise.all([
    supabaseAdmin
      .from('mb_activity')
      .select('id, description, project_id, created_at')
      .eq('user_id', userId)
      .eq('type', 'feedback_received')
      .order('created_at', { ascending: false })
      .limit(20),
    readCursor(),
  ])

  if (itemsRes.error) {
    return NextResponse.json({ error: itemsRes.error.message }, { status: 500 })
  }

  // A deploy can beat migration 023 to production — heal the column and retry
  // so a missing cursor doesn't masquerade as "everything is read" forever.
  let profileRes = firstCursorRes
  if (profileRes.error && isMissingActivitySeenColumn(profileRes.error) && await ensureActivitySeenColumn()) {
    profileRes = await readCursor()
  }

  const items = (itemsRes.data ?? []) as NotificationItem[]
  // No cursor yet (brand-new profile) → treat everything as read rather than
  // flooding the badge with historic activity. A cursor we genuinely failed to
  // read is NOT the same thing, so surface that instead of silently zeroing.
  if (profileRes.error) {
    return NextResponse.json({ error: profileRes.error.message }, { status: 500 })
  }
  const seenAt = profileRes.data?.activity_seen_at ?? null
  const unread = seenAt
    ? items.filter(i => new Date(i.created_at).getTime() > new Date(seenAt).getTime()).length
    : 0

  return NextResponse.json({ unread, items })
}

// POST /api/notifications — mark all as seen (the bell was opened)
export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const markSeen = () => supabaseAdmin
    .from('profiles')
    .update({ activity_seen_at: new Date().toISOString() })
    .eq('id', userId)

  let { error } = await markSeen()
  // Same deploy-beats-migration race as the GET — heal the column and retry
  // rather than 500ing every time the user opens the bell.
  if (error && isMissingActivitySeenColumn(error) && await ensureActivitySeenColumn()) {
    ({ error } = await markSeen())
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
