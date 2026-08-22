import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { isUuid, isJsonObject, isSupabaseStorageUrl } from '@/lib/validators'

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  if (!isUuid(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

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
    .limit(500)

  return NextResponse.json({
    collection: collectionRes.data,
    items: itemsRes.data ?? [],
  })
}

export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  if (!isUuid(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  const body = await request.json().catch(() => null)
  if (!isJsonObject(body)) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  const updates: Record<string, string | null> = {}
  if (typeof body.title === 'string' && body.title.trim()) updates.title = body.title.trim()

  // cover_url is a SURVIVOR-SCAN column (ASSET_URL_COLUMNS, project-assets.ts).
  // The delete paths parse it to decide which storage objects are still in use,
  // so an uncanonical value here does not just render a broken image — it
  // corrupts the answer to "may I delete these bytes?". This write site had NO
  // validation at all: not a host check, not even a type check.
  //
  // Same gate as PATCH /api/projects/[id]'s artwork_url (projects/[id]/route.ts),
  // and null stays legal so a cover can still be cleared.
  if ('cover_url' in body) {
    if (body.cover_url !== null && !isSupabaseStorageUrl(body.cover_url)) {
      return NextResponse.json({ error: 'cover_url must be a Supabase storage URL' }, { status: 400 })
    }
    updates.cover_url = body.cover_url as string | null
  }
  if (body.type !== undefined) {
    // Typed rather than trusted: with `body` correctly typed as
    // Record<string, unknown>, `type` is `unknown` and the compiler refuses the
    // allow-list check outright. That refusal is the point — the old code read
    // `body` as `any`, so a number or object sailed through `includes()` and was
    // written to the column. The allow-list is now the ONLY way past.
    const allowedTypes = ['playlist', 'ep', 'album'] as const
    if (typeof body.type !== 'string' || !(allowedTypes as readonly string[]).includes(body.type)) {
      return NextResponse.json({ error: `Type must be one of: ${allowedTypes.join(', ')}` }, { status: 400 })
    }
    updates.type = body.type
  }

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
  if (!isUuid(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  const { error } = await supabaseAdmin
    .from('mb_collections')
    .delete()
    .eq('id', id)
    .eq('user_id', userId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
