import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { CatalogError } from '@/lib/catalog'
import { catalogLimiter, checkUserLimit, rateLimitHeaders } from '@/lib/rate-limit'
import { syncLibraryForUser, withLibraryHeal, LibraryReadError } from '@/lib/library-sync'

// The released-track library: the artist's already-out discography (ISRC,
// UPC, dates) kept separate from the pipeline board. GET lists it; POST
// syncs it from Spotify/Deezer (upsert — safe to re-run as new drops land).
// The release-day ISRC check runs the same sync on its own (release-isrc-job.ts).

export async function GET(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await withLibraryHeal(() => supabaseAdmin
    .from('mb_library_tracks')
    .select('*, mb_projects(title)')
    .eq('user_id', userId)
    .order('release_date', { ascending: false, nullsFirst: false })
    .limit(1000))

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data ?? [])
}

export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  const artist = typeof body.artist === 'string' ? body.artist.trim() : ''
  if (!artist || artist.length > 200) {
    return NextResponse.json({ error: 'artist (name or Spotify artist link) is required' }, { status: 400 })
  }

  const rl = await checkUserLimit(catalogLimiter, userId)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many catalog lookups — try again later' },
      { status: 429, headers: rateLimitHeaders(rl) },
    )
  }

  try {
    const result = await syncLibraryForUser(userId, artist)
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    if (e instanceof LibraryReadError) return NextResponse.json({ error: e.message }, { status: 500 })
    catalogLimiter.rollback(userId) // failed lookup did no lasting work
    if (e instanceof CatalogError) return NextResponse.json({ error: e.message }, { status: e.status })
    return NextResponse.json({ error: 'Catalog lookup failed — please try again' }, { status: 502 })
  }
}
