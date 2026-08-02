import { NextRequest, NextResponse } from 'next/server'
import { fetchArtistCatalog, CatalogError } from '@/lib/catalog'
import { catalogLimiter, rateLimitHeaders } from '@/lib/rate-limit'

// GET /api/catalog?artist=<name | Spotify artist URL> — the authenticated
// user's released discography with per-track ISRCs and UPCs, for importing
// past releases into the pipeline and backfilling waterfall re-release ISRCs.
// Public catalog data only (app-token / open APIs) — no Spotify login flow.
export async function GET(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const artist = request.nextUrl.searchParams.get('artist')?.trim()
  if (!artist) return NextResponse.json({ error: 'artist query param required' }, { status: 400 })
  if (artist.length > 200) return NextResponse.json({ error: 'artist query too long' }, { status: 400 })

  const rl = catalogLimiter.check(userId)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many catalog lookups — try again later' },
      { status: 429, headers: rateLimitHeaders(rl) },
    )
  }

  try {
    const catalog = await fetchArtistCatalog(artist)
    return NextResponse.json(catalog)
  } catch (e) {
    // A failed lookup did no lasting work — give the rate-limit credit back.
    catalogLimiter.rollback(userId)
    if (e instanceof CatalogError) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    return NextResponse.json({ error: 'Catalog lookup failed — please try again' }, { status: 502 })
  }
}
