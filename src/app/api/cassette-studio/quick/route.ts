import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { canonicalUuid, isJsonObject } from '@/lib/validators'
import { isAdminIdentity } from '@/lib/admin-identity'
import { cassetteStudioLimiter, checkUserLimit, rateLimitHeaders } from '@/lib/rate-limit'
import { isOwnStudioKey, listStudio } from '@/lib/cassette-server'
import { getQuickJob, latestQuickJob, publicJob, startQuickJob } from '@/lib/cassette-quick'

export const runtime = 'nodejs'

// Cassette Studio — ONE CLICK (src/lib/cassette-quick.ts): describe a scene,
// get the cover (real cassette, your handwriting) plus Canvas and YouTube
// moving scenes, all applied to the song.
//
// POST /api/cassette-studio/quick   JSON { project_id, description }
//   → 202 { job }   the run continues in the background; poll GET
//   → 409 { error, job }   this owner already has a run going (that job)
// GET  /api/cassette-studio/quick?job=<id>          → { job }
// GET  /api/cassette-studio/quick?project_id=<uuid> → { job | null } the newest
//      run for that song, so a reopened screen picks up where it was
//
// Owner-only (404 otherwise), like every Cassette Studio route.

const MIN_DESCRIPTION = 3
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
  if (description.length < MIN_DESCRIPTION) return NextResponse.json({ error: 'Describe the scene first.' }, { status: 400 })
  if (description.length > MAX_DESCRIPTION) return NextResponse.json({ error: `Keep the description under ${MAX_DESCRIPTION} characters.` }, { status: 400 })

  const { data: project } = await supabaseAdmin.from('mb_projects').select('id, title').eq('id', projectId).eq('user_id', userId).single()
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  let subjectPath: string | null = null
  try {
    subjectPath = (await listStudio(userId, 'subject-')).find(f => isOwnStudioKey(f.path, userId, 'subject'))?.path ?? null
  } catch (err) {
    console.error('[cassette-studio/quick] subject lookup failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Could not load your cassette. Please try again.' }, { status: 502 })
  }
  if (!subjectPath) return NextResponse.json({ error: 'Add a photo of your cassette first.' }, { status: 400 })

  const started = startQuickJob({
    userId, projectId, description, subjectPath,
    title: (project as { title?: string | null }).title ?? '',
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
