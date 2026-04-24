import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'

// GET /api/collections/[id] — get one collection with its items (joined to projects)
export async function GET(_req: NextRequest, ctx: RouteContext<'/api/collections/[id]'>) {
  const supabase = await createClient()
  const { id } = await ctx.params

  // Fetch the collection itself
  const collectionRes = await supabase
    .from('mb_collections')
    .select('*')
    .eq('id', id)
    .single()

  if (collectionRes.error) {
    return NextResponse.json({ error: 'Collection not found' }, { status: 404 })
  }

  // Fetch items joined with project data, ordered by position
  const itemsRes = await supabase
    .from('mb_collection_items')
    .select('*, mb_projects(title, artwork_url, genre)')
    .eq('collection_id', id)
    .order('position', { ascending: true })

  return NextResponse.json({
    collection: collectionRes.data,
    items: itemsRes.data ?? [],
  })
}

// PATCH /api/collections/[id] — update title and/or cover_url
export async function PATCH(request: NextRequest, ctx: RouteContext<'/api/collections/[id]'>) {
  const supabase = await createClient()
  const { id } = await ctx.params
  const body = await request.json()
  const updates: Record<string, string> = {}
  if (body.title?.trim()) updates.title = body.title.trim()
  if ('cover_url' in body) updates.cover_url = body.cover_url

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('mb_collections')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

// DELETE /api/collections/[id] — delete a collection (cascade deletes its items)
export async function DELETE(_req: NextRequest, ctx: RouteContext<'/api/collections/[id]'>) {
  const supabase = await createClient()
  const { id } = await ctx.params

  const { error } = await supabase
    .from('mb_collections')
    .delete()
    .eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
