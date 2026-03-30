import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// POST /api/community-feedback — submit producer feedback, award credit
export async function POST(req: NextRequest) {
  const { version_id, producer_handle, tags, comment, timestamp_seconds, rating } = await req.json()

  if (!version_id || !producer_handle) {
    return NextResponse.json({ error: 'version_id and producer_handle required' }, { status: 400 })
  }
  if ((!tags || tags.length === 0) && !comment?.trim()) {
    return NextResponse.json({ error: 'Add at least one tag or a comment' }, { status: 400 })
  }

  // Verify producer exists
  const { data: producer } = await supabaseAdmin
    .from('mf_producers')
    .select('id, credits')
    .eq('handle', producer_handle)
    .single()

  if (!producer) return NextResponse.json({ error: 'Unknown producer handle' }, { status: 404 })

  // Prevent duplicate feedback on same version
  const { data: existing } = await supabaseAdmin
    .from('mf_feedback')
    .select('id')
    .eq('version_id', version_id)
    .eq('producer_handle', producer_handle)
    .single()

  if (existing) return NextResponse.json({ error: 'You already gave feedback on this version' }, { status: 409 })

  // Insert feedback
  const { data: feedback, error: fbError } = await supabaseAdmin
    .from('mf_feedback')
    .insert({
      version_id,
      reviewer_name: producer_handle,
      producer_handle,
      tags: tags ?? [],
      comment: comment?.trim() ?? null,
      timestamp_seconds: timestamp_seconds ?? null,
      rating: rating ?? null,
      is_community: true,
    })
    .select()
    .single()

  if (fbError) return NextResponse.json({ error: fbError.message }, { status: 500 })

  // Award +1 credit to the giver
  await supabaseAdmin
    .from('mf_producers')
    .update({ credits: producer.credits + 1 })
    .eq('handle', producer_handle)

  return NextResponse.json({ feedback, new_credits: producer.credits + 1 }, { status: 201 })
}
