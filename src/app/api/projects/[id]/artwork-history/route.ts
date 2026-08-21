import { NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import { supabaseAdmin } from '@/lib/supabase'
import { isUuid } from '@/lib/validators'
import { ARTWORK_BUCKET, listProjectPrefix, storagePathFromUrl } from '@/lib/project-assets'
import type { ListPage, StorageEntry } from '@/lib/video-orphan-plan'
import {
  artworkRestorePatch,
  buildArtworkHistory,
  classifyArtworkKey,
  isRestorableArtworkKey,
  type ArtworkListEntry,
} from '@/lib/artwork-history'
import { artworkHistoryLimiter, checkUserLimit, rateLimitHeaders } from '@/lib/rate-limit'

// Artwork History — see src/lib/artwork-history.ts for WHY this feature exists
// and what it deliberately does not compute.
//
// ── WHY THIS LIVES UNDER /api/projects/ AND NOT /api/artwork/ ────────────────
// `/api/artwork` is in PUBLIC_PATHS (src/proxy.ts:50) so the iOS lock screen
// can fetch cover art cookie-less, and PUBLIC_PATHS is matched with
// startsWith() on the pathname (src/proxy.ts:233). A route at
// `/api/artwork/history` would therefore be PUBLIC — middleware would skip auth
// entirely and never inject X-User-Id, so the ownership check below would have
// nothing to compare against. That is the exact trap the '/api/share/' comment
// in proxy.ts warns about, one prefix over.
//
// Nesting under `/api/projects/[id]/` inherits the authenticated tree instead,
// and is the honest REST shape anyway: this is a projection of one project.

/**
 * List `<projectId>/` in mf-artwork, keeping created_at and size.
 *
 * The walk itself is listProjectPrefix() — the same hardened primitive DELETE
 * /api/projects/[id] uses — precisely because it re-validates the prefix as a
 * UUID and returns null rather than degrading into a bucket-wide listing. That
 * property is worth more than the convenience of writing a bespoke loop here:
 * an unvalidated prefix in THIS route would expose every project's artwork.
 *
 * listProjectPrefix returns names only, so the metadata is captured as a side
 * effect of the page callback it already calls, keyed by full path. No second
 * pass, and no fork of the walk.
 */
async function listArtworkPrefix(projectId: string): Promise<ArtworkListEntry[] | null> {
  const meta = new Map<string, { createdAt: string | null; size: number | null }>()

  const listPage: ListPage = async (prefix, offset, limit) => {
    const { data, error } = await supabaseAdmin.storage
      .from(ARTWORK_BUCKET)
      .list(prefix, { offset, limit })
    if (error) {
      console.error(`[artwork-history] listing ${ARTWORK_BUCKET}/${prefix} failed: ${error.message}`)
      return null
    }
    for (const entry of data ?? []) {
      // `name` is relative to the prefix it was listed under; the full key is
      // what every other layer (columns, keyProjectId, remove()) speaks.
      const size = (entry as { metadata?: { size?: number } | null }).metadata?.size
      meta.set(`${prefix}${entry.name}`, {
        createdAt: entry.created_at ?? null,
        size: typeof size === 'number' ? size : null,
      })
    }
    return (data ?? []) as StorageEntry[]
  }

  const keys = await listProjectPrefix(listPage, projectId)
  if (keys === null) return null

  return keys.map(path => ({
    path,
    createdAt: meta.get(path)?.createdAt ?? null,
    size: meta.get(path)?.size ?? null,
  }))
}

const publicUrl = (path: string) =>
  supabaseAdmin.storage.from(ARTWORK_BUCKET).getPublicUrl(path).data.publicUrl

/**
 * The project row, but only for its owner.
 *
 * Returns null for "not yours OR does not exist" WITHOUT distinguishing them,
 * matching GET /api/projects/[id] (route.ts:50). Both callers below turn that
 * into the same 404, so the route cannot be used to test whether a project id
 * exists on someone else's account.
 */
async function ownedProject(id: string, userId: string) {
  const { data, error } = await supabaseAdmin
    .from('mb_projects')
    .select('id, artwork_url, finalized_artwork_url')
    .eq('id', id)
    .eq('user_id', userId)
    .single()
  return error ? null : data
}

// GET /api/projects/[id]/artwork-history — every artwork image this project has
// ever had, newest first, with the live one flagged rather than hidden.
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  if (!isUuid(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  const limit = await checkUserLimit(artworkHistoryLimiter, userId)
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: rateLimitHeaders(limit) })
  }

  const project = await ownedProject(id, userId)
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const entries = await listArtworkPrefix(id)
  // A PARTIAL listing must not be served as a short history. The whole point of
  // this feature is that images the app could no longer name were assumed gone;
  // answering "you have 2" when the walk died after 2 of 9 recreates that
  // failure in a new place, silently and with a 200. Same fail-loud reasoning as
  // listProjectPrefix returning null instead of a truncated array.
  if (entries === null) {
    return NextResponse.json({ error: 'Could not read artwork history. Try again.' }, { status: 503 })
  }

  const currentPaths = [
    storagePathFromUrl(project.artwork_url, ARTWORK_BUCKET),
    storagePathFromUrl(project.finalized_artwork_url, ARTWORK_BUCKET),
  ]

  return NextResponse.json(
    { items: buildArtworkHistory(entries, publicUrl, currentPaths) },
    { headers: rateLimitHeaders(limit) },
  )
}

