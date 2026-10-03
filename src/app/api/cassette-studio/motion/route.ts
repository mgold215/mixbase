import { NextRequest, NextResponse } from 'next/server'
import sharp from 'sharp'
import { supabaseAdmin } from '@/lib/supabase'
import { canonicalUuid, isJsonObject } from '@/lib/validators'
import { isAdminIdentity } from '@/lib/admin-identity'
import { freeRenderLimiter, checkUserLimit, rateLimitHeaders } from '@/lib/rate-limit'
import { ARTWORK_BUCKET, storagePathFromUrl } from '@/lib/project-assets'
import { downloadStudio, listStudio } from '@/lib/cassette-server'
import {
  cassetteCoverStamp, finalizedCoverStamp, parseStudioMotionKey, type LetteringPosition, type LetteringSize,
} from '@/lib/cassette-studio'
import { prepareMotionAssets } from '@/lib/cassette-motion'
import { renderCassetteMotion } from '@/lib/cassette-render'
import { FREE_FORMATS, isFreeFormat } from '@/lib/free-render'
import { tryAcquireTranscodeSlot, releaseTranscodeSlot } from '@/lib/visualizer-encode'
import { storeVisualizer } from '@/lib/visualizer-store'

// Cassette Studio — moving cover. A no-AI animated loop of the project's
// current Cassette Studio cover: the reels turn, the camera drifts with
// two-plane parallax, the film grain is alive, the handwritten title sits on
// top (engine: src/lib/cassette-motion*.ts; render: src/lib/cassette-render.ts).
//
// Built from the layers every render keeps beside the still (key shapes in
// cassette-studio.ts "Motion layers"), found by the cover's own timestamp:
//   artwork_url    <projectId>/(ai-)cassette-<ts>.jpg → plate-<ts>.jpg + layer-<ts>-<l>-<t>.png
//   finalized_url  <projectId>/finalized-<fts>.jpg    → title-<fts>-<position>-<size>.png (optional)
//
// Owner-only (404 otherwise), like every Cassette Studio route.
//
// Run time is advisory on Railway (plain `next start`), like the other video
// routes: a 30s 1080p loop is tens of seconds of sliced worker rendering.
export const runtime = 'nodejs'
export const maxDuration = 300

const NOT_A_STUDIO_COVER = 'Make a cover in Cassette Studio first.'
const MADE_BEFORE_MOTION = 'This cover was made before moving covers existed — make a new one in Cassette Studio.'
const RENDER_FAILED = 'Could not render the moving cover. Please try again.'

type ProjectRow = { id: string; user_id: string; artwork_url: string | null; finalized_artwork_url: string | null }

type MotionSources =
  | { ok: false; reason: string }
  | {
      ok: true
      platePath: string
      layerPath: string
      left: number
      top: number
      title: { path: string; position: LetteringPosition; size: LetteringSize } | null
    }

async function loadProject(userId: string, projectId: string): Promise<ProjectRow | null> {
  const { data, error } = await supabaseAdmin
    .from('mb_projects')
    .select('id, user_id, artwork_url, finalized_artwork_url')
    .eq('id', projectId)
    .eq('user_id', userId)
    .single()
  return error || !data ? null : (data as ProjectRow)
}

/**
 * Find this cover's motion layers in the caller's own studio folder. Each
 * listing is narrowed to one stamp with Storage's `search`, and every name it
 * returns is still parsed strictly (parseStudioMotionKey) and matched on the
 * exact stamp before it is used. Throws only when Storage itself fails.
 */
async function findMotionSources(userId: string, project: ProjectRow): Promise<MotionSources> {
  const ts = cassetteCoverStamp(storagePathFromUrl(project.artwork_url, ARTWORK_BUCKET), project.id)
  if (!ts) return { ok: false, reason: NOT_A_STUDIO_COVER }
  const fts = finalizedCoverStamp(storagePathFromUrl(project.finalized_artwork_url, ARTWORK_BUCKET), project.id)

  const [plates, layers, titles] = await Promise.all([
    listStudio(userId, `plate-${ts}`),
    listStudio(userId, `layer-${ts}-`),
    fts ? listStudio(userId, `title-${fts}-`) : Promise.resolve([]),
  ])
  const plate = plates.find(f => {
    const k = parseStudioMotionKey(f.path, userId)
    return k?.kind === 'plate' && k.ts === ts
  })
  let layer: { path: string; left: number; top: number } | null = null
  for (const f of layers) {
    const k = parseStudioMotionKey(f.path, userId)
    if (k?.kind === 'layer' && k.ts === ts) { layer = { path: f.path, left: k.left, top: k.top }; break }
  }
  if (!plate || !layer) return { ok: false, reason: MADE_BEFORE_MOTION }

  let title: { path: string; position: LetteringPosition; size: LetteringSize } | null = null
  for (const f of titles) {
    const k = parseStudioMotionKey(f.path, userId)
    if (k?.kind === 'title' && k.ts === fts) { title = { path: f.path, position: k.position, size: k.size }; break }
  }
  return { ok: true, platePath: plate.path, layerPath: layer.path, left: layer.left, top: layer.top, title }
}

