import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// POST /api/collections/[id]/items — add a project to a collection
export async function POST(request: NextRequest, ctx: RouteContext<'/api/collections/[id]/items'>) {
  const { id } = await ctx.params
  const body = await request.json()
  const { project_id, position } = body

  // project_id is required
  if (!project_id) {
    return NextResponse.json({ error: 'project_id is required' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin
    .from('mb_collection_items')
    .insert({ collection_id: id, project_id, position: position ?? 0 })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Touch the collection's updated_at timestamp
  await supabaseAdmin
    .from('mb_collections')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', id)

  return NextResponse.json(data, { status: 201 })
}

// DELETE /api/collections/[id]/items?itemId=xxx — remove an item from a collection
export async function DELETE(request: NextRequest, ctx: RouteContext<'/api/collections/[id]/items'>) {
  const { id } = await ctx.params
  const itemId = request.nextUrl.searchParams.get('itemId')

  if (!itemId) {
    return NextResponse.json({ error: 'itemId query param is required' }, { status: 400 })
  }

  const { error } = await supabaseAdmin
    .from('mb_collection_items')
    .delete()
    .eq('id', itemId)
    .eq('collection_id', id) // scoped to this collection for safety

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Touch the collection's updated_at timestamp
  await supabaseAdmin
    .from('mb_collections')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', id)

  return NextResponse.json({ ok: true })
}

// PATCH /api/collections/[id]/items — reorder items by updating positions
// Body: { items: [{ id: "item-uuid", position: 0 }, { id: "item-uuid", position: 1 }, ...] }
export async function PATCH(request: NextRequest, ctx: RouteContext<'/api/collections/[id]/items'>) {
  const { id } = await ctx.params
  const body = await request.json()
  const { items } = body

  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json({ error: 'items array is required' }, { status: 400 })
  }

  // Update each item's position — all scoped to this collection
  const updates = items.map((item: { id: string; position: number }) =>
    supabaseAdmin
      .from('mb_collection_items')
      .update({ position: item.position })
      .eq('id', item.id)
      .eq('collection_id', id)
  )

  const results = await Promise.all(updates)
  const failed = results.find(r => r.error)
  if (failed?.error) {
    return NextResponse.json({ error: failed.error.message }, { status: 500 })
  }

  // Touch the collection's updated_at timestamp
  await supabaseAdmin
    .from('mb_collections')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', id)

  return NextResponse.json({ ok: true })
}
