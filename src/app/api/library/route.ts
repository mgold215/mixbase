import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { fetchArtistCatalog, flattenCatalogTracks, CatalogError } from '@/lib/catalog'
import { catalogLimiter, rateLimitHeaders } from '@/lib/rate-limit'
import { ensureLibraryTracksTable, isMissingLibraryTracksTable } from '@/lib/schema-heal'

// The released-track library: the artist's already-out discography (ISRC,
// UPC, dates) kept separate from the pipeline board. GET lists it; POST
// syncs it from Spotify/Deezer (upsert — safe to re-run as new drops land).

// Heal-and-retry for the missing-table failure. Even after the heal's DDL
// lands (and its `notify pgrst` fires), PostgREST reloads its schema cache
// asynchronously — an immediate retry can still see PGRST205. Retry a few
// times with a pause so the very first request after a fresh deploy succeeds
// instead of surfacing "table not found in schema cache" to the user.
async function withLibraryHeal<T>(
  run: () => PromiseLike<{ data: T | null; error: { code?: string; message?: string } | null }>,
): Promise<{ data: T | null; error: { code?: string; message?: string } | null }> {
  let res = await run()
  if (res.error && isMissingLibraryTracksTable(res.error) && await ensureLibraryTracksTable()) {
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise(r => setTimeout(r, 1200))
      res = await run()
      if (!res.error || !isMissingLibraryTracksTable(res.error)) break
    }
  }
  return res
}

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

  const rl = catalogLimiter.check(userId)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many catalog lookups — try again later' },
      { status: 429, headers: rateLimitHeaders(rl) },
    )
  }

  let rows
  let source: string
  let artistName: string
  try {
    const catalog = await fetchArtistCatalog(artist)
    rows = flattenCatalogTracks(catalog)
    source = catalog.source
    artistName = catalog.artistName
  } catch (e) {
    catalogLimiter.rollback(userId) // failed lookup did no lasting work
    if (e instanceof CatalogError) return NextResponse.json({ error: e.message }, { status: e.status })
    return NextResponse.json({ error: 'Catalog lookup failed — please try again' }, { status: 502 })
  }

  // Merge into the library: match existing rows by ISRC first (the stable
  // identity), then by title+release for rows that don't have one yet. New
  // facts win over blanks; a manual project link is never touched.
  const { data: existing, error: readErr } = await withLibraryHeal(() => supabaseAdmin
    .from('mb_library_tracks')
    .select('id, title, isrc, release_title, project_id')
    .eq('user_id', userId)
    .limit(1000))
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 })

  const byIsrc = new Map((existing ?? []).filter(r => r.isrc).map(r => [r.isrc as string, r]))
  const byTitle = new Map((existing ?? []).map(r => [`${r.title.trim().toLowerCase()}|${(r.release_title ?? '').trim().toLowerCase()}`, r]))

  // Auto-match each track to the user's project of the same name so the
  // original audio file is one click away in the library.
  const { data: projects } = await supabaseAdmin
    .from('mb_projects')
    .select('id, title')
    .eq('user_id', userId)
    .limit(1000)
  const projectByTitle = new Map((projects ?? []).map(p => [p.title.trim().toLowerCase(), p.id]))

  let created = 0
  let updated = 0
  for (const row of rows) {
    const match = (row.isrc && byIsrc.get(row.isrc))
      || byTitle.get(`${row.title.trim().toLowerCase()}|${row.release_title.trim().toLowerCase()}`)
    const projectId = projectByTitle.get(row.title.trim().toLowerCase()) ?? null

    if (match) {
      const { error } = await supabaseAdmin
        .from('mb_library_tracks')
        .update({
          ...row,
          // Keep an existing manual/auto project link unless we found one now.
          project_id: match.project_id ?? projectId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', match.id)
        .eq('user_id', userId)
      if (!error) updated++
    } else {
      const { error } = await supabaseAdmin
        .from('mb_library_tracks')
        .insert({ ...row, user_id: userId, project_id: projectId })
      if (!error) created++
    }
  }

  return NextResponse.json({ ok: true, source, artistName, created, updated, total: rows.length })
}
