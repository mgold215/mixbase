import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// GET /api/feed — all versions open for community feedback
export async function GET() {
  const { data, error } = await supabaseAdmin
    .from('mf_versions')
    .select(`
      id, version_number, label, audio_url, audio_filename,
      duration_seconds, status, feedback_context, created_at,
      open_for_feedback,
      mf_projects ( id, title, artwork_url, genre, bpm ),
      mf_feedback ( id, producer_handle, tags, comment, rating, timestamp_seconds, created_at, is_community )
    `)
    .eq('open_for_feedback', true)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}