// POST /api/projects/[id]/artwork-history { path } — make a past artwork the
// live one again. Never deletes: the image it replaces stays in the bucket and
// is still listed by the GET above, one row further down.
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  if (!isUuid(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  // `JSON.parse('5')` is truthy, so `'path' in body` on a primitive throws a
  // TypeError and the route 500s — the exact defect fixed in PATCH
  // /api/versions/[id] on 2026-08-20. Reject anything that is not an object.
  const body: unknown = await request.json().catch(() => null)
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const { path } = body as { path?: unknown }

  // THE trust boundary. The key must attribute ITSELF to this project — see
  // isRestorableArtworkKey. This is strictly narrower than the PATCH it
  // shortcuts, which accepts any isSupabaseStorageUrl() value and therefore
  // admits another user's object.
  if (!isRestorableArtworkKey(path, id)) {
    return NextResponse.json({ error: 'Invalid artwork path' }, { status: 400 })
  }

  const limit = await checkUserLimit(artworkHistoryLimiter, userId)
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: rateLimitHeaders(limit) })
  }

  const project = await ownedProject(id, userId)
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // The prefix guard proves the key BELONGS here; it does not prove the object
  // EXISTS. Restoring a key that 404s would replace a working cover with a
  // broken image across every listing, share page and feed tile — so confirm
  // against the same listing the GET serves rather than trusting the client to
  // echo back a path we handed it.
  const entries = await listArtworkPrefix(id)
  if (entries === null) {
    return NextResponse.json({ error: 'Could not read artwork history. Try again.' }, { status: 503 })
  }
  if (!entries.some(entry => entry.path === path)) {
    return NextResponse.json({ error: 'That artwork no longer exists' }, { status: 404 })
  }

  const kind = classifyArtworkKey(path)
  const patch = artworkRestorePatch(kind, publicUrl(path))

  const { data, error } = await supabaseAdmin
    .from('mb_projects')
    .update({ ...patch, updated_at: new Date().toISOString() })
    // user_id is re-asserted on the UPDATE itself, not just on the read above.
    // The read is a TOCTOU window; carrying the predicate into the write closes
    // it, and costs nothing.
    .eq('id', id)
    .eq('user_id', userId)
    .select('id, artwork_url, finalized_artwork_url')
    .single()

  if (error || !data) {
    console.error('[artwork-history] restore failed:', error?.message ?? 'no row returned')
    Sentry.captureException(error ?? new Error('artwork restore returned no row'))
    return NextResponse.json({ error: 'Could not restore that artwork. Try again.' }, { status: 503 })
  }

  return NextResponse.json(
    {
      restored: kind,
      artwork_url: data.artwork_url,
      finalized_artwork_url: data.finalized_artwork_url,
    },
    { headers: rateLimitHeaders(limit) },
  )
}
