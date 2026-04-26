import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params

  const collectionRes = await supabaseAdmin
    .from('mb_collections')
    .select('*')
    .eq('id', id)
    .eq('user_id', userId)
    .single()

  if (collectionRes.error) {
    return NextResponse.json({ error: 'Collection not found' }, { status: 404 })
  }

  const itemsRes = await supabaseAdmin
    .from('mb_collection_items')
    .select('*, mb_projects(title, artwork_url, genre)')
    .eq('collection_id', id)
    .order('position', { ascending: true })

  return NextResponse.json({
    collection: collectionRes.data,
    items: itemsRes.data ?? [],
  })
}

export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  const body = await request.json()
  const updates: Record<string, string> = {}
  if (body.title?.trim()) updates.title = body.title.trim()
  if ('cover_url' in body) updates.cover_url = body.cover_url

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin
    .from('mb_collections')
    .update({ ...updates, updated_at: new Date().toISOString() })
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
    .from('mb_collections')
    .delete()
    .eq('id', id)
    .eq('user_id', userId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
