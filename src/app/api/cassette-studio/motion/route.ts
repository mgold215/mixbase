import { NextRequest, NextResponse } from 'next/server'
import { canonicalUuid, isJsonObject } from '@/lib/validators'
import { isAdminIdentity } from '@/lib/admin-identity'
import { freeRenderLimiter, checkUserLimit, rateLimitHeaders } from '@/lib/rate-limit'
import { isFreeFormat } from '@/lib/free-render'
import { CoverError, findMotionSources, loadCoverProject, makeMovingCover } from '@/lib/cassette-pipeline'

// Cassette Studio — moving cover. A no-AI animated loop of the project's
// current Cassette Studio cover: the reels turn, the camera drifts with
// two-plane parallax, the film grain is alive, the handwritten title sits on
// top. What it is built from and how: makeMovingCover in
// src/lib/cassette-pipeline.ts (the one-click flow uses the same function as
// its fallback when a cinematic clip cannot be filmed).
//
// Owner-only (404 otherwise), like every Cassette Studio route.
//
// Run time is advisory on Railway (plain `next start`), like the other video
// routes: a 30s 1080p loop is tens of seconds of sliced worker rendering.
export const runtime = 'nodejs'
export const maxDuration = 300

// GET /api/cassette-studio/motion?project_id=<uuid>
// → { available: boolean, reason: string | null } — whether the project's
//   current cover can be made to move, and if not, what to tell the artist.
export async function GET(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!(await isAdminIdentity(userId))) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const projectId = canonicalUuid(request.nextUrl.searchParams.get('project_id'))
  if (!projectId) return NextResponse.json({ error: 'Valid project_id is required' }, { status: 400 })
  const project = await loadCoverProject(userId, projectId)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  try {
    const src = await findMotionSources(userId, project)
    return NextResponse.json({ available: src.ok, reason: src.ok ? null : src.reason })
  } catch (err) {
    console.error('[cassette-studio/motion] lookup failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Could not check this cover. Please try again.' }, { status: 500 })
  }
}

// POST /api/cassette-studio/motion   JSON { project_id, format, title? }
//   format: 'canvas' | 'square' | 'youtube' | 'story' (FREE_FORMATS — same
//   sizes, lengths and 30 fps as the free generator)
//   title:  false renders the loop WITHOUT the handwritten title (default true)
// → { id, video_url, saved: true, format, has_title } — saved to the
//   visualizer library as a free (no-AI) clip. Pin it like any clip: landscape
//   (youtube) into visualizer_wide_url, everything else into visualizer_url
//   (PATCH /api/projects/[id]).
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
  const withTitle = body.title !== false

  const project = await loadCoverProject(userId, projectId)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  try {
    const stored = await makeMovingCover(userId, project, format, withTitle)
    return NextResponse.json({ id: stored.id, video_url: stored.video_url, saved: true, format, has_title: withTitle })
  } catch (err) {
    if (err instanceof CoverError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.status, ...(err.status === 503 ? { headers: { 'Retry-After': '30' } } : {}) },
      )
    }
    console.error('[cassette-studio/motion] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Could not render the moving cover. Please try again.' }, { status: 502 })
  }
}
