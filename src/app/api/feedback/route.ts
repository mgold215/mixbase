import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// POST /api/feedback — submit feedback for a shared version (public route)
export async function POST(request: NextRequest) {
  const { version_id, reviewer_name, rating, comment } = await request.json()

  if (!version_id || !comment?.trim()) {
    return NextResponse.json({ error: 'version_id and comment are required' }, { status: 400 })
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

  // Fetch the version to get the project_id for the activity log
  const { data: version } = await supabaseAdmin
    .from('mb_versions')
    .select('project_id, version_number')
    .eq('id', version_id)
    .single()

  if (version) {
    await supabaseAdmin.from('mb_activity').insert({
      type: 'feedback_received',
      project_id: version.project_id,
      version_id,
      description: `Feedback from ${reviewer_name || 'Anonymous'} on v${version.version_number}`,
    })
  }

  return NextResponse.json(data, { status: 201 })
}
