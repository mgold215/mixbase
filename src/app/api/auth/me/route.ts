import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { ensureProfileSocialColumns, isMissingProfileSocialColumn } from '@/lib/schema-heal'
import { isHttpUrl } from '@/lib/social-links'

const PROFILE_COLS = 'artist_name, display_name, spotify_url, youtube_url'

// GET /api/auth/me — return the authenticated user's email + profile
export async function GET(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const { data: { user }, error } = await supabaseAdmin.auth.admin.getUserById(userId)
  if (error || !user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const readProfile = () => supabaseAdmin
    .from('profiles')
    .select(PROFILE_COLS)
    .eq('id', userId)
    .maybeSingle()

  let { data: profile, error: profErr } = await readProfile()
  // A deploy can beat migration 021 to production — heal the columns and retry
  // so the whole select doesn't fail on the missing spotify_url/youtube_url.
  if (profErr && isMissingProfileSocialColumn(profErr) && await ensureProfileSocialColumns()) {
    ({ data: profile, error: profErr } = await readProfile())
  }

  const p = profile as { artist_name?: string; display_name?: string; spotify_url?: string; youtube_url?: string } | null
  return NextResponse.json({
    email: user.email,
    artist_name: p?.artist_name ?? '',
    display_name: p?.display_name ?? '',
    spotify_url: p?.spotify_url ?? '',
    youtube_url: p?.youtube_url ?? '',
  })
}

// PATCH /api/auth/me — update profile fields
export async function PATCH(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  const updates: Record<string, string> = {}
  if (typeof body.artist_name === 'string') updates.artist_name = body.artist_name.trim()
  if (typeof body.display_name === 'string') updates.display_name = body.display_name.trim()

  // Social links: accept a valid http(s) URL, or an empty string to clear the
  // override (submissions then fall back to the name-search link). Reject any
  // other non-empty value so a malformed link never lands in a stored, sent field.
  for (const key of ['spotify_url', 'youtube_url'] as const) {
    if (typeof body[key] === 'string') {
      const trimmed = body[key].trim()
      if (trimmed && !isHttpUrl(trimmed)) {
        return NextResponse.json({ error: `${key === 'spotify_url' ? 'Spotify' : 'YouTube'} link must be a valid URL` }, { status: 400 })
      }
      updates[key] = trimmed
    }
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }

  const runUpsert = () => supabaseAdmin
    .from('profiles')
    .upsert({ id: userId, ...updates }, { onConflict: 'id' })

  let { error } = await runUpsert()
  if (error && isMissingProfileSocialColumn(error) && await ensureProfileSocialColumns()) {
    ({ error } = await runUpsert())
  }

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
