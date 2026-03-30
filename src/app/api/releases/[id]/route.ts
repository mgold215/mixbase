import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET(_req: NextRequest, ctx: RouteContext<'/api/releases/[id]'>) {
  const { id } = await ctx.params

  const { data, error } = await supabaseAdmin
    .from('mf_releases')
    .select('*, mf_projects(id, title, artwork_url, genre, bpm, key_signature), mf_versions(id, version_number, label, audio_url, audio_filename, status, created_at)')
    .eq('id', id)
    .single()

  if (error) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(data)
}

export async function PATCH(request: NextRequest, ctx: RouteContext<'/api/releases/[id]'>) {
  const { id } = await ctx.params
  const body = await request.json()

  const { data, error } = await supabaseAdmin
    .from('mf_releases')
    .update({ ...body, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function DELETE(_req: NextRequest, ctx: RouteContext<'/api/releases/[id]'>) {
  const { id } = await ctx.params
  const { error } = await supabaseAdmin.from('mf_releases').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
