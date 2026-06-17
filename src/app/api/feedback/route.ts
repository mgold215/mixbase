import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { feedbackLimiter, ipKey, rateLimitHeaders } from '@/lib/rate-limit'
import { isUuid } from '@/lib/validators'

// POST /api/feedback — submit feedback for a shared version (public route)
export async function POST(request: NextRequest) {
  const limit = feedbackLimiter.check(ipKey(request))
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Too many requests. Try again later.' }, { status: 429, headers: rateLimitHeaders(limit) })
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  const { version_id, reviewer_name, rating, comment } = body

  if (!version_id || !comment?.trim()) {
    return NextResponse.json({ error: 'version_id and comment are required' }, { status: 400 })
  }

  // Public endpoint — validate the id shape before it reaches a DB insert/lookup so a
  // malformed value can't surface a raw Postgres error message to an anonymous caller.
  if (!isUuid(version_id)) {
    return NextResponse.json({ error: 'Valid version_id is required' }, { status: 400 })
  }

  // Rating is optional, but if present it must be a whole number 1–5 — the UI
  // renders it as stars. This is a public route, so don't trust the value.
  if (rating != null && (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5)) {
    return NextResponse.json({ error: 'Rating must be a whole number from 1 to 5' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin
    .from('mb_feedback')
    .insert({
      version_id,
      reviewer_name: reviewer_name?.trim() || 'Anonymous',
      rating: rating || null,
      comment: comment.trim(),
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Fetch the version + project owner for the activity log
  const { data: version } = await supabaseAdmin
    .from('mb_versions')
    .select('project_id, version_number, mb_projects!inner(user_id)')
    .eq('id', version_id)
    .single()

  if (version) {
    const proj = version.mb_projects
    const projectUserId: string | null = Array.isArray(proj)
      ? (proj[0]?.user_id ?? null)
      : ((proj as { user_id: string } | null)?.user_id ?? null)
    await supabaseAdmin.from('mb_activity').insert({
      type: 'feedback_received',
      project_id: version.project_id,
      version_id,
      user_id: projectUserId,
      description: `Feedback from ${reviewer_name || 'Anonymous'} on v${version.version_number}`,
    })
  }

  return NextResponse.json(data, { status: 201 })
}
