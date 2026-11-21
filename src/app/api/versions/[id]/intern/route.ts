import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { isUuid } from '@/lib/validators'
import { isAdminIdentity } from '@/lib/admin-identity'
import { checkUserLimit, internLimiter, rateLimitHeaders } from '@/lib/rate-limit'
import { internCanFix, internComparison, jobView, notesForJob } from '@/lib/intern-jobs.ts'
import { ensureInternStepsColumn, isMissingInternStepsColumn } from '@/lib/schema-heal'
import { versionDisplayLabel } from '@/lib/mix-status.ts'

// The mixing intern on one mix (owner-only: every handler 404s unless
// isAdminIdentity, like Mix Check).
//
//   POST    hand this mix's open notes to the intern. 201 { job }, or 200 with
//           the job already in flight for this mix.
//   GET     { job, made_by, comparison } — the newest job for this mix (or null);
//           when this mix is one the intern uploaded, the job that made it; each
//           with its step log; and the handed mix beside the intern's version.
//   DELETE  cancel the job in flight. The Mac app learns it on its next report.
//
// The work happens on the owner's Mac: the mixBASE Mac app claims the job
// (POST /api/intern/jobs/claim) and reports on it (PATCH /api/intern/jobs/<id>).

export const dynamic = 'force-dynamic'

const JOB_COLUMNS = 'id, version_id, status, stage, notes, changes, result_version_id, error, device, created_at, updated_at, heartbeat_at, finished_at'

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

/** The job that MADE this version: an intern's upload shows what was done to make it. */
async function madeBy(versionId: string, userId: string) {
  const { data } = await supabaseAdmin
    .from('mb_intern_jobs')
    .select(JOB_COLUMNS)
    .eq('result_version_id', versionId)
    .eq('user_id', userId)
    .eq('status', 'done')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data as Record<string, unknown> | null
}

/** A job's step log, read in a query of its own (migration 048's column is healed on first miss). */
async function stepsOf(jobId: string, userId: string): Promise<unknown[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await supabaseAdmin.from('mb_intern_jobs').select('steps').eq('id', jobId).eq('user_id', userId).maybeSingle()
    if (!error) {
      const steps = (data as { steps?: unknown } | null)?.steps
      return Array.isArray(steps) ? steps : []
    }
    if (attempt === 0 && isMissingInternStepsColumn(error) && await ensureInternStepsColumn()) continue
    console.error('[intern] steps not read:', error.message)
    break
  }
  return []
}

/** The handed mix beside the version the intern made from it, from their stored Mix Check reports. */
async function comparisonFor(job: Record<string, unknown>, userId: string) {
  const fromId = job.version_id as string | null, toId = job.result_version_id as string | null
  if (job.status !== 'done' || !fromId || !toId) return null
  const { data, error } = await supabaseAdmin
    .from('mb_versions')
    .select('id, version_number, label, status, audio_filename, mix_check, mb_projects!inner(user_id)')
    .in('id', [fromId, toId])
    .eq('mb_projects.user_id', userId)
  if (error || !data) return null
  type Row = { id: string; version_number: number; label: string | null; status: string; audio_filename: string | null; mix_check: Parameters<typeof internComparison>[0]['report'] }
  const rows = data as unknown as Row[]
  const from = rows.find(r => r.id === fromId), to = rows.find(r => r.id === toId)
  if (!from || !to) return null
  return internComparison({ label: versionDisplayLabel(from), report: from.mix_check }, { label: versionDisplayLabel(to), report: to.mix_check })
}

/** How many notes a hand-off would carry: the same ones POST files (never the genre note, never a ticked-off one). */
async function openNotesOn(version: { id: string; mix_check: { findings?: { code: string; severity?: string; note_id?: string | null }[] } | null }): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from('mb_feedback')
    .select('id, reviewer_name, comment, timestamp_seconds, resolved_at')
    .eq('version_id', version.id)
  if (error) return 0
  return notesForJob(data ?? [], version.mix_check?.findings ?? []).length
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const g = await gate(request, ctx)
  if (g.error) return g.error
  const [job, made] = await Promise.all([newest(g.version.id, g.userId), madeBy(g.version.id, g.userId)])
  // The job this card is about: the one that made this version, else the newest on it.
  const subject = made ?? job
  const [jobSteps, madeSteps, comparison, openNotes] = await Promise.all([
    job ? stepsOf(job.id as string, g.userId) : [],
    made ? stepsOf(made.id as string, g.userId) : [],
    subject ? comparisonFor(subject, g.userId) : null,
    openNotesOn(g.version),
  ])
  return NextResponse.json({
    job: job ? { ...jobView(job, Date.now()), steps: jobSteps } : null,
    made_by: made ? { ...jobView(made, Date.now()), steps: madeSteps } : null,
    comparison,
    // The clients offer the button on this: any open note can be handed over (the
    // owner, 2026-11-20: "hand off all to intern"). Each comes back fixed, tried, or
    // left with the reason. `can_fix` says whether at least one has a rule today.
    can_hand: openNotes > 0,
    can_fix: internCanFix(g.version.mix_check?.findings),
  })
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
