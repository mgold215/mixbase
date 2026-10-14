import { NextRequest, NextResponse } from 'next/server'
import sharp from 'sharp'
import { supabaseAdmin } from '@/lib/supabase'
import { canonicalUuid, isJsonObject } from '@/lib/validators'
import { isAdminIdentity } from '@/lib/admin-identity'
import { cassetteStudioLimiter, coverFilterPreviewLimiter, checkUserLimit, rateLimitHeaders } from '@/lib/rate-limit'
import { ARTWORK_BUCKET, storagePathFromUrl } from '@/lib/project-assets'
import { downloadStudio, findStudioObject, studioPublicUrl } from '@/lib/cassette-server'
import {
  artworkStamp, filteredCoverKey, finalizedCoverKey, parseFinalizedCover, parseSourcePath,
} from '@/lib/cassette-studio'
import {
  FILTER_ADJUSTMENTS, FILTER_PRESETS, decodeForFilter, filterRawToJpeg, isIdentityFilter, normalizeFilter,
  type FilterSettings, type RawImage,
} from '@/lib/cover-filters'

export const runtime = 'nodejs'
export const maxDuration = 60

// Cassette Studio — "Finish the look": Instagram-style looks and sliders on the
// project's finished cover (engine: src/lib/cover-filters.ts).
//
// A look is always applied to the UNFILTERED cover — the "base" — never to a
// previous filtered result, so re-filtering never stacks. The base is resolved
// HERE from the project's own columns, never named by the request:
//
//   finalized = <pid>/finalized-<fts>.jpg          → base = that file
//   finalized = <pid>/finalized-<fts>-f<code>.jpg  → base = <pid>/finalized-<fts>.jpg if it exists,
//                                                    else artwork_url when its stamp is <fts>
//   no finalized                                   → base = artwork_url, if it is an image under <pid>/
//
// A saved look is <pid>/finalized-<fts>-f<code>.jpg (the look rides in the key:
// mf-artwork takes images only) and becomes finalized_artwork_url; artwork_url
// is never touched. Saving "Original" resets: finalized goes back to the base,
// or to null when the base is the clean artwork (a cover with no handwriting).
// An artwork with no stamp in its name (deezer-<id>.jpg) first gets an
// unfiltered anchor copy, finalized-<now>.jpg, so its look can be redone later.
//
// Owner-only (404 otherwise), like every Cassette Studio route.

type ProjectRow = { id: string; artwork_url: string | null; finalized_artwork_url: string | null }

type CoverBase = {
  /** mf-artwork key of the unfiltered image a look is applied to. */
  key: string
  /** The stamp a filtered cover is keyed by; null → save mints an anchor first. */
  fts: string | null
  /** The base is the project's clean artwork: a reset clears finalized_artwork_url. */
  isArtwork: boolean
}

const PREVIEW_MAX_SIDE = 1080
const SAVE_MAX_SIDE = 3000
const NO_COVER = 'Make a cover first.'
const LOAD_FAILED = 'Could not load the cover. Please try again.'
const APPLY_FAILED = 'Could not apply the look. Please try again.'

async function loadProject(userId: string, projectId: string): Promise<ProjectRow | null> {
  const { data, error } = await supabaseAdmin
    .from('mb_projects')
    .select('id, artwork_url, finalized_artwork_url')
    .eq('id', projectId)
    .eq('user_id', userId)
    .single()
  return error || !data ? null : (data as ProjectRow)
}

/**
 * The base a look is applied to, and the look the current cover carries.
 * Every candidate key is derived from the row with storagePathFromUrl (our
 * Supabase host + mf-artwork only — any other URL is refused) and re-parsed
 * against THIS project's id, so nothing outside `<projectId>/` can become a
 * base. Throws only when Storage itself fails.
 */
