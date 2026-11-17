import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { isUuid } from '@/lib/validators'
import { isAdminIdentity } from '@/lib/admin-identity'
import { checkUserLimit, mixCheckLimiter, rateLimitHeaders } from '@/lib/rate-limit'
import { THIRD_OCTAVE_HZ } from '@/lib/mix-check.ts'
import { GENRE_FAMILIES, MIX_CHECK_AUTHOR, withMarker } from '@/lib/mix-check-findings.ts'
import { isMixCheckReport, loudnessForReport, mixCheckState, startMixCheck } from '@/lib/mix-check-server'
import { ensureVersionMixCheckColumn, isMissingMixCheckColumn } from '@/lib/schema-heal'

// Mix Check on one mix (owner-only, like the Cassette Studio: every handler
// 404s unless isAdminIdentity, and the clients learn that from
// GET /api/auth/me → owner_tools).
//
//   POST  start a check of this mix. 202 { status: 'running' }.
//   GET   { status: 'none' | 'running' | 'done' | 'error', report?, notes?, loudness?, options?, error? }
//
// `loudness` is the mix's loudness reading (the mb_versions columns Master
// Check writes): a check measures it too, and the clients show both as one card.
//
// The check itself is src/lib/mix-check-server.ts: an in-process job (lost on
// deploy by design) whose RESULT is stored on the version row, so GET answers
// 'done' with the stored report from then on — after a reload, a deploy, or on
// the other client. Its STATE is on the row as well (a marker), so 'running'
// is the answer from every process, not only the one doing the work. `notes` are the Mix Check notes now on the mix, in the shape
// the project page holds its feedback in, so a client can show them at once.

export const dynamic = 'force-dynamic'

// What a client needs to draw the report and to file a reference, served so
// neither copies a list the server owns (the app's rule: lists come by GET).
const OPTIONS = {
  third_octave_hz: THIRD_OCTAVE_HZ,
  families: GENRE_FAMILIES.map(f => ({ key: f.key, label: f.label })),
}

const NOTE_COLUMNS = 'id, version_id, reviewer_name, rating, comment, timestamp_seconds, created_at'

async function ownedVersion(versionId: string, userId: string) {
  // Migration 045's column is healed on first miss, like every added column.
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await supabaseAdmin
      .from('mb_versions')
      .select('id, mix_check, mb_projects!inner(user_id)')
      .eq('id', versionId)
      .eq('mb_projects.user_id', userId)
      .maybeSingle()
    if (!error) return data as { id: string; mix_check: unknown } | null
    if (attempt === 0 && isMissingMixCheckColumn(error) && await ensureVersionMixCheckColumn()) continue
    return null
  }
  return null
}

async function gate(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  if (!(await isAdminIdentity(userId))) return { error: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  const { id } = await ctx.params
  if (!isUuid(id)) return { error: NextResponse.json({ error: 'Invalid id' }, { status: 400 }) }
  return { userId, id }
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const g = await gate(request, ctx)
  if (g.error) return g.error
  const version = await ownedVersion(g.id, g.userId)
  if (!version) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // This process's job, or the marker another process left on the row.
  const job = mixCheckState(g.id, version.mix_check)
  if (job?.state === 'running') return NextResponse.json({ status: 'running' })
  if (job?.state === 'error') return NextResponse.json({ status: 'error', error: job.error })

  // A version measured only as another mix's comparison has a summary and no
  // findings: that is not a finished check of THIS mix.
  const stored = isMixCheckReport(version.mix_check) && version.mix_check.findings ? version.mix_check : null
  if (!stored) return NextResponse.json({ status: 'none' })
  // The marker is the server's own bookkeeping, not part of the report.
  const report = withMarker(stored, null)

  const [{ data: notes }, loudness] = await Promise.all([
    supabaseAdmin
      .from('mb_feedback')
      .select(NOTE_COLUMNS)
      .eq('version_id', g.id)
      .eq('reviewer_name', MIX_CHECK_AUTHOR)
      .order('timestamp_seconds', { ascending: true, nullsFirst: false }),
    loudnessForReport(g.id, stored),
  ])
  return NextResponse.json({ status: 'done', report, notes: notes ?? [], loudness, options: OPTIONS })
}

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const g = await gate(request, ctx)
  if (g.error) return g.error

  const rl = await checkUserLimit(mixCheckLimiter, g.userId)
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many checks — try again later' }, { status: 429, headers: rateLimitHeaders(rl) })
  }
  const version = await ownedVersion(g.id, g.userId)
  if (!version) {
    mixCheckLimiter.rollback(g.userId)
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  // Already running (here or in another process) is the same answer: poll.
  await startMixCheck(g.id, g.userId, version.mix_check)
  return NextResponse.json({ status: 'running' }, { status: 202 })
}
