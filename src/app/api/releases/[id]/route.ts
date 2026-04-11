import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function PATCH(request: NextRequest, ctx: RouteContext<'/api/releases/[id]'>) {
  const { id } = await ctx.params
  const body = await request.json()

  const { data, error } = await supabaseAdmin
    .from('mb_releases')
    .update({ ...body, updated_at: new Date().toISOString() })
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
