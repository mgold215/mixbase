import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { isUuid } from '@/lib/validators'
import { ensureCollectionShareToken, isMissingCollectionShareToken } from '@/lib/schema-heal'

// POST /api/collections/[id]/share — return the collection's share token,
// minting one if the row predates the 019 migration's default. Idempotent:
// the token is stable, so repeated calls hand back the same /share/album link.
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  if (!isUuid(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  const fetchToken = () =>
    supabaseAdmin
      .from('mb_collections')
      .select('id, share_token')
      .eq('id', id)
      .eq('user_id', userId)
      .single()

  let { data, error } = await fetchToken()

  // Deploy raced the migration: add the column via the Management API and retry.
  if (error && isMissingCollectionShareToken(error)) {
    await ensureCollectionShareToken()
    ;({ data, error } = await fetchToken())
  }

  if (error || !data) {
    return NextResponse.json({ error: 'Collection not found' }, { status: 404 })
  }

  if (data.share_token) {
    return NextResponse.json({ share_token: data.share_token })
  }

  // Row exists but has no token (created before the column default) — mint one.
  const token = crypto.randomUUID().replace(/-/g, '')
  const { data: updated, error: updateError } = await supabaseAdmin
    .from('mb_collections')
    .update({ share_token: token })
    .eq('id', id)
    .eq('user_id', userId)
    .select('share_token')
    .single()

  if (updateError || !updated?.share_token) {
    return NextResponse.json({ error: 'Could not create share link' }, { status: 500 })
  }
  return NextResponse.json({ share_token: updated.share_token })
}
