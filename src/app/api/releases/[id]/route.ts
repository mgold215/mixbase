import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { isUuid } from '@/lib/validators'
import { ownsProject, ownsVersion } from '@/lib/ownership'

export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  if (!isUuid(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

  const allowed = [
    'title', 'release_date', 'project_id', 'genre', 'label', 'isrc', 'notes', 'final_version_id',
    'mixing_done', 'mastering_done', 'artwork_ready', 'dsp_submitted', 'social_posts_done', 'press_release_done',
    'dsp_spotify', 'dsp_apple_music', 'dsp_tidal', 'dsp_bandcamp', 'dsp_soundcloud', 'dsp_youtube', 'dsp_amazon',
  ] as const
  // Re-pointing a release at a project_id/final_version_id the caller doesn't own
  // would leak that resource through the GET join — validate ownership when either
  // is being set (null clears the link and is allowed).
  if (body.project_id != null && (!isUuid(body.project_id) || !await ownsProject(body.project_id, userId))) {
    return NextResponse.json({ error: 'Invalid project_id' }, { status: 400 })
  }
  if (body.final_version_id != null && (!isUuid(body.final_version_id) || !await ownsVersion(body.final_version_id, userId))) {
    return NextResponse.json({ error: 'Invalid final_version_id' }, { status: 400 })
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  for (const key of allowed) {
    if (key in body) patch[key] = body[key]
  }

  const { data, error } = await supabaseAdmin
    .from('mb_releases')
    .update(patch)
    .eq('id', id)
    .eq('user_id', userId)
    .select()
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
    .from('mb_releases')
    .delete()
    .eq('id', id)
    .eq('user_id', userId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
