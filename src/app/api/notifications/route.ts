import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { ensureActivitySeenColumn, isMissingActivitySeenColumn } from '@/lib/schema-heal'
import {
  NOTIFICATION_TYPES,
  classifyActivitySource,
  clampDescription,
  type NotificationSource,
} from '@/lib/notifications'

export type NotificationItem = {
  id: string
  description: string | null
  project_id: string | null
  /** The version the note was left on. A HINT — mb_activity.version_id has no
   *  FK, so the version may since have been deleted. Clients must tolerate a
   *  miss rather than assuming it resolves. */
  version_id: string | null
  /** Which surface produced this — drives the icon/label, never the link. */
  source: NotificationSource
  created_at: string
}

/** Row shape as stored, before classification. */
type ActivityRow = {
  id: string
  description: string | null
  project_id: string | null
  version_id: string | null
  type: string | null
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
      // version_id lets the client deep-link to the exact mix the note is on.
      // type is what distinguishes share feedback from a feed comment; both
      // sources wrote 'feedback_received' before the discriminator landed, so
      // match BOTH values or feed comments would silently vanish from the bell.
      .select('id, description, project_id, version_id, type, created_at')
      .eq('user_id', userId)
      .in('type', NOTIFICATION_TYPES)
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

  // Classify + clamp before the payload leaves the server. reviewer_name was
  // unbounded on the public /api/feedback route until recently, so rows already
  // in the database can carry an arbitrarily long description — and the bell
  // re-fetches this every 60 seconds on every authenticated page.
  const items: NotificationItem[] = ((itemsRes.data ?? []) as ActivityRow[]).map(r => ({
    id: r.id,
    description: clampDescription(r.description),
    project_id: r.project_id,
    version_id: r.version_id ?? null,
    source: classifyActivitySource(r),
    created_at: r.created_at,
  }))
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