// GET /api/cassette-studio/motion?project_id=<uuid>
// → { available: boolean, reason: string | null } — whether the project's
//   current cover can be made to move, and if not, what to tell the artist.
export async function GET(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!(await isAdminIdentity(userId))) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const projectId = canonicalUuid(request.nextUrl.searchParams.get('project_id'))
  if (!projectId) return NextResponse.json({ error: 'Valid project_id is required' }, { status: 400 })
  const project = await loadProject(userId, projectId)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  try {
    const src = await findMotionSources(userId, project)
    return NextResponse.json({ available: src.ok, reason: src.ok ? null : src.reason })
  } catch (err) {
    console.error('[cassette-studio/motion] lookup failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Could not check this cover. Please try again.' }, { status: 500 })
  }
}

// POST /api/cassette-studio/motion   JSON { project_id, format }
//   format: 'canvas' | 'square' | 'youtube' | 'story' (FREE_FORMATS — same
//   sizes, lengths and 30 fps as the free generator)
// → { id, video_url, saved: true, format } — saved to the visualizer library
//   as a free (no-AI) clip. Pin it like any clip: landscape (youtube) into
//   visualizer_wide_url, everything else into visualizer_url.
export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!(await isAdminIdentity(userId))) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const limit = await checkUserLimit(freeRenderLimiter, userId)
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Too many renders this hour. Try again shortly.' },
      { status: 429, headers: rateLimitHeaders(limit) },
    )
  }

  const body = await request.json().catch(() => null)
  if (!isJsonObject(body)) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  const projectId = canonicalUuid(body.project_id)
  if (!projectId) return NextResponse.json({ error: 'Valid project_id is required' }, { status: 400 })
  const format = body.format
  if (!isFreeFormat(format)) return NextResponse.json({ error: 'Unknown format' }, { status: 400 })

  const project = await loadProject(userId, projectId)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  let src: MotionSources
  try {
    src = await findMotionSources(userId, project)
  } catch (err) {
    console.error('[cassette-studio/motion] lookup failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: RENDER_FAILED }, { status: 502 })
  }
  if (!src.ok) return NextResponse.json({ error: src.reason }, { status: 400 })

  // Fetch and prepare everything BEFORE taking an encoder slot — a slow
  // storage read or the hub cut-out must not sit on one of the two slots.
  let input: Parameters<typeof renderCassetteMotion>[0]
  try {
    const [plateJpeg, layerPng, titlePng] = await Promise.all([
      downloadStudio(src.platePath),
      downloadStudio(src.layerPath),
      src.title ? downloadStudio(src.title.path) : Promise.resolve(null),
    ])
    const { data: layer, info } = await sharp(layerPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const assets = await prepareMotionAssets(layer, info.width, info.height)
    input = {
      plateJpeg,
      assets,
      box: { left: src.left, top: src.top, width: info.width, height: info.height },
      title: src.title && titlePng ? { png: titlePng, position: src.title.position, size: src.title.size } : null,
      format,
    }
  } catch (err) {
    console.error('[cassette-studio/motion] prepare failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: RENDER_FAILED }, { status: 502 })
  }

  // Same 2-slot encoder gate as every other request-path render.
  if (!tryAcquireTranscodeSlot()) {
    return NextResponse.json(
      { error: 'Server is busy rendering other videos — try again in a minute' },
      { status: 503, headers: { 'Retry-After': '30' } },
    )
  }
  let bytes: Buffer
  try {
    bytes = await renderCassetteMotion(input)
  } catch (err) {
    console.error('[cassette-studio/motion] render failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: RENDER_FAILED }, { status: 502 })
  } finally {
    releaseTranscodeSlot()
  }

  const stored = await storeVisualizer({
    userId,
    projectId: project.id,
    bytes,
    contentType: 'video/mp4',
    kind: 'free',
    title: `Moving cover · ${FREE_FORMATS[format].label}`,
    sourceImageUrl: project.finalized_artwork_url ?? project.artwork_url,
    settings: { source: 'cassette-motion', format },
  })
  if (!stored) return NextResponse.json({ error: 'Rendered fine but saving failed — try again.' }, { status: 500 })

  return NextResponse.json({ id: stored.id, video_url: stored.video_url, saved: true, format })
}
