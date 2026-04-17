import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function PATCH(request: NextRequest, ctx: RouteContext<'/api/releases/[id]'>) {
  const { id } = await ctx.params
  const body = await request.json()

  // Only allow updating these fields — prevents clients from overwriting arbitrary columns
  const allowed = [
    'title', 'release_date', 'project_id', 'genre', 'label', 'isrc', 'notes', 'final_version_id',
    'mixing_done', 'mastering_done', 'artwork_ready', 'dsp_submitted', 'social_posts_done', 'press_release_done',
    'dsp_spotify', 'dsp_apple_music', 'dsp_tidal', 'dsp_bandcamp', 'dsp_soundcloud', 'dsp_youtube', 'dsp_amazon',
  ] as const
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  for (const key of allowed) {
    if (key in body) patch[key] = body[key]
  }

  const { data, error } = await supabaseAdmin
    .from('mb_releases')
    .update(patch)
    .eq('id', id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function DELETE(_req: NextRequest, ctx: RouteContext<'/api/releases/[id]'>) {
  const { id } = await ctx.params
  const { error } = await supabaseAdmin.from('mb_releases').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
