import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { isUuid, canonicalUuid, isSupabaseStorageUrl } from '@/lib/validators'
import { ensureProjectVisualizerColumn, isMissingVisualizerColumn } from '@/lib/schema-heal'
import { finalVideoLimiter, rateLimitHeaders , checkUserLimit } from '@/lib/rate-limit'
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

  const limit = await checkUserLimit(finalVideoLimiter, userId)
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded. Try again later.' }, { status: 429, headers: rateLimitHeaders(limit) })
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

  // Canonical, not merely valid. The render job carries this id all the way to
  // storeVisualizer, which mints `<projectId>/viz-<ts>.<ext>` — a key Storage
  // keeps verbatim while every gate on the way there is a uuid column that does
  // not. storeVisualizer lowercases defensively at the mint itself; doing it
  // here as well means the id written to mb_visualizers.project_id and the id
  // baked into the key are the same string, so the row can always name its own
  // object. This is the shipped iOS app's most likely entry point into this
  // class — Swift's UUID.uuidString is uppercase.
  const project_id = canonicalUuid(body.project_id)
  if (!project_id) {
    return NextResponse.json({ error: 'Valid project_id is required' }, { status: 400 })
  }
  const format: VideoFormat = body.format === 'shorts' ? 'shorts' : 'youtube'
  const color: string = isHexColor(body.color) ? body.color : DEFAULT_TEXT_COLOR
  const clipSeconds: number = SHORTS_LENGTHS.includes(body.clip_seconds) ? body.clip_seconds : 30
  const startSec: number = typeof body.start_sec === 'number' && body.start_sec >= 0 && Number.isFinite(body.start_sec)
    ? body.start_sec : 0
  // Preferred over start_sec: the renderer resolves it against the PROBED audio
  // duration, so it works for the ~40% of mixes whose duration_seconds is null
  // (the client can't compute a start second for those).
  const startMode: 'start' | 'hook' | 'middle' | undefined =
    body.start_mode === 'start' || body.start_mode === 'hook' || body.start_mode === 'middle'
      ? body.start_mode : undefined

  // Everything renders from server-side state, never client-supplied URLs —
  // same rule as finalize-artwork. visualizer_wide_url can predate migration
  // 020 on prod: heal + retry, and if the heal can't run (no Mgmt token) fall
  // back to selecting only the vertical pin so finalize keeps working.
  type ProjectPins = { title: string | null; visualizer_url: string | null; visualizer_wide_url?: string | null }
  const selectProject = async (withWide: boolean) => {
    const { data, error } = await supabaseAdmin
      .from('mb_projects')
      .select(`title, visualizer_url${withWide ? ', visualizer_wide_url' : ''}`)
      .eq('id', project_id)
      .eq('user_id', userId)
      .single()
    return { data: data as ProjectPins | null, error }
  }
  let { data: project, error: projectError } = await selectProject(true)
  if (projectError && isMissingVisualizerColumn(projectError)) {
    if (await ensureProjectVisualizerColumn()) {
      ({ data: project, error: projectError } = await selectProject(true))
    } else {
      ({ data: project, error: projectError } = await selectProject(false))
    }
  }
  if (projectError || !project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }
  // Each output renders from the pin in its own orientation — horizontal for
  // the full-length 16:9, vertical for the Short — falling back to the other
  // pin (cover-cropped by the renderer) so projects with one pin still work.
  const vertical = project.visualizer_url ?? null
  const wide = project.visualizer_wide_url ?? null
  const sourceUrl = format === 'youtube' ? (wide ?? vertical) : (vertical ?? wide)
  if (!sourceUrl) {
    return NextResponse.json({ error: 'Pin a visualizer to this project first (Visualizer tab)' }, { status: 400 })
  }
  if (!project.title) {
    return NextResponse.json({ error: 'Project title is required' }, { status: 400 })
  }

  // Artist name comes from the user's profile, not the request body — otherwise
  // every rendered video was stamped with a hardcoded handle.
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('artist_name')
    .eq('id', userId)
    .single()
  const artist = (profile?.artist_name?.trim() || 'mixBase').slice(0, 80)

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
  // DELIBERATE: an unknown duration falls THROUGH this gate rather than failing
  // closed. `duration_seconds` is null on 135 of 342 production rows (the web
  // client's 8s metadata probe times out on large WAVs), so rejecting nulls here
  // would block YouTube renders for ~40% of mixes. This gate is only a fast-fail
  // courtesy: the real limit is enforced in the renderer against the PROBED
  // duration (`video-render.ts`, `outDur > MAX_SONG_SECONDS`), which cannot be
  // fooled by missing metadata. The cost of a null is a late failure that burns
  // one of the user's 6/hr slots, not an unbounded render.
  if (format === 'youtube' && (version.duration_seconds ?? 0) > MAX_SONG_SECONDS) {
    return NextResponse.json({ error: `Songs over ${MAX_SONG_SECONDS / 60} minutes aren't supported yet` }, { status: 400 })
  }

  // SSRF guard: the render job fetches both URLs server-side, so refuse anything
  // that isn't a Supabase Storage URL (their only legitimate shape). Belt-and-
  // suspenders alongside the write-site checks in /api/versions and PATCH
  // /api/projects — this also covers any row written before those checks existed.
  if (!isSupabaseStorageUrl(sourceUrl) || !isSupabaseStorageUrl(version.audio_url)) {
    return NextResponse.json({ error: 'Media source is not a valid storage URL' }, { status: 400 })
  }

  const started = startVideoJob({
    userId,
    projectId: project_id,
    visualizerUrl: sourceUrl,
    audioUrl: version.audio_url,
    title: project.title,
    artist,
    format,
    color,
    startSec,
    startMode,
    clipSeconds,
    fallbackAudioSeconds: version.duration_seconds ?? undefined,
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
