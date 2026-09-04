import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, MIX_NOTE_AUTHOR } from '@/lib/supabase'
import { checkUserLimit, mixNoteLimiter, rateLimitHeaders } from '@/lib/rate-limit'
import { isUuid, isJsonObject } from '@/lib/validators'

// Same cap as MAX_COMMENT_LENGTH on the public feedback route — both write the
// same unbounded `text` column, and the owner's notes deserve the same bound as
// a stranger's.
const MAX_NOTE_LENGTH = 2000

// POST /api/mix-notes — jot a (usually timestamped) note on your own mix while
// listening in the player.
//
// Writes the same mb_feedback table the share page writes, so a note picks up
// every feature feedback already has — the project-page list, the scrubber
// markers, the punch-list export, the AI summary — with no parallel table. What
// it deliberately does NOT share with POST /api/feedback:
//   • it is authenticated and owner-only (that route is public + IP-limited)
//   • reviewer_name is a fixed label, never caller-supplied, so self-notes stay
//     visually distinct from listener feedback everywhere the byline renders
//   • it logs no mb_activity row — your own note must not ring your own
//     notification bell
export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body: unknown = await request.json().catch(() => null)
  if (!isJsonObject(body)) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  const { version_id, comment, timestamp_seconds } = body

  const commentText = typeof comment === 'string' ? comment.trim() : ''
  if (!commentText) {
    return NextResponse.json({ error: 'comment is required' }, { status: 400 })
  }
  if (commentText.length > MAX_NOTE_LENGTH) {
    return NextResponse.json({ error: `Note must be under ${MAX_NOTE_LENGTH} characters` }, { status: 400 })
  }
  if (!isUuid(version_id)) {
    return NextResponse.json({ error: 'Valid version_id is required' }, { status: 400 })
  }

  // Same rules the public route pins for a playback position: finite,
  // non-negative, whole seconds, capped at 24h so a bogus value can't push a
  // marker off the end of the scrubber.
  let ts: number | null = null
  if (timestamp_seconds != null) {
    if (typeof timestamp_seconds !== 'number' || !Number.isFinite(timestamp_seconds) || timestamp_seconds < 0) {
      return NextResponse.json({ error: 'timestamp_seconds must be a non-negative number' }, { status: 400 })
    }
    ts = Math.min(Math.floor(timestamp_seconds), 86400)
  }

  // After the body validation above, before the ownership read below — a
  // malformed request must not cost a credit, and a credit must be held before
  // any query runs (the ordering the visualizer routes pin).
  const rl = await checkUserLimit(mixNoteLimiter, userId)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many notes — try again later' },
      { status: 429, headers: rateLimitHeaders(rl) },
    )
  }

  // Owner-only: the version must belong to one of the caller's projects.
  const { data: version } = await supabaseAdmin
    .from('mb_versions')
    .select('id, mb_projects!inner(user_id)')
    .eq('id', version_id)
    .eq('mb_projects.user_id', userId)
    .single()

  if (!version) {
    // The window counts work performed, not rejected attempts.
    mixNoteLimiter.rollback(userId)
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const { data, error } = await supabaseAdmin
    .from('mb_feedback')
    .insert({
      version_id,
      reviewer_name: MIX_NOTE_AUTHOR,
      rating: null,
      comment: commentText,
      timestamp_seconds: ts,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data, { status: 201 })
}
