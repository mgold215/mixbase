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
// the CALLER owns (mb_projects.user_id = X-User-Id), plus the iOS app's own
// artwork uploads, which land at the bucket ROOT as <projectId>-<unixSeconds>.jpg
// — images only, in exactly the shapes /subject accepts (parseSourcePath),
// newest first, at most MAX_PHOTOS. Left out: finalized-* (lettered / filtered
// outputs — the cassette in them is already a composite) and anything over the
// cut-out's size cap. studio/ is never listed (it is not under a project prefix).
// thumb_url is the full image: this project does not use Supabase image
// transforms anywhere, so the client scales it.
//
// Bounded: the MAX_PROJECTS most recently updated projects, listed
// LIST_CONCURRENCY at a time, and at most ROOT_PAGES pages of the bucket root.
// A listing that fails is skipped (this is a picker, not a history — a partial
// grid beats none) unless every one failed.
//
// Owner-only (404 otherwise), like every Cassette Studio route.

const MAX_PROJECTS = 60
const MAX_PHOTOS = 150
const LIST_CONCURRENCY = 6
const ROOT_PAGE = 1000
const ROOT_PAGES = 5

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
    if (!e.name || e.name.startsWith('finalized-')) continue
    const photo = toPhoto(`${project.id}/${e.name}`, e, project)
    if (photo) photos.push(photo)
  }
  return photos
}

/**
 * The iOS app's artwork uploads at the bucket root (<projectId>-<unixSeconds>.jpg),
 * for the caller's projects only. One paginated root listing rather than a call
 * per project: the root holds a folder per project plus these few files.
 */
async function listRootUploads(projects: Map<string, { id: string; title: string | null }>): Promise<Photo[] | null> {
  const photos: Photo[] = []
  for (let page = 0; page < ROOT_PAGES; page++) {
    const { data, error } = await supabaseAdmin.storage
      .from(ARTWORK_BUCKET)
      .list('', { limit: ROOT_PAGE, offset: page * ROOT_PAGE, sortBy: { column: 'name', order: 'asc' } })
    if (error) {
      console.error('[cassette-studio/photos] root listing failed:', error.message)
      return page === 0 ? null : photos
    }
    const rows = (data ?? []) as StorageRow[]
    for (const e of rows) {
      if (!e.name) continue
      const src = parseSourcePath(e.name)
      const project = src && !src.path.includes('/') ? projects.get(src.projectId) : undefined
      if (!project) continue
      const photo = toPhoto(e.name, e, project)
      if (photo) photos.push(photo)
    }
    if (rows.length < ROOT_PAGE) break
  }
  return photos
}

/** A listed object as a picker entry, or null when it is not a usable photo of this project. */
function toPhoto(path: string, e: StorageRow, project: { id: string; title: string | null }): Photo | null {
  if (e.id === null) return null // a folder
  const src = parseSourcePath(path)
  if (!src || src.projectId !== project.id) return null
  const size = e.metadata?.size
  if (typeof size === 'number' && size > MAX_SOURCE_BYTES) return null
  const url = studioPublicUrl(src.path)
  return {
    path: src.path,
    url,
    thumb_url: url,
    project_id: project.id,
    project_title: project.title ?? '',
    created_at: e.created_at ?? null,
  }
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

  const [folderListings, rootListing] = await Promise.all([
    mapLimit(rows, LIST_CONCURRENCY, p => listProjectPhotos(p).catch(err => {
      console.error(`[cassette-studio/photos] listing ${p.id} threw:`, err instanceof Error ? err.message : err)
      return null
    })),
    rows.length === 0 ? Promise.resolve([]) : listRootUploads(new Map(rows.map(r => [r.id, r]))).catch(err => {
      console.error('[cassette-studio/photos] root listing threw:', err instanceof Error ? err.message : err)
      return null
    }),
  ])
  const listings = [...folderListings, rootListing]
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
