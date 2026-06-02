import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// Fields the owner may edit on their OWN curators.
const EDITABLE = [
  'name', 'type', 'platform', 'genres', 'contact_method', 'contact_value',
  'audience_size', 'accepts_submissions', 'guidelines', 'confidence', 'source_url', 'notes',
] as const

export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await ctx.params

  const body = await request.json()
  const patch: Record<string, unknown> = {}
  for (const key of EDITABLE) if (key in body) patch[key] = body[key]

  // .eq('user_id', userId) ensures shared (NULL) rows can't be modified.
  const { data, error } = await supabaseAdmin
    .from('sb_curators')
    .update(patch)
    .eq('id', id)
    .eq('user_id', userId)
    .select()
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Not found or not yours' }, { status: 404 })
  return NextResponse.json(data)
}

export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await ctx.params

  const { error } = await supabaseAdmin
    .from('sb_curators')
    .delete()
    .eq('id', id)
    .eq('user_id', userId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
