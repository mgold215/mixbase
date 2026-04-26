import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { verifyProjectOwner, verifyVersionOwner } from '@/lib/ownership'

export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  const body = await request.json()

  const allowed = [
    'title', 'release_date', 'project_id', 'genre', 'label', 'isrc', 'notes', 'final_version_id',
    'mixing_done', 'mastering_done', 'artwork_ready', 'dsp_submitted', 'social_posts_done', 'press_release_done',
    'dsp_spotify', 'dsp_apple_music', 'dsp_tidal', 'dsp_bandcamp', 'dsp_soundcloud', 'dsp_youtube', 'dsp_amazon',
  ] as const
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  for (const key of allowed) {
    if (key in body) patch[key] = body[key]
  }

  if ('project_id' in patch && patch.project_id && !await verifyProjectOwner(String(patch.project_id), userId)) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }
  const version = patch.final_version_id ? await verifyVersionOwner(String(patch.final_version_id), userId) : null
  if (patch.final_version_id && !version) {
    return NextResponse.json({ error: 'Version not found' }, { status: 404 })
  }
  if (patch.project_id && version && version.project_id !== patch.project_id) {
    return NextResponse.json({ error: 'final_version_id must belong to project_id' }, { status: 400 })
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
  const { error } = await supabaseAdmin
    .from('mb_releases')
    .delete()
    .eq('id', id)
    .eq('user_id', userId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
