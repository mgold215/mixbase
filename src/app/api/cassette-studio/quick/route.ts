import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { canonicalUuid, isJsonObject } from '@/lib/validators'
import { isAdminIdentity } from '@/lib/admin-identity'
import { cassetteStudioLimiter, checkUserLimit, rateLimitHeaders } from '@/lib/rate-limit'
import { isOwnStudioKey, listStudio } from '@/lib/cassette-server'
import { getQuickJob, latestQuickJob, publicJob, startQuickJob, type QuickFormat } from '@/lib/cassette-quick'
import { isArtModelId, MAX_SCENE, MAX_TAKES } from '@/lib/cassette-art'

export const runtime = 'nodejs'

// Cassette Studio — ONE CLICK (src/lib/cassette-quick.ts): one button makes
// the cover (an idea drawn around your cassette, lettered in your
// handwriting) plus Canvas and YouTube moving scenes, all applied to the song.
//
// POST /api/cassette-studio/quick   JSON { project_id, description? }
//   description  the artist's own idea for the cover, optional: left empty,
//                the idea comes from the song's title
//   Optional, for the owner's own experiments (the screens never send them):
//   prompt       an exact scene brief, drawn as written (no art direction)
//   formats      which clips to make: any of 'canvas', 'youtube' (default both;
//                [] = the cover only)
//   takes        how many takes to draw, 1–4 (default 3)
//   model        pin one image model (see ART_MODELS) instead of best-first
//   → 202 { job }   the run continues in the background; poll GET
//   → 409 { error, job }   this owner already has a run going (that job)
// GET  /api/cassette-studio/quick?job=<id>          → { job }
// GET  /api/cassette-studio/quick?project_id=<uuid> → { job | null } the newest
//      run for that song, so a reopened screen picks up where it was
//
// Owner-only (404 otherwise), like every Cassette Studio route.

const MAX_DESCRIPTION = 400

export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!(await isAdminIdentity(userId))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const limit = await checkUserLimit(cassetteStudioLimiter, userId)
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded. Try again later.' }, { status: 429, headers: rateLimitHeaders(limit) })
  }
  const body = await request.json().catch(() => null)
  if (!isJsonObject(body)) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  const projectId = canonicalUuid(body.project_id)
  if (!projectId) return NextResponse.json({ error: 'Valid project_id is required' }, { status: 400 })
  const description = typeof body.description === 'string' ? body.description.trim().replace(/\s+/g, ' ') : ''
  if (description.length > MAX_DESCRIPTION) return NextResponse.json({ error: `Keep the idea under ${MAX_DESCRIPTION} characters.` }, { status: 400 })
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim().replace(/\s+/g, ' ') : ''
  if (prompt.length > MAX_SCENE) return NextResponse.json({ error: `Keep the prompt under ${MAX_SCENE} characters.` }, { status: 400 })
  let formats: QuickFormat[] | undefined
  if (body.formats !== undefined) {
    if (!Array.isArray(body.formats) || body.formats.some(f => f !== 'canvas' && f !== 'youtube')) {
      return NextResponse.json({ error: 'formats must be a list of canvas and/or youtube' }, { status: 400 })
    }
    formats = [...new Set(body.formats as QuickFormat[])]
  }
  let takes: number | undefined
  if (body.takes !== undefined) {
    if (typeof body.takes !== 'number' || !Number.isInteger(body.takes) || body.takes < 1 || body.takes > MAX_TAKES) {
      return NextResponse.json({ error: `takes must be a whole number from 1 to ${MAX_TAKES}` }, { status: 400 })
    }
    takes = body.takes
  }
  if (body.model !== undefined && !isArtModelId(body.model)) return NextResponse.json({ error: 'Unknown model' }, { status: 400 })
  const model = isArtModelId(body.model) ? body.model : undefined

  const { data: project } = await supabaseAdmin.from('mb_projects').select('id, title, genre, bpm, key_signature').eq('id', projectId).eq('user_id', userId).single()
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  let subjectPath: string | null = null
  try {
    subjectPath = (await listStudio(userId, 'subject-')).find(f => isOwnStudioKey(f.path, userId, 'subject'))?.path ?? null
  } catch (err) {
    console.error('[cassette-studio/quick] subject lookup failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Could not load your cassette. Please try again.' }, { status: 502 })
  }
  if (!subjectPath) return NextResponse.json({ error: 'Add a photo of your cassette first.' }, { status: 400 })

  const row = project as { title?: string | null; genre?: string | null; bpm?: number | null; key_signature?: string | null }
  const started = startQuickJob({
    userId, projectId, description, subjectPath, formats, takes, model,
    title: row.title ?? '', genre: row.genre ?? null,
    bpm: typeof row.bpm === 'number' ? row.bpm : null, key: row.key_signature ?? null,
    ...(prompt ? { prompt } : {}),
  })
  if (!started.ok) {
    if (started.code === 'user_busy') {
      return NextResponse.json({ error: 'You already have one being made — it will finish in a few minutes.', job: started.existing ? publicJob(started.existing) : null }, { status: 409 })
    }
    return NextResponse.json({ error: 'The studio is busy right now. Try again in a few minutes.' }, { status: 503, headers: { 'Retry-After': '60' } })
  }
  return NextResponse.json({ job: publicJob(started.job) }, { status: 202 })
}

export async function GET(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!(await isAdminIdentity(userId))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const jobId = request.nextUrl.searchParams.get('job')
  if (jobId) {
    const job = getQuickJob(jobId)
    // Someone else's job reads as missing, never as forbidden.
    if (!job || job.userId !== userId) {
      return NextResponse.json({ error: 'That run is no longer available (the server may have restarted). Try again.' }, { status: 404 })
    }
    return NextResponse.json({ job: publicJob(job) })
  }
  const projectId = canonicalUuid(request.nextUrl.searchParams.get('project_id'))
  if (!projectId) return NextResponse.json({ error: 'job or project_id is required' }, { status: 400 })
  const job = latestQuickJob(userId, projectId)
  return NextResponse.json({ job: job ? publicJob(job) : null })
}
