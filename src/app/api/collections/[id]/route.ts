import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// GET /api/collections/[id] — get one collection with its items (joined to projects)
export async function GET(_req: NextRequest, ctx: RouteContext<'/api/collections/[id]'>) {
  const { id } = await ctx.params

  // Fetch the collection itself
  const collectionRes = await supabaseAdmin
    .from('mb_collections')
    .select('*')
    .eq('id', id)
    .single()

  if (collectionRes.error) {
    return NextResponse.json({ error: 'Collection not found' }, { status: 404 })
  }

  // Fetch items joined with project data, ordered by position
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

// DELETE /api/collections/[id] — delete a collection (cascade deletes its items)
export async function DELETE(_req: NextRequest, ctx: RouteContext<'/api/collections/[id]'>) {
  const { id } = await ctx.params

  const { error } = await supabaseAdmin
    .from('mb_collections')
    .delete()
    .eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
