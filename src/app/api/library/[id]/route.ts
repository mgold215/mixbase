import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { isUuid } from '@/lib/validators'
import { ownsProject } from '@/lib/ownership'

// Edit / remove one released-library track. PATCH covers the hand-corrections
// the sync can't know: pasting an ISRC DistroKid just assigned, or linking the
// track to the mixBASE project that holds its original audio file.
export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  if (!isUuid(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

  // project_id must be a project the caller owns — GET joins mb_projects
  // through the RLS-bypassing service client (same IDOR guard as releases).
  if (body.project_id != null && (!isUuid(body.project_id) || !await ownsProject(body.project_id, userId))) {
    return NextResponse.json({ error: 'Invalid project_id' }, { status: 400 })
  }

  const allowed = ['title', 'artist_name', 'isrc', 'upc', 'release_title', 'release_date', 'release_type', 'project_id'] as const
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  for (const key of allowed) {
    if (key in body) patch[key] = body[key]
  }

  const { data, error } = await supabaseAdmin
    .from('mb_library_tracks')
    .update(patch)
    .eq('id', id)
    .eq('user_id', userId)
    .select('*, mb_projects(title)')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  if (!isUuid(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  const { error } = await supabaseAdmin
    .from('mb_library_tracks')
    .delete()
    .eq('id', id)
    .eq('user_id', userId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
