import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

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

  const [itemsRes, profileRes] = await Promise.all([
    supabaseAdmin
      .from('mb_activity')
      .select('id, description, project_id, created_at')
      .eq('user_id', userId)
      .eq('type', 'feedback_received')
      .order('created_at', { ascending: false })
      .limit(20),
    supabaseAdmin
      .from('profiles')
      .select('activity_seen_at')
      .eq('id', userId)
      .maybeSingle(),
  ])

  if (itemsRes.error) {
    return NextResponse.json({ error: itemsRes.error.message }, { status: 500 })
  }

  const items = (itemsRes.data ?? []) as NotificationItem[]
  // No cursor yet (pre-migration profile) → treat everything as read rather
  // than flooding the badge with historic activity.
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

  const { error } = await supabaseAdmin
    .from('profiles')
    .update({ activity_seen_at: new Date().toISOString() })
    .eq('id', userId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
