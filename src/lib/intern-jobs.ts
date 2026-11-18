// The mixing intern's jobs — the pure half: what a job is, which notes it is
// handed, and which reports from the Mac app are accepted. The routes
// (/api/versions/<id>/intern, /api/intern/jobs/*) do the database work.
// No '@/…' imports: scripts/intern-test.mjs loads this through Node.

export const INTERN_STATUSES = ['queued', 'working', 'done', 'failed', 'cancelled'] as const
export type InternStatus = (typeof INTERN_STATUSES)[number]

/** A working job the Mac app has not reported on for this long has stalled
 *  (the app was quit, the Mac slept). It is shown as such and can be re-queued. */
export const INTERN_STALL_MS = 4 * 60_000

/** The Mix Check byline (src/lib/mix-check-findings.ts MIX_CHECK_AUTHOR). */
const MIX_CHECK_BYLINE = 'Mix Check'

/** Mix Check findings the intern is never handed: comparisons with commercial
 *  references describe the owner's sound, not a fault in this mix. */
const NEVER_HANDED = (code: string) => code === 'genre.balance'

export type InternNote = {
  id: string
  /** 'mix-check' for a measured finding, 'listener' for a note someone wrote. */
  kind: 'mix-check' | 'listener'
  /** The finding's code (e.g. 'changed.sub') when kind is 'mix-check'. */
  code: string | null
  severity: string | null
  at: number | null
  author: string
  text: string
}

type FeedbackRow = { id: string; reviewer_name: string | null; comment: string | null; timestamp_seconds: number | null; resolved_at?: string | null }
type FindingRow = { code: string; severity?: string; note_id?: string | null }

/** The notes a new job is handed: every open note on the mix, with the Mix
 *  Check ones carrying their finding's code so a fix can be chosen by rule. */
export function notesForJob(feedback: FeedbackRow[], findings: FindingRow[]): InternNote[] {
  const byNote = new Map<string, FindingRow>()
  for (const f of findings) if (f.note_id) byNote.set(f.note_id, f)
  const out: InternNote[] = []
  for (const row of feedback) {
    if (row.resolved_at) continue
    const text = (row.comment ?? '').trim()
    if (!text) continue
    const measured = row.reviewer_name === MIX_CHECK_BYLINE
    const finding = measured ? byNote.get(row.id) ?? null : null
    // A Mix Check note whose finding is gone belongs to an older report.
    if (measured && !finding) continue
    if (finding && NEVER_HANDED(finding.code)) continue
    out.push({
      id: row.id,
      kind: measured ? 'mix-check' : 'listener',
      code: finding?.code ?? null,
      severity: finding?.severity ?? null,
      at: typeof row.timestamp_seconds === 'number' ? row.timestamp_seconds : null,
      author: (row.reviewer_name ?? '').slice(0, 80),
      text: text.slice(0, 2000),
    })
  }
  return out
}

export type InternChange = { track: string; what: string; from?: string; to?: string; note_id?: string }

const str = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined

/** What the Mac app may report about a job it holds. Unknown fields are
 *  dropped, and it can only finish a job, never re-open or re-queue one. */
export function sanitizeReport(raw: unknown): {
  stage?: string; status?: 'done' | 'failed'; error?: string; changes?: InternChange[]; result_version_id?: string
} | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const out: ReturnType<typeof sanitizeReport> = {}
  const stage = str(r.stage, 200)
  if (stage) out.stage = stage
  if (r.status === 'done' || r.status === 'failed') out.status = r.status
  const error = str(r.error, 500)
  if (error) out.error = error
  if (typeof r.result_version_id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r.result_version_id)) {
    out.result_version_id = r.result_version_id.toLowerCase()
  }
  if (Array.isArray(r.changes)) {
    out.changes = r.changes.slice(0, 200).flatMap((c): InternChange[] => {
      if (!c || typeof c !== 'object') return []
      const x = c as Record<string, unknown>
      const track = str(x.track, 120), what = str(x.what, 300)
      if (!track || !what) return []
      return [{ track, what, from: str(x.from, 80), to: str(x.to, 80), note_id: str(x.note_id, 40) }]
    })
  }
  return Object.keys(out).length ? out : null
}

/** How a job reads to the clients. `stalled` is a working job gone quiet. */
export function jobView(job: Record<string, unknown>, nowMs: number) {
  const beat = Date.parse(String(job.heartbeat_at ?? job.updated_at ?? ''))
  const stalled = job.status === 'working' && Number.isFinite(beat) && nowMs - beat > INTERN_STALL_MS
  return {
    id: job.id, status: job.status, stage: job.stage ?? null, stalled,
    notes: job.notes ?? [], changes: job.changes ?? [],
    result_version_id: job.result_version_id ?? null, error: job.error ?? null,
    device: job.device ?? null, created_at: job.created_at, updated_at: job.updated_at, finished_at: job.finished_at ?? null,
  }
}
