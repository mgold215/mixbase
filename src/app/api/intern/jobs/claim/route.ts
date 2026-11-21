import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { isJsonObject } from '@/lib/validators'
import { isAdminIdentity } from '@/lib/admin-identity'
import { checkUserLimit, internLimiter, rateLimitHeaders } from '@/lib/rate-limit'
import { INTERN_STALL_MS, jobView } from '@/lib/intern-jobs.ts'
import { versionDisplayLabel } from '@/lib/mix-status.ts'
import { isMixCheckReport, previousVersionOf } from '@/lib/mix-check-server'

// POST /api/intern/jobs/claim — the mixBASE Mac app asks for work (owner-only).
//
// Answers 200 { job, song } with the oldest waiting job, now marked working and
// held by this Mac, or 200 { job: null } when there is nothing to do. A job
// another run was working on and stopped reporting on (the app was quit, the
// Mac slept) is handed out again. The claim is one conditional UPDATE, so two
// Macs, or two polls, cannot both take the same job.
//
// Body: { device?: string } — the Mac's name, shown on the job.

export const dynamic = 'force-dynamic'

const JOB_COLUMNS = 'id, version_id, project_id, status, stage, notes, changes, result_version_id, error, device, created_at, updated_at, heartbeat_at, finished_at'

export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!(await isAdminIdentity(userId))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const rl = await checkUserLimit(internLimiter, userId)
  if (!rl.allowed) return NextResponse.json({ error: 'Too many requests — try again later' }, { status: 429, headers: rateLimitHeaders(rl) })

  const body: unknown = await request.json().catch(() => null)
  const device = isJsonObject(body) && typeof body.device === 'string' ? body.device.trim().slice(0, 80) : null

  const stalledBefore = new Date(Date.now() - INTERN_STALL_MS).toISOString()
  const { data: waiting } = await supabaseAdmin
    .from('mb_intern_jobs')
    .select('id, status')
    .eq('user_id', userId)
    .or(`status.eq.queued,and(status.eq.working,heartbeat_at.lt."${stalledBefore}")`)
    .order('created_at', { ascending: true })
    .limit(5)

  for (const candidate of (waiting ?? []) as { id: string; status: string }[]) {
    const now = new Date().toISOString()
    let claim = supabaseAdmin
      .from('mb_intern_jobs')
      .update({ status: 'working', device, stage: 'Starting', heartbeat_at: now, updated_at: now })
      .eq('id', candidate.id)
      .eq('user_id', userId)
      .eq('status', candidate.status)
    // A stalled job is only taken if it is STILL stalled.
    if (candidate.status === 'working') claim = claim.lt('heartbeat_at', stalledBefore)
    const { data: job } = await claim.select(JOB_COLUMNS).maybeSingle()
    if (!job) continue

    const row = job as Record<string, unknown>
    const { data: version } = await supabaseAdmin
      .from('mb_versions')
      .select('id, version_number, label, status, audio_url, audio_filename, mix_check, mb_projects!inner(id, title, genre, bpm)')
      .eq('id', row.version_id as string)
      .maybeSingle()
    const v = version as unknown as {
      id: string; version_number: number; label: string | null; status: string; audio_url: string; audio_filename: string | null
      mix_check: { findings?: unknown; bands?: unknown; compared?: unknown; detail?: { sections?: unknown; resonances?: unknown } } | null
      mb_projects: { id: string; title: string; genre: string | null; bpm: number | null }
    } | null
    // The mix the notes were written against, as measured: with it the Mac can
    // judge a bounce itself before uploading anything.
    const earlier = v ? await previousVersionOf({ id: v.id, project_id: v.mb_projects.id, audio_url: v.audio_url }) : null
    // Every filename the song's mixes were uploaded under: a song renamed in
    // mixBASE still has its old name on the Mac, and the helper finds the
    // Logic project by name.
    const { data: siblings } = v
      ? await supabaseAdmin.from('mb_versions').select('audio_filename').eq('project_id', v.mb_projects.id).limit(200)
      : { data: null }
    const filenames = [...new Set((siblings ?? []).map(s => (s as { audio_filename: string | null }).audio_filename).filter((f): f is string => !!f))]
    // A mix the intern itself made was bounced from the intern's COPY of the
    // project, which is on the Mac in that job's folder: the next fix builds on
    // that copy, not on the owner's project (which never had the earlier fix).
    const { data: maker } = v
      ? await supabaseAdmin.from('mb_intern_jobs').select('id').eq('user_id', userId).eq('result_version_id', v.id).eq('status', 'done').order('created_at', { ascending: false }).limit(1).maybeSingle()
      : { data: null }
    const baseline = earlier && isMixCheckReport(earlier.mix_check)
      ? { version_id: earlier.id, label: versionDisplayLabel(earlier), summary: earlier.mix_check.summary }
      : null
    return NextResponse.json({
      job: jobView(row, Date.now()),
      song: v && {
        project_id: v.mb_projects.id,
        title: v.mb_projects.title,
        genre: v.mb_projects.genre,
        bpm: v.mb_projects.bpm,
        version_id: v.id,
        version_label: versionDisplayLabel(v),
        audio_filename: v.audio_filename,
        filenames,
        made_by_job_id: (maker as { id?: string } | null)?.id ?? null,
        audio_url: v.audio_url,
        // What Mix Check measured, so a fix can be worked out from numbers.
        findings: v.mix_check?.findings ?? [],
        bands: v.mix_check?.bands ?? [],
        compared: v.mix_check?.compared ?? null,
        sections: v.mix_check?.detail?.sections ?? [],
        // How far each narrow peak stands out ({ hz, db }), for the cut that answers a resonance note.
        resonances: v.mix_check?.detail?.resonances ?? [],
        baseline,
      },
    })
  }
  return NextResponse.json({ job: null })
}
