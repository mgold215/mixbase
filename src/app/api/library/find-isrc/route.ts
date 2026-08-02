import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { isUuid } from '@/lib/validators'
import { findIsrcViaMusicBrainz } from '@/lib/catalog'
import { catalogLimiter, checkUserLimit, rateLimitHeaders } from '@/lib/rate-limit'

// POST /api/library/find-isrc { track_id } — targeted keyless ISRC lookup via
// MusicBrainz for one library track that Spotify/Deezer didn't cover. Saves
// the hit onto the row and returns it.
export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => null)
  const trackId = body?.track_id
  if (!isUuid(trackId)) return NextResponse.json({ error: 'track_id required' }, { status: 400 })

  const rl = await checkUserLimit(catalogLimiter, userId)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many lookups — try again later' },
      { status: 429, headers: rateLimitHeaders(rl) },
    )
  }

  const { data: track, error } = await supabaseAdmin
    .from('mb_library_tracks')
    .select('id, title, artist_name, isrc')
    .eq('id', trackId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!track) return NextResponse.json({ error: 'Track not found' }, { status: 404 })
  if (!track.artist_name?.trim()) return NextResponse.json({ error: 'Track has no artist name to search by' }, { status: 400 })

  try {
    const isrc = await findIsrcViaMusicBrainz(track.title, track.artist_name)
    if (!isrc) {
      catalogLimiter.rollback(userId)
      return NextResponse.json({ isrc: null, message: 'No ISRC found on MusicBrainz for this title + artist' })
    }
    const { data, error: saveErr } = await supabaseAdmin
      .from('mb_library_tracks')
      .update({ isrc, updated_at: new Date().toISOString() })
      .eq('id', trackId)
      .eq('user_id', userId)
      .select('*, mb_projects(title)')
      .single()
    if (saveErr) return NextResponse.json({ error: saveErr.message }, { status: 500 })
    return NextResponse.json(data)
  } catch {
    catalogLimiter.rollback(userId)
    return NextResponse.json({ error: 'MusicBrainz lookup failed — please try again' }, { status: 502 })
  }
}
