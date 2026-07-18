import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { feedCommentLimiter, rateLimitHeaders } from '@/lib/rate-limit'
import { isUuid } from '@/lib/validators'
import { publicArtistName, type FeedComment } from '@/lib/feed'

const MAX_COMMENT_LENGTH = 2000

// POST /api/feed/comments — leave a comment on another artist's upload.
// Authenticated; the commenter identity comes from the middleware-verified
// X-User-Id header, never the request body.
export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const limit = feedCommentLimiter.check(userId)
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Too many comments. Try again later.' }, { status: 429, headers: rateLimitHeaders(limit) })
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  const { version_id, comment } = body

  if (!isUuid(version_id)) {
    return NextResponse.json({ error: 'Valid version_id is required' }, { status: 400 })
  }
  const text = typeof comment === 'string' ? comment.trim() : ''
  if (!text) return NextResponse.json({ error: 'Comment is required' }, { status: 400 })
  if (text.length > MAX_COMMENT_LENGTH) {
    return NextResponse.json({ error: `Comment must be under ${MAX_COMMENT_LENGTH} characters` }, { status: 400 })
  }

  // The version must exist (and gives us the owner for the activity log)
  const { data: version } = await supabaseAdmin
    .from('mb_versions')
    .select('id, project_id, version_number, mb_projects!inner(title, user_id)')
    .eq('id', version_id)
    .single()
  if (!version) return NextResponse.json({ error: 'Track not found' }, { status: 404 })

  const { data, error } = await supabaseAdmin
    .from('mb_feed_comments')
    .insert({ version_id, user_id: userId, comment: text })
    .select('id, version_id, user_id, comment, created_at')
    .single()
  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? 'Failed to save comment' }, { status: 500 })
  }

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('artist_name, display_name')
    .eq('id', userId)
    .single()
  const artist = publicArtistName(profile)

  // Surface the comment in the track owner's activity feed (best-effort)
  const proj = Array.isArray(version.mb_projects) ? version.mb_projects[0] : version.mb_projects
  const ownerId = (proj as { user_id?: string } | null)?.user_id ?? null
  if (ownerId && ownerId !== userId) {
    await supabaseAdmin.from('mb_activity').insert({
      type: 'feedback_received',
      project_id: version.project_id,
      version_id,
      user_id: ownerId,
      description: `Feed comment from ${artist} on v${version.version_number}`,
    })
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
