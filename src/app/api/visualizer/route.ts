import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// GET /api/visualizer — the user's saved visualizer loops across ALL projects,
// newest first. Powers the "Choose from Media" picker on the project page, so
// a loop generated for one song can be pinned to another. Only real loops
// (free canvas renders + Runway AI) — finished YouTube/Shorts videos are
// derived outputs, not pinnable visualizers.
export async function GET(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await supabaseAdmin
    .from('mb_visualizers')
    .select('id, video_url, title, kind, project_id, source_image_url, created_at')
    .eq('user_id', userId)
    .in('kind', ['free', 'ai'])
    .order('created_at', { ascending: false })
    .limit(200)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data ?? [])
}