async function resolveBase(project: ProjectRow): Promise<{ base: CoverBase | null; current: FilterSettings | null }> {
  const artKey = storagePathFromUrl(project.artwork_url, ARTWORK_BUCKET)
  if (project.finalized_artwork_url) {
    const finKey = storagePathFromUrl(project.finalized_artwork_url, ARTWORK_BUCKET)
    const fin = parseFinalizedCover(finKey, project.id)
    // A finalized cover this tool did not make and cannot parse: leave it be.
    if (!finKey || !fin) return { base: null, current: null }
    if (!fin.filter) return { base: { key: finKey, fts: fin.fts, isArtwork: false }, current: null }
    const plain = finalizedCoverKey(project.id, fin.fts)
    if (await findStudioObject(plain)) return { base: { key: plain, fts: fin.fts, isArtwork: false }, current: fin.filter }
    if (artKey && artworkStamp(artKey, project.id) === fin.fts) {
      return { base: { key: artKey, fts: fin.fts, isArtwork: true }, current: fin.filter }
    }
    return { base: null, current: fin.filter }
  }
  if (!artKey || parseSourcePath(artKey)?.projectId !== project.id) return { base: null, current: null }
  return { base: { key: artKey, fts: artworkStamp(artKey, project.id), isArtwork: true }, current: null }
}

// ── Preview cache ───────────────────────────────────────────────────────────
// The downsized, decoded base per (user, base key): every slider pause is a
// preview, and downloading + decoding a 3000px JPEG is most of a preview's
// cost. Covers are written under fresh timestamped names, but a few upload
// paths may overwrite a key in place, so an entry also expires after
// PREVIEW_CACHE_TTL_MS — an editing session stays warm, a stale base cannot
// outlive it. A save always reads the base fresh. Holds the PROMISE, so two
// previews racing for a cold base share one download + decode. ≤6 × ~3.5 MB.
const PREVIEW_CACHE_MAX = 6
const PREVIEW_CACHE_TTL_MS = 10 * 60 * 1000
const previewCache = new Map<string, { at: number; image: Promise<RawImage> }>()

function previewBase(userId: string, key: string): Promise<RawImage> {
  const id = `${userId}:${key}`
  const hit = previewCache.get(id)
  previewCache.delete(id)
  if (hit && Date.now() - hit.at < PREVIEW_CACHE_TTL_MS) {
    previewCache.set(id, hit) // most recently used goes to the back
    return hit.image
  }
  const entry = { at: Date.now(), image: downloadStudio(key).then(bytes => decodeForFilter(bytes, PREVIEW_MAX_SIDE)) }
  entry.image.catch(() => { if (previewCache.get(id) === entry) previewCache.delete(id) })
  previewCache.set(id, entry)
  while (previewCache.size > PREVIEW_CACHE_MAX) previewCache.delete(previewCache.keys().next().value!)
  return entry.image
}

// GET /api/cassette-studio/filter?project_id=<uuid>
// → { presets, adjustments, current: FilterSettings | null, base_url: string | null }
//   base_url null → this project has no cover to edit.
export async function GET(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!(await isAdminIdentity(userId))) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const projectId = canonicalUuid(request.nextUrl.searchParams.get('project_id'))
  if (!projectId) return NextResponse.json({ error: 'Valid project_id is required' }, { status: 400 })
  const project = await loadProject(userId, projectId)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  try {
    const { base, current } = await resolveBase(project)
    return NextResponse.json({
      presets: FILTER_PRESETS,
      adjustments: FILTER_ADJUSTMENTS,
      current,
      base_url: base ? studioPublicUrl(base.key) : null,
    })
  } catch (err) {
    console.error('[cassette-studio/filter] lookup failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: LOAD_FAILED }, { status: 502 })
  }
}

