import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { isUuid, isSupabaseStorageUrl } from '@/lib/validators'
import { finalVideoLimiter, rateLimitHeaders } from '@/lib/rate-limit'
import { isHexColor, DEFAULT_TEXT_COLOR } from '@/lib/finalize-render'
import { startVideoJob, getVideoJob } from '@/lib/video-jobs'
import { SHORTS_LENGTHS, MAX_SONG_SECONDS, type VideoFormat } from '@/lib/video-render'

export const runtime = 'nodejs'

// ── /api/finalize-video ──────────────────────────────────────────────────────
// Renders the finished YouTube video / vertical Short for a song by combining
// the pieces the user already made: pinned visualizer (loops seamlessly for
// the song's length), current mix audio, and the artwork text lockup flashing
// at scheduled points. Renders run as in-process jobs (minutes long); POST
// starts one, GET polls it. Outputs land in mf-video + mb_visualizers with
// kind 'youtube' | 'shorts', so they show up in Media like other renders.

function jobPayload(job: NonNullable<ReturnType<typeof getVideoJob>>) {
  return {
    job_id: job.id,
    status: job.status,
    progress: Math.round(job.progress * 100),
    stage: job.stage,
    format: job.format,
    ...(job.resultUrl ? { video_url: job.resultUrl } : {}),
    ...(job.error ? { error: job.error } : {}),
  }
}

export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const limit = finalVideoLimiter.check(userId)
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded. Try again later.' }, { status: 429, headers: rateLimitHeaders(limit) })
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

  const { project_id, artist } = body
  if (!isUuid(project_id)) {
    return NextResponse.json({ error: 'Valid project_id is required' }, { status: 400 })
  }
  const format: VideoFormat = body.format === 'shorts' ? 'shorts' : 'youtube'
  const color: string = isHexColor(body.color) ? body.color : DEFAULT_TEXT_COLOR
  const clipSeconds: number = SHORTS_LENGTHS.includes(body.clip_seconds) ? body.clip_seconds : 30
  const startSec: number = typeof body.start_sec === 'number' && body.start_sec >= 0 && Number.isFinite(body.start_sec)
    ? body.start_sec : 0

  // Everything renders from server-side state, never client-supplied URLs —
  // same rule as finalize-artwork.
  const { data: project, error: projectError } = await supabaseAdmin
    .from('mb_projects')
    .select('title, visualizer_url')
    .eq('id', project_id)
    .eq('user_id', userId)
    .single()
  if (projectError || !project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }
  if (!project.visualizer_url) {
    return NextResponse.json({ error: 'Pin a visualizer to this project first (Visualizer tab)' }, { status: 400 })
  }
  if (!project.title) {
    return NextResponse.json({ error: 'Project title is required' }, { status: 400 })
  }

  const { data: version } = await supabaseAdmin
    .from('mb_versions')
    .select('audio_url, duration_seconds')
    .eq('project_id', project_id)
    .order('version_number', { ascending: false })
    .limit(1)
    .single()
  if (!version?.audio_url) {
    return NextResponse.json({ error: 'Upload a mix before rendering a video' }, { status: 400 })
  }
  if (format === 'youtube' && (version.duration_seconds ?? 0) > MAX_SONG_SECONDS) {
    return NextResponse.json({ error: `Songs over ${MAX_SONG_SECONDS / 60} minutes aren't supported yet` }, { status: 400 })
  }

  // SSRF guard: the render job fetches both URLs server-side, so refuse anything
  // that isn't a Supabase Storage URL (their only legitimate shape). Belt-and-
  // suspenders alongside the write-site checks in /api/versions and PATCH
  // /api/projects — this also covers any row written before those checks existed.
  if (!isSupabaseStorageUrl(project.visualizer_url) || !isSupabaseStorageUrl(version.audio_url)) {
    return NextResponse.json({ error: 'Media source is not a valid storage URL' }, { status: 400 })
  }

  const started = startVideoJob({
    userId,
    projectId: project_id,
    visualizerUrl: project.visualizer_url,
    audioUrl: version.audio_url,
    title: project.title,
    artist: typeof artist === 'string' && artist.trim() ? artist.trim().slice(0, 80) : 'moodmixformat',
    format,
    color,
    startSec,
    clipSeconds,
  })
  if (!started.ok) {
    // No render actually started, so give back the rate-limit credit consumed
    // above — a busy signal shouldn't burn one of the user's hourly slots.
    finalVideoLimiter.rollback(userId)
    return started.code === 'user_busy'
      ? NextResponse.json({ error: 'A render is already running — wait for it to finish', job_id: started.existing?.id }, { status: 409 })
      : NextResponse.json({ error: 'Server is busy rendering other videos — try again in a few minutes' }, { status: 503 })
  }

  return NextResponse.json(jobPayload(started.job), { status: 202 })
}

// GET ?job=<id>            → job progress/status
// GET ?project_id=<uuid>   → latest saved finals for the project (both formats)
export async function GET(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const jobId = request.nextUrl.searchParams.get('job')
  if (jobId) {
    const job = getVideoJob(jobId)
    if (!job || job.userId !== userId) {
      // Also covers a deploy wiping in-process jobs mid-render.
      return NextResponse.json({ error: 'Job not found — it may have been interrupted by a deploy. Try rendering again.' }, { status: 404 })
    }
    return NextResponse.json(jobPayload(job))
  }

  const projectId = request.nextUrl.searchParams.get('project_id')
  if (!isUuid(projectId)) {
    return NextResponse.json({ error: 'job or project_id is required' }, { status: 400 })
  }
  const { data, error } = await supabaseAdmin
    .from('mb_visualizers')
    .select('id, kind, video_url, title, created_at')
    .eq('user_id', userId)
    .eq('project_id', projectId)
    .in('kind', ['youtube', 'shorts'])
    .order('created_at', { ascending: false })
    .limit(20)
  if (error) {
    return NextResponse.json({ error: 'Could not load videos' }, { status: 500 })
  }
  const latest: Record<string, unknown> = { youtube: null, shorts: null }
  for (const row of data ?? []) {
    if (latest[row.kind] === null) latest[row.kind] = row
  }
  return NextResponse.json(latest)
}
