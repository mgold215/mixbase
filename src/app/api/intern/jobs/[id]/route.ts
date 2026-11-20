import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { isUuid } from '@/lib/validators'
import { isAdminIdentity } from '@/lib/admin-identity'
import { checkUserLimit, internLimiter, rateLimitHeaders } from '@/lib/rate-limit'
import { ownsVersion } from '@/lib/ownership'
import { jobView, sanitizeReport, withSteps } from '@/lib/intern-jobs.ts'
import { ensureInternStepsColumn, isMissingInternStepsColumn } from '@/lib/schema-heal'

// PATCH /api/intern/jobs/<id> — the Mac app reports on a job it holds
// (owner-only): the stage it is at, the changes it has made so far, and at the
// end 'done' with the version it uploaded, or 'failed' with why.
//
// Every report is also the heartbeat. The answer carries the job as the server
// now has it; `status: 'cancelled'` there means the owner stopped it, and the
// app must put the project back and stop. A report on a job that is no longer
// working changes nothing.

export const dynamic = 'force-dynamic'

const JOB_COLUMNS = 'id, status, stage, notes, changes, result_version_id, error, device, created_at, updated_at, heartbeat_at, finished_at'

async function appendSteps(id: string, userId: string, report: { stage?: string; step?: string }, now: string) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await supabaseAdmin.from('mb_intern_jobs').select('steps').eq('id', id).eq('user_id', userId).maybeSingle()
    if (error) {
      if (attempt === 0 && isMissingInternStepsColumn(error) && await ensureInternStepsColumn()) continue
      console.error('[intern] steps not read:', error.message)
      return
    }
    const before = (data as { steps?: unknown } | null)?.steps
    const steps = withSteps(before, report, now)
    if (Array.isArray(before) && steps.length === before.length) return
    const { error: writeError } = await supabaseAdmin.from('mb_intern_jobs').update({ steps }).eq('id', id).eq('user_id', userId)
    if (writeError) console.error('[intern] steps not written:', writeError.message)
    return
  }
}

export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!(await isAdminIdentity(userId))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { id } = await ctx.params
  if (!isUuid(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  const rl = await checkUserLimit(internLimiter, userId)
  if (!rl.allowed) return NextResponse.json({ error: 'Too many requests — try again later' }, { status: 429, headers: rateLimitHeaders(rl) })

  const report = sanitizeReport(await request.json().catch(() => null))
  if (!report) return NextResponse.json({ error: 'Nothing to report' }, { status: 400 })
  // The version it says it uploaded must be one of the owner's own.
  if (report.result_version_id && !(await ownsVersion(report.result_version_id, userId))) {
    return NextResponse.json({ error: 'Unknown version' }, { status: 400 })
  }

  const now = new Date().toISOString()
  const patch: Record<string, unknown> = { heartbeat_at: now, updated_at: now }
  if (report.stage) patch.stage = report.stage
  if (report.changes) patch.changes = report.changes
  if (report.error) patch.error = report.error
  if (report.result_version_id) patch.result_version_id = report.result_version_id
  if (report.status) { patch.status = report.status; patch.finished_at = now }

  const { data: updated } = await supabaseAdmin
    .from('mb_intern_jobs')
    .update(patch)
    .eq('id', id)
    .eq('user_id', userId)
    .eq('status', 'working')
    .select(JOB_COLUMNS)
    .maybeSingle()
  if (updated) {
    // The step log: every stage reached and every detail line, in order. In a
    // query of its own (migration 048's column is healed on first miss), and
    // never a reason for the report itself to fail.
    if (report.stage || report.step) await appendSteps(id, userId, report, now)
    return NextResponse.json({ job: jobView(updated as Record<string, unknown>, Date.now()) })
  }

  // Not working any more (cancelled, finished, or never this owner's): say what it is.
  const { data: current } = await supabaseAdmin
    .from('mb_intern_jobs')
    .select(JOB_COLUMNS)
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle()
  if (!current) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ job: jobView(current as Record<string, unknown>, Date.now()) }, { status: 409 })
}
