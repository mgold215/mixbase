import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// GET — the user's submission log (newest first).
export async function GET(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await supabaseAdmin
    .from('sb_submissions')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

// POST — log one submission (a song pitched to a curator).
export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const { project_id, version_id, curator_id, channel, message, share_url } = body
  if (!curator_id) return NextResponse.json({ error: 'curator_id required' }, { status: 400 })

  const { data, error } = await supabaseAdmin
    .from('sb_submissions')
    .insert({
      user_id: userId,
      project_id: project_id ?? null,
      version_id: version_id ?? null,
      curator_id,
      channel: channel ?? null,
      message: message ?? null,
      share_url: share_url ?? null,
      status: 'sent',
      sent_at: new Date().toISOString(),
    })
    .select()
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Best-effort: bump last_contacted on the user's OWN curator rows (shared
  // rows are scoped out by user_id and simply no-op).
  await supabaseAdmin
    .from('sb_curators')
    .update({ last_contacted: new Date().toISOString() })
    .eq('id', curator_id)
    .eq('user_id', userId)

  return NextResponse.json(data, { status: 201 })
}
