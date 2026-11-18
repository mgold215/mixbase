import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { isUuid } from '@/lib/validators'
import { isAdminIdentity } from '@/lib/admin-identity'
import { checkUserLimit, internLimiter, rateLimitHeaders } from '@/lib/rate-limit'
import { jobView, notesForJob } from '@/lib/intern-jobs.ts'

// The mixing intern on one mix (owner-only: every handler 404s unless
// isAdminIdentity, like Mix Check).
//
//   POST    hand this mix's open notes to the intern. 201 { job }, or 200 with
//           the job already in flight for this mix.
//   GET     { job } — the newest job for this mix, or { job: null }.
//   DELETE  cancel the job in flight. The Mac app learns it on its next report.
//
// The work happens on the owner's Mac: the mixBASE Mac app claims the job
// (POST /api/intern/jobs/claim) and reports on it (PATCH /api/intern/jobs/<id>).

export const dynamic = 'force-dynamic'

const JOB_COLUMNS = 'id, status, stage, notes, changes, result_version_id, error, device, created_at, updated_at, heartbeat_at, finished_at'

async function gate(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  if (!(await isAdminIdentity(userId))) return { error: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  const { id } = await ctx.params
  if (!isUuid(id)) return { error: NextResponse.json({ error: 'Invalid id' }, { status: 400 }) }
  const rl = await checkUserLimit(internLimiter, userId)
  if (!rl.allowed) return { error: NextResponse.json({ error: 'Too many requests — try again later' }, { status: 429, headers: rateLimitHeaders(rl) }) }
  const { data: version } = await supabaseAdmin
    .from('mb_versions')
    .select('id, project_id, mix_check, mb_projects!inner(user_id)')
    .eq('id', id)
    .eq('mb_projects.user_id', userId)
    .maybeSingle()
  if (!version) return { error: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  return { userId, version: version as unknown as { id: string; project_id: string; mix_check: { findings?: { code: string; severity?: string; note_id?: string | null }[] } | null } }
}

async function newest(versionId: string, userId: string) {
  const { data } = await supabaseAdmin
    .from('mb_intern_jobs')
    .select(JOB_COLUMNS)
    .eq('version_id', versionId)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data as Record<string, unknown> | null
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const g = await gate(request, ctx)
  if (g.error) return g.error
  const job = await newest(g.version.id, g.userId)
  return NextResponse.json({ job: job ? jobView(job, Date.now()) : null })
}

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const g = await gate(request, ctx)
  if (g.error) return g.error

  const held = await newest(g.version.id, g.userId)
  if (held && (held.status === 'queued' || held.status === 'working')) {
    return NextResponse.json({ job: jobView(held, Date.now()) })
  }

  const { data: feedback, error: readError } = await supabaseAdmin
    .from('mb_feedback')
    .select('id, reviewer_name, comment, timestamp_seconds, resolved_at')
    .eq('version_id', g.version.id)
    .order('timestamp_seconds', { ascending: true, nullsFirst: false })
  if (readError) return NextResponse.json({ error: 'Could not read the notes' }, { status: 500 })
  const notes = notesForJob(feedback ?? [], g.version.mix_check?.findings ?? [])
  if (!notes.length) return NextResponse.json({ error: 'There are no open notes on this mix to hand over' }, { status: 409 })

  const { data: job, error } = await supabaseAdmin
    .from('mb_intern_jobs')
    .insert({ user_id: g.userId, project_id: g.version.project_id, version_id: g.version.id, notes })
    .select(JOB_COLUMNS)
    .single()
  if (error || !job) {
    // The one-active-per-mix index: another tap got there first.
    const raced = await newest(g.version.id, g.userId)
    if (raced && (raced.status === 'queued' || raced.status === 'working')) return NextResponse.json({ job: jobView(raced, Date.now()) })
    console.error('[intern] job not created:', error?.message)
    return NextResponse.json({ error: 'Could not start the job' }, { status: 500 })
  }
  return NextResponse.json({ job: jobView(job as Record<string, unknown>, Date.now()) }, { status: 201 })
}

export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const g = await gate(request, ctx)
  if (g.error) return g.error
  const now = new Date().toISOString()
  const { error } = await supabaseAdmin
    .from('mb_intern_jobs')
    .update({ status: 'cancelled', finished_at: now, updated_at: now })
    .eq('version_id', g.version.id)
    .eq('user_id', g.userId)
    .in('status', ['queued', 'working'])
  if (error) return NextResponse.json({ error: 'Could not cancel the job' }, { status: 500 })
  const job = await newest(g.version.id, g.userId)
  return NextResponse.json({ job: job ? jobView(job, Date.now()) : null })
}