// POST /api/cassette-studio/filter   JSON { project_id, settings: FilterSettings, mode: 'preview' | 'save' }
//   preview → image/jpeg, long side ≤1080px, no-store
//   save    → { artwork_url, finalized_artwork_url, filter: FilterSettings | null }
export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!(await isAdminIdentity(userId))) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await request.json().catch(() => null)
  if (!isJsonObject(body)) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  const mode = body.mode
  if (mode !== 'preview' && mode !== 'save') return NextResponse.json({ error: 'Unknown mode' }, { status: 400 })

  // Previews are cheap and come in bursts; a save writes a full-size cover and
  // counts with the rest of the studio's heavy calls.
  const limit = await checkUserLimit(mode === 'preview' ? coverFilterPreviewLimiter : cassetteStudioLimiter, userId)
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Too many changes in a short time. Try again shortly.' }, { status: 429, headers: rateLimitHeaders(limit) })
  }

  const projectId = canonicalUuid(body.project_id)
  if (!projectId) return NextResponse.json({ error: 'Valid project_id is required' }, { status: 400 })
  const settings = normalizeFilter(body.settings)
  if (!settings) return NextResponse.json({ error: 'Those filter settings are not valid.' }, { status: 400 })

  const project = await loadProject(userId, projectId)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  let base: CoverBase | null
  try {
    base = (await resolveBase(project)).base
  } catch (err) {
    console.error('[cassette-studio/filter] lookup failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: LOAD_FAILED }, { status: 502 })
  }
  if (!base) return NextResponse.json({ error: NO_COVER }, { status: 400 })

  if (mode === 'preview') {
    let img: RawImage
    try {
      img = await previewBase(userId, base.key)
    } catch (err) {
      console.error('[cassette-studio/filter] preview base failed:', err instanceof Error ? err.message : err)
      return NextResponse.json({ error: LOAD_FAILED }, { status: 502 })
    }
    // The editor cancels a preview the moment a newer one starts — don't spend
    // the grade + encode on an answer nobody is waiting for.
    if (request.signal.aborted) return new NextResponse(null, { status: 204 })
    try {
      const jpeg = await filterRawToJpeg(img, settings, { quality: 85 })
      return new NextResponse(new Uint8Array(jpeg), {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' },
      })
    } catch (err) {
      console.error('[cassette-studio/filter] preview failed:', err instanceof Error ? err.message : err)
      return NextResponse.json({ error: APPLY_FAILED }, { status: 502 })
    }
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  try {
    let finalizedUrl: string | null
    let filter: FilterSettings | null
    if (isIdentityFilter(settings)) {
      // "Original": back to the base itself — nothing to render.
      finalizedUrl = base.isArtwork ? null : studioPublicUrl(base.key)
      filter = null
    } else {
      let bytes: Buffer
      try {
        bytes = await downloadStudio(base.key)
      } catch (err) {
        console.error('[cassette-studio/filter] base download failed:', err instanceof Error ? err.message : err)
        return NextResponse.json({ error: LOAD_FAILED }, { status: 502 })
      }
      const img = await decodeForFilter(bytes, SAVE_MAX_SIDE)
      let fts = base.fts
      if (fts === null) {
        // No stamp to link a look back to this artwork: write the unfiltered
        // anchor finalized-<fts>.jpg first, so the next edit finds its base.
        fts = String(Date.now())
        const anchor = await sharpJpeg(img, 95)
        await uploadArtwork(finalizedCoverKey(project.id, fts), anchor)
      }
      const jpeg = await filterRawToJpeg(img, settings, { quality: 92 })
      finalizedUrl = await uploadArtwork(filteredCoverKey(project.id, fts, settings), jpeg)
      filter = settings
    }

    const { error: dbError } = await supabaseAdmin
      .from('mb_projects')
      .update({ finalized_artwork_url: finalizedUrl, updated_at: new Date().toISOString() })
      .eq('id', project.id)
      .eq('user_id', userId)
    if (dbError) throw new Error(`db update: ${dbError.message}`)

    return NextResponse.json({ artwork_url: project.artwork_url, finalized_artwork_url: finalizedUrl, filter })
  } catch (err) {
    console.error('[cassette-studio/filter] save failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Could not save the look. Please try again.' }, { status: 502 })
  }
}

async function sharpJpeg(img: RawImage, quality: number): Promise<Buffer> {
  return sharp(img.data, { raw: { width: img.width, height: img.height, channels: 3 } }).jpeg({ quality }).toBuffer()
}

/**
 * Write a cover under the project. upsert:false like every studio write; the
 * one expected collision is the SAME look saved twice on the same cover — the
 * key is derived from (stamp, look) and the render is deterministic, so the
 * object already there is exactly this image and is reused.
 */
async function uploadArtwork(path: string, bytes: Buffer): Promise<string> {
  const { error } = await supabaseAdmin.storage.from(ARTWORK_BUCKET).upload(path, bytes, { contentType: 'image/jpeg', upsert: false })
  if (error && !(await findStudioObject(path))) throw new Error(`upload ${path}: ${error.message}`)
  return studioPublicUrl(path)
}
