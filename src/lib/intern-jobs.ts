// The mixing intern's jobs — the pure half: what a job is, which notes it is
// handed, and which reports from the Mac app are accepted. The routes
// (/api/versions/<id>/intern, /api/intern/jobs/*) do the database work.
// No '@/…' imports: scripts/intern-test.mjs loads this through Node.

export const INTERN_STATUSES = ['queued', 'working', 'done', 'failed', 'cancelled'] as const
export type InternStatus = (typeof INTERN_STATUSES)[number]

/** A working job the Mac app has not reported on for this long has stalled
 *  (the app was quit, the Mac slept). It is shown as such and can be re-queued. */
export const INTERN_STALL_MS = 4 * 60_000

/**
 * Whether a mix has a note the intern has a rule for: a band that changed
 * since the previous version (`changed.<band>`; loudness is not a band). The
 * clients offer "Hand to the intern" on this, so the button is never there
 * for notes it would only skip.
 */
export function internCanFix(findings: { code: string }[] | null | undefined): boolean {
  return (findings ?? []).some(f => /^changed\.(?!loudness$)[A-Za-z]+$/.test(f.code))
}

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

/**
 * Which version number a mix's "previous version" must be older than.
 * Normally its own. A bounce the intern uploaded for a job (the job's
 * `result_version_id`) is compared as the mix it fixes was, so the bound is
 * that mix's number; and a fix of a fix follows the chain back to the mix the
 * owner made. Null when the version is not one of the song's.
 */
export function comparedBefore(
  versionId: string,
  versions: { id: string; version_number: number }[],
  jobs: { version_id: string; result_version_id: string | null }[],
): number | null {
  const number = new Map(versions.map(v => [v.id, v.version_number]))
  let bound = number.get(versionId)
  if (bound == null) return null
  let current = versionId
  for (let hop = 0; hop < 20; hop++) {
    const job = jobs.find(j => j.result_version_id === current)
    const fixed = job ? number.get(job.version_id) : undefined
    // Only ever backwards: a job pointing at a newer mix is not this one's origin.
    if (!job || fixed == null || fixed >= bound) break
    bound = fixed
    current = job.version_id
  }
  return bound
}

export type InternChange = { track: string; what: string; from?: string; to?: string; note_id?: string }

/** One line of a job's step log. `detail` marks what was found or set inside a stage. */
export type InternStep = { at: string; text: string; detail?: boolean }

/** A job keeps at most this many steps. */
export const INTERN_MAX_STEPS = 80

/**
 * A job's step log with the next report added: the stage it says it reached
 * (once: every heartbeat repeats the stage) and the detail line it sent.
 */
export function withSteps(steps: unknown, report: { stage?: string; step?: string }, at: string): InternStep[] {
  const out: InternStep[] = (Array.isArray(steps) ? steps : []).flatMap((s): InternStep[] => {
    if (!s || typeof s !== 'object') return []
    const x = s as Record<string, unknown>
    return typeof x.text === 'string' && typeof x.at === 'string' ? [{ at: x.at, text: x.text, ...(x.detail === true ? { detail: true } : {}) }] : []
  })
  const lastStage = [...out].reverse().find(s => !s.detail)?.text
  if (report.stage && report.stage !== lastStage) out.push({ at, text: report.stage })
  if (report.step) out.push({ at, text: report.step, detail: true })
  return out.slice(-INTERN_MAX_STEPS)
}

const str = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined

/** What the Mac app may report about a job it holds. Unknown fields are
 *  dropped, and it can only finish a job, never re-open or re-queue one. */
export function sanitizeReport(raw: unknown): {
  stage?: string; step?: string; status?: 'done' | 'failed'; error?: string; changes?: InternChange[]; result_version_id?: string
} | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const out: ReturnType<typeof sanitizeReport> = {}
  const stage = str(r.stage, 200)
  if (stage) out.stage = stage
  const step = str(r.step, 300)
  if (step) out.step = step
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

