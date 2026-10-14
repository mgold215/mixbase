import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { isAdminIdentity } from '@/lib/admin-identity'
import { ARTWORK_BUCKET } from '@/lib/project-assets'
import { MAX_SOURCE_BYTES, studioPublicUrl } from '@/lib/cassette-server'
import { parseSourcePath } from '@/lib/cassette-studio'

export const runtime = 'nodejs'

// GET /api/cassette-studio/photos
// → { photos: [{ path, url, thumb_url, project_id, project_title, created_at }] }
//
// "From mixBase": the images the artist already uploaded or generated for
// their songs, so a cassette photo that is already in mixBase can be cut out
// (POST /api/cassette-studio/subject { source_path }) without uploading it
// from the phone again.
//
// What is listed: objects directly under mf-artwork/<projectId>/ for projects
// the CALLER owns (mb_projects.user_id = X-User-Id), images only, in exactly
// the shape /subject accepts (parseSourcePath), newest first, at most
// MAX_PHOTOS. Left out: finalized-* (lettered / filtered outputs — the
// cassette in them is already a composite) and anything over the cut-out's
// size cap. studio/ is never listed (it is not under a project prefix).
// thumb_url is the full image: this project does not use Supabase image
// transforms anywhere, so the client scales it.
//
// Bounded: the MAX_PROJECTS most recently updated projects, listed
// LIST_CONCURRENCY at a time. A listing that fails is skipped (this is a
// picker, not a history — a partial grid beats none) unless every one failed.
//
// Owner-only (404 otherwise), like every Cassette Studio route.

const MAX_PROJECTS = 60
const MAX_PHOTOS = 150
const LIST_CONCURRENCY = 6

type Photo = {
  path: string
  url: string
  thumb_url: string
  project_id: string
  project_title: string
  created_at: string | null
}

type StorageRow = { name: string; id: string | null; created_at?: string | null; metadata?: { size?: unknown } | null }

async function listProjectPhotos(project: { id: string; title: string | null }): Promise<Photo[] | null> {
  const { data, error } = await supabaseAdmin.storage
    .from(ARTWORK_BUCKET)
    .list(project.id, { limit: 1000, sortBy: { column: 'created_at', order: 'desc' } })
  if (error) {
    console.error(`[cassette-studio/photos] listing ${project.id} failed:`, error.message)
    return null
  }
  const photos: Photo[] = []
  for (const e of (data ?? []) as StorageRow[]) {
    if (!e.name || e.id === null || e.name.startsWith('finalized-')) continue
    const src = parseSourcePath(`${project.id}/${e.name}`)
    if (!src || src.projectId !== project.id) continue
    const size = e.metadata?.size
    if (typeof size === 'number' && size > MAX_SOURCE_BYTES) continue
    const url = studioPublicUrl(src.path)
    photos.push({
      path: src.path,
      url,
      thumb_url: url,
      project_id: project.id,
      project_title: project.title ?? '',
      created_at: e.created_at ?? null,
    })
  }
  return photos
}

/** Run `fn` over `items`, at most `n` at a time, keeping order. */
async function mapLimit<T, R>(items: readonly T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  return out
}

export async function GET(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!(await isAdminIdentity(userId))) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: projects, error } = await supabaseAdmin
    .from('mb_projects')
    .select('id, title')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(MAX_PROJECTS)
  if (error) {
    console.error('[cassette-studio/photos] projects read failed:', error.message)
    return NextResponse.json({ error: 'Could not load your photos. Please try again.' }, { status: 502 })
  }
  const rows = (projects ?? []) as { id: string; title: string | null }[]

  const listings = await mapLimit(rows, LIST_CONCURRENCY, p => listProjectPhotos(p).catch(err => {
    console.error(`[cassette-studio/photos] listing ${p.id} threw:`, err instanceof Error ? err.message : err)
    return null
  }))
  if (rows.length > 0 && listings.every(l => l === null)) {
    return NextResponse.json({ error: 'Could not load your photos. Please try again.' }, { status: 502 })
  }

  // Newest first; an object with no created_at sorts after every dated one,
  // then by path so the grid order is stable between loads.
  const photos = listings
    .flatMap(l => l ?? [])
    .sort((a, b) => {
      if (a.created_at !== b.created_at) {
        if (a.created_at === null) return 1
        if (b.created_at === null) return -1
        return a.created_at > b.created_at ? -1 : 1
      }
      return a.path < b.path ? 1 : a.path > b.path ? -1 : 0
    })
    .slice(0, MAX_PHOTOS)
  return NextResponse.json({ photos })
}
