import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { isUuid } from '@/lib/validators'
import { albumShareUrl } from '@/lib/share-url'
import { ensureCollectionShareToken, isMissingCollectionShareToken } from '@/lib/schema-heal'

// POST /api/collections/[id]/share — return the collection's share token AND
// the canonical share URL (mixbase.app/album/<artist>/<title>/<token>), minting
// a token if the row predates the 019 migration's default. Idempotent: the
// token is stable, so repeated calls hand back the same link. The URL is built
// server-side from the canonical domain — never from the requesting host — so
// links copied from a Railway/staging origin still read mixbase.app.
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  if (!isUuid(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  const fetchToken = () =>
    supabaseAdmin
      .from('mb_collections')
      .select('id, title, share_token')
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

  let token = data.share_token as string | null
  if (!token) {
    // Row exists but has no token (created before the column default) — mint one.
    const minted = crypto.randomUUID().replace(/-/g, '')
    const { data: updated, error: updateError } = await supabaseAdmin
      .from('mb_collections')
      .update({ share_token: minted })
      .eq('id', id)
      .eq('user_id', userId)
      .select('share_token')
      .single()

    if (updateError || !updated?.share_token) {
      return NextResponse.json({ error: 'Could not create share link' }, { status: 500 })
    }
    token = updated.share_token as string
  }

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('artist_name, display_name')
    .eq('id', userId)
    .single()
  const artistName = profile?.artist_name || profile?.display_name || 'mixBASE'

  return NextResponse.json({
    share_token: token,
    url: albumShareUrl(artistName, data.title as string | null, token),
  })
}
