import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { isUuid } from '@/lib/validators'

// Verify the collection belongs to this user — returns false if not found/unauthorized
async function ownsCollection(collectionId: string, userId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('mb_collections')
    .select('id')
    .eq('id', collectionId)
    .eq('user_id', userId)
    .single()
  return !!data
}

// Verify the project belongs to this user — returns false if not found/unauthorized
async function ownsProject(projectId: string, userId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('mb_projects')
    .select('id')
    .eq('id', projectId)
    .eq('user_id', userId)
    .single()
  return !!data
}

// POST /api/collections/[id]/items — add a project to a collection
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  if (!isUuid(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  if (!await ownsCollection(id, userId)) {
    return NextResponse.json({ error: 'Collection not found' }, { status: 404 })
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  const { project_id, position } = body

  // Validate the id shape before it reaches a DB write.
  if (!isUuid(project_id)) {
    return NextResponse.json({ error: 'Valid project_id is required' }, { status: 400 })
  }

  // Ownership check: the collection GET reads each item back joined with its
  // project's title/artwork/genre. Without this an authed user could attach
  // another user's project to their own collection and read those fields out
  // of it (cross-user disclosure / IDOR).
  if (!await ownsProject(project_id, userId)) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  const { data, error } = await supabaseAdmin
    .from('mb_collection_items')
    .insert({ collection_id: id, project_id, position: position ?? 0 })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await supabaseAdmin
    .from('mb_collections')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', id)

  return NextResponse.json(data, { status: 201 })
}

// DELETE /api/collections/[id]/items?itemId=xxx
export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  if (!isUuid(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  if (!await ownsCollection(id, userId)) {
    return NextResponse.json({ error: 'Collection not found' }, { status: 404 })
  }

  const itemId = request.nextUrl.searchParams.get('itemId')
  if (!itemId) {
    return NextResponse.json({ error: 'itemId query param is required' }, { status: 400 })
  }

  const { error } = await supabaseAdmin
    .from('mb_collection_items')
    .delete()
    .eq('id', itemId)
    .eq('collection_id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await supabaseAdmin
    .from('mb_collections')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', id)

  return NextResponse.json({ ok: true })
}

// PATCH /api/collections/[id]/items — reorder items
export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  if (!isUuid(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  if (!await ownsCollection(id, userId)) {
    return NextResponse.json({ error: 'Collection not found' }, { status: 404 })
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  const { items } = body

  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json({ error: 'items array is required' }, { status: 400 })
  }
  // Cap the batch so a client can't fan out an unbounded number of concurrent
  // writes, and validate each entry: a non-UUID item.id would otherwise reach
  // the DB and surface a Postgres cast error as an opaque 500.
  if (items.length > 500) {
    return NextResponse.json({ error: 'Too many items (max 500)' }, { status: 400 })
  }
  const valid = items.every(
    (item: { id?: unknown; position?: unknown }) =>
      isUuid(item?.id) && typeof item?.position === 'number' && Number.isFinite(item.position)
  )
  if (!valid) {
    return NextResponse.json({ error: 'Each item needs a valid id and numeric position' }, { status: 400 })
  }

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

  await supabaseAdmin
    .from('mb_collections')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', id)

  return NextResponse.json({ ok: true })
}
