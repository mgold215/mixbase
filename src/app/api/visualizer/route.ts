import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// GET /api/visualizer — every saved video the user owns (mb_visualizers),
// newest first. Powers the "Choose from Media" picker on the project page, so
// a loop generated for one song can be pinned to another. Deliberately the
// same set the Media tab lists — including finished YouTube/Shorts renders:
// anything in the library is pinnable (the player loops it muted), and
// filtering them out made videos visible in Media mysteriously absent here.
export async function GET(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await supabaseAdmin
    .from('mb_visualizers')
    .select('id, video_url, title, kind, project_id, source_image_url, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(200)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data ?? [])
}
