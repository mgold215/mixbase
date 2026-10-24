import { NextRequest, NextResponse } from 'next/server'
import { canonicalUuid, isJsonObject } from '@/lib/validators'
import { isAdminIdentity } from '@/lib/admin-identity'
import { cassetteStudioLimiter, coverFilterPreviewLimiter, checkUserLimit, rateLimitHeaders } from '@/lib/rate-limit'
import { downloadStudio, studioPublicUrl } from '@/lib/cassette-server'
import {
  CoverError, LOAD_FAILED, NO_COVER, loadCoverProject, resolveCoverBase, saveLookOnProject, type CoverBase,
} from '@/lib/cassette-pipeline'
import {
  FILTER_ADJUSTMENTS, FILTER_PRESETS, decodeForFilter, filterRawToJpeg, normalizeFilter, type RawImage,
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

// The base resolution and the save itself live in src/lib/cassette-pipeline.ts
// (resolveCoverBase / saveLookOnProject), shared with the theme route.

const PREVIEW_MAX_SIDE = 1080
const APPLY_FAILED = 'Could not apply the look. Please try again.'

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
  const project = await loadCoverProject(userId, projectId)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  try {
    const { base, current } = await resolveCoverBase(project)
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

  const project = await loadCoverProject(userId, projectId)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  let base: CoverBase | null
  try {
    base = (await resolveCoverBase(project)).base
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
    return NextResponse.json(await saveLookOnProject(userId, project, settings))
  } catch (err) {
    if (err instanceof CoverError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[cassette-studio/filter] save failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Could not save the look. Please try again.' }, { status: 502 })
  }
}
