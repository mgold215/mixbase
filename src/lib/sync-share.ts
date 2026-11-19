import { cache } from 'react'
import { supabaseAdmin, displayArtworkUrl } from '@/lib/supabase'
import { publicArtistName } from '@/lib/display-name'
import { ensureCollectionSyncColumn, isMissingCollectionSyncColumn } from '@/lib/schema-heal'
import { isSyncCatalog, type SyncCatalogData, type SyncTrack } from '@/lib/sync-catalog'

// The public SYNC CATALOG: mixbase.app/sync/<token> (migration 047).
//
// A collection the artist has marked is_sync, laid out for a music supervisor:
// per track the BPM, key, genre and length, the full mix and the instrumental,
// a download of each, and the rights line. Anything a collection without the
// flag would expose here is refused: the loader returns null and the page 404s,
// so an ordinary /album/... link can't be turned into a download page by
// rewriting its path.
//
// Public page: every select names its columns, never `*` (sync-share-test.mjs
// locks the lists). Unlike the /share and /album pages, BPM and key ARE meant
// to be public here: they are what a supervisor filters a brief by.

const COLLECTION_SYNC_COLS = 'id, user_id, title, cover_url, is_sync'
const PROJECT_SYNC_COLS = 'title, genre, bpm, key_signature, artwork_url, finalized_artwork_url, instrumental_url'
const VERSION_SYNC_COLS = 'project_id, audio_url, duration_seconds, version_number'

type ProjectRow = {
  title: string | null
  genre: string | null
  bpm: number | null
  key_signature: string | null
  artwork_url: string | null
  finalized_artwork_url: string | null
  instrumental_url: string | null
}

export const getSyncCatalogData = cache(async (token: string): Promise<SyncCatalogData | null> => {
  if (!token || token.length > 128) return null

  const fetchCollection = () =>
    supabaseAdmin.from('mb_collections').select(COLLECTION_SYNC_COLS).eq('share_token', token).maybeSingle()

  let res = await fetchCollection()
  if (res.error && isMissingCollectionSyncColumn(res.error)) {
    await ensureCollectionSyncColumn()
    res = await fetchCollection()
  }
  if (res.error) {
    console.error('[sync] collection lookup failed:', res.error.message)
    return null
  }
  const collection = res.data
  if (!collection || !isSyncCatalog(collection)) return null

  const items = await supabaseAdmin
    .from('mb_collection_items')
    .select(`project_id, position, mb_projects(${PROJECT_SYNC_COLS})`)
    .eq('collection_id', collection.id)
    .order('position', { ascending: true })
  if (items.error) {
    console.error('[sync] items lookup failed:', items.error.message)
    return null
  }
  const rows = items.data ?? []
  const projectIds = rows.map(r => r.project_id)

  // Newest mix per song: the catalog always offers the current master.
  const latest = new Map<string, { audio_url: string; duration_seconds: number | null }>()
  if (projectIds.length > 0) {
    const versions = await supabaseAdmin
      .from('mb_versions')
      .select(VERSION_SYNC_COLS)
      .in('project_id', projectIds)
      .order('version_number', { ascending: false })
    if (versions.error) {
      console.error('[sync] versions lookup failed:', versions.error.message)
      return null
    }
    for (const v of versions.data ?? []) {
      if (!latest.has(v.project_id) && v.audio_url) latest.set(v.project_id, v)
    }
  }

  let artistName = 'mixBASE'
  if (collection.user_id) {
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('artist_name, display_name')
      .eq('id', collection.user_id)
      .maybeSingle()
    if (profile) artistName = publicArtistName(profile, 'mixBASE')
  }

  const tracks: SyncTrack[] = rows.flatMap(row => {
    // supabase-js types the to-one join as an array; at runtime it's an object.
    const p = row.mb_projects as unknown as ProjectRow | null
    const v = latest.get(row.project_id)
    if (!p || !v) return []
    return [{
      id: row.project_id,
      title: p.title ?? 'Untitled',
      genre: p.genre ?? null,
      bpm: typeof p.bpm === 'number' && p.bpm > 0 ? Math.round(p.bpm) : null,
      key: p.key_signature?.trim() || null,
      duration: v.duration_seconds ?? null,
      artworkUrl: displayArtworkUrl(p),
      audioUrl: v.audio_url,
      instrumentalUrl: p.instrumental_url ?? null,
    }]
  })

  const coverUrl = collection.cover_url ?? tracks.find(t => t.artworkUrl)?.artworkUrl ?? null
  return { title: collection.title as string, artistName, coverUrl, tracks }
})