// ── What a fix changed, measured ──────────────────────────────────────────────

type ReportLike = {
  summary?: { i?: number; tp?: number } | null
  bands?: { key: string; label: string; range: string; vsPrevious: number | null }[]
  findings?: { code: string; severity?: string; title?: string }[]
  compared?: { previous?: string | null } | null
}

export type InternComparison = {
  from: string
  to: string
  /** The earlier mix both were measured against, when it is the same one. */
  against: string | null
  bands: { key: string; label: string; range: string; from: number | null; to: number | null }[]
  loudness: { from: number | null; to: number | null }
  truePeak: { from: number | null; to: number | null }
  notes: { state: 'cleared' | 'still' | 'new'; severity: string; before: string | null; after: string | null }[]
}

type Titled = { code: string; severity?: string; title?: string }

/** Two timed notes of a kind this many seconds apart are the same note, moved. */
const NOTE_SAME_PLACE_S = 40
/** The second a note is tied to ('drop.smaller@48' → 48), or null for a whole-mix note. */
const noteSecond = (code: string) => {
  const m = /@(\d+)$/.exec(code)
  return m ? Number(m[1]) : null
}

/** A note's kind without its place (see judgeFix in intern-rules.ts). */
const noteKind = (code: string) => (code.startsWith('resonance.') ? 'resonance' : code.split('@')[0])

/**
 * The mix that was handed over beside the version the intern made from it:
 * each band against the same earlier mix, the loudness, and which notes
 * cleared, stayed or are new. Both sides are the stored Mix Check reports, so
 * nothing is measured here. Null when either has no full report.
 */
export function internComparison(
  from: { label: string; report: ReportLike | null },
  to: { label: string; report: ReportLike | null },
): InternComparison | null {
  const a = from.report, b = to.report
  if (!a?.bands?.length || !b?.bands?.length) return null
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const bands = a.bands.map(band => {
    const other = b.bands!.find(x => x.key === band.key)
    return { key: band.key, label: band.label, range: band.range, from: num(band.vsPrevious), to: num(other?.vsPrevious) }
  })
  const notes: InternComparison['notes'] = []
  const before = a.findings ?? [], after = b.findings ?? []
  const kinds = [...new Set([...before, ...after].map(f => noteKind(f.code)))]
  const line = (state: 'cleared' | 'still' | 'new', w?: Titled, n?: Titled) =>
    notes.push({ state, severity: String((n ?? w)?.severity ?? 'low'), before: w?.title ?? null, after: n?.title ?? null })
  for (const kind of kinds) {
    const was = before.filter(f => noteKind(f.code) === kind)
    const is = after.filter(f => noteKind(f.code) === kind)
    // A note tied to a moment is the same note only near the same moment: the
    // nearest one within NOTE_SAME_PLACE_S. A whole-mix note is matched by kind.
    for (const w of was) {
      const at = noteSecond(w.code)
      let best = -1
      is.forEach((n, i) => {
        const there = noteSecond(n.code)
        if (at == null || there == null) { if (at == null && there == null && best < 0) best = i; return }
        if (Math.abs(there - at) <= NOTE_SAME_PLACE_S && (best < 0 || Math.abs(there - at) < Math.abs((noteSecond(is[best].code) ?? Infinity) - at))) best = i
      })
      if (best >= 0) line('still', w, is.splice(best, 1)[0]); else line('cleared', w)
    }
    for (const n of is) line('new', undefined, n)
  }
  const order = { cleared: 0, still: 1, new: 2 }
  notes.sort((x, y) => order[x.state] - order[y.state])
  const same = a.compared?.previous && a.compared.previous === b.compared?.previous ? a.compared.previous : null
  return {
    from: from.label, to: to.label, against: same, bands,
    loudness: { from: num(a.summary?.i), to: num(b.summary?.i) },
    truePeak: { from: num(a.summary?.tp), to: num(b.summary?.tp) },
    notes,
  }
}
