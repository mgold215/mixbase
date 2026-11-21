import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { isAdminIdentity } from '@/lib/admin-identity'
import { checkUserLimit, internLimiter, rateLimitHeaders } from '@/lib/rate-limit'
import { jobView, notesForJob } from '@/lib/intern-jobs.ts'
import { loadMixSession } from '@/lib/mix-session-server'
import { handoffStatus, type HandoffFinding, type HandoffJob, type HandoffStatus } from '@/lib/mix-session-intern.ts'

// The whole Mix Session, handed to the mixing intern (owner-only: both
// handlers 404 unless isAdminIdentity, like every other intern route).
//
//   GET   { songs, ready_count, in_flight_count, left_count, minutes } — what a
//         hand-off would do, song by song (src/lib/mix-session-intern.ts).
//   POST  starts a job for every song that is `ready`, then answers the same
//         shape plus { handed, failed }. Songs whose open notes the intern has
//         no rule for are not handed: a job would open Logic for ten minutes
//         and change nothing. They come back as `written-only`.
//
// One job per mix: a song with a job already waiting or working is left as it
// is (the database's one-active-per-mix index is the last word on that). The
// Mac takes the jobs one at a time, oldest first.

export const dynamic = 'force-dynamic'

const JOB_COLUMNS = 'id, version_id, status, stage, heartbeat_at, updated_at, created_at'
// PostgREST takes `in.(…)` filters in the query string; batching keeps a big catalog from producing a URL the gateway refuses.
const IN_BATCH = 100

type VersionRow = { id: string; project_id: string; mix_check: { findings?: (HandoffFinding & { severity?: string })[] } | null }

async function gate(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  if (!(await isAdminIdentity(userId))) return { error: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  const rl = await checkUserLimit(internLimiter, userId)
  if (!rl.allowed) return { error: NextResponse.json({ error: 'Too many requests — try again later' }, { status: 429, headers: rateLimitHeaders(rl) }) }
  return { userId }
}

function batches<T>(items: T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += IN_BATCH) out.push(items.slice(i, i + IN_BATCH))
  return out
}

/** The session, each current mix's findings, and the newest job on each: everything the status is made of. */
async function load(userId: string): Promise<{ status: HandoffStatus; versions: Map<string, VersionRow> }> {
  const { session } = await loadMixSession(userId)
  const ids = session.songs.filter(s => s.open_count > 0).map(s => s.version.id)
  const versions = new Map<string, VersionRow>()
  const jobs = new Map<string, HandoffJob>()
  for (const batch of batches(ids)) {
    // The ids come from loadMixSession, which only reads the caller's own projects.
    const { data: rows, error } = await supabaseAdmin.from('mb_versions').select('id, project_id, mix_check').in('id', batch)
    if (error) throw new Error(error.message)
    for (const row of (rows ?? []) as unknown as VersionRow[]) versions.set(row.id, row)
    const { data: jobRows, error: jobError } = await supabaseAdmin
      .from('mb_intern_jobs')
      .select(JOB_COLUMNS)
      .eq('user_id', userId)
      .in('version_id', batch)
      .order('created_at', { ascending: false })
    if (jobError) throw new Error(jobError.message)
    for (const row of (jobRows ?? []) as Record<string, unknown>[]) {
      const versionId = row.version_id as string
      if (jobs.has(versionId)) continue // newest first: the first one seen is the newest
      const view = jobView(row, Date.now())
      jobs.set(versionId, { status: String(view.status), stage: view.stage as string | null, stalled: view.stalled })
    }
  }
  const findings = new Map([...versions].map(([id, v]) => [id, v.mix_check?.findings ?? []]))
  return { status: handoffStatus(session, findings, jobs), versions }
}

export async function GET(request: NextRequest) {
  const g = await gate(request)
  if (g.error) return g.error
  try {
    return NextResponse.json((await load(g.userId)).status)
  } catch (err) {
    console.error('[mix-session/intern] status failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Could not read your mix session. Try again.' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const g = await gate(request)
  if (g.error) return g.error
  try {
    const { status, versions } = await load(g.userId)
    let handed = 0, failed = 0
    for (const song of status.songs) {
      if (song.state !== 'ready') continue
      const version = versions.get(song.version_id)
      if (!version) { failed++; continue }
      const { data: feedback, error: readError } = await supabaseAdmin
        .from('mb_feedback')
        .select('id, reviewer_name, comment, timestamp_seconds, resolved_at')
        .eq('version_id', version.id)
        .order('timestamp_seconds', { ascending: true, nullsFirst: false })
      if (readError) { failed++; continue }
      // The same notes the song's own "Hand to the intern" button hands over: every open one.
      const notes = notesForJob(feedback ?? [], version.mix_check?.findings ?? [])
      if (!notes.length) continue
      const { error } = await supabaseAdmin
        .from('mb_intern_jobs')
        .insert({ user_id: g.userId, project_id: version.project_id, version_id: version.id, notes })
      if (!error) { handed++; continue }
      // The one-active-per-mix index: another tap (or the song's own button) got there first. That is not a failure.
      const { data: raced } = await supabaseAdmin
        .from('mb_intern_jobs')
        .select('id')
        .eq('user_id', g.userId)
        .eq('version_id', version.id)
        .in('status', ['queued', 'working'])
        .limit(1)
      if (!raced?.length) { failed++; console.error('[mix-session/intern] job not created:', error.message) }
    }
    const after = await load(g.userId)
    return NextResponse.json({ ...after.status, handed, failed }, { status: handed ? 201 : 200 })
  } catch (err) {
    console.error('[mix-session/intern] hand-off failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Could not hand the session over. Try again.' }, { status: 500 })
  }
}
