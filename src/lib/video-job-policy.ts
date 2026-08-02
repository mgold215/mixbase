// ── Video job retention policy ───────────────────────────────────────────────
// Pure, dependency-free, and deliberately in its own module: `video-jobs.ts`
// reaches for the `@/` alias (and for Supabase), which plain Node can't resolve,
// so the retention rules would otherwise be untestable without a bundler. Same
// reason `video-render.ts` imports `./finalize-render.ts` relatively.

export type ReapableJobStatus = 'rendering' | 'uploading' | 'done' | 'error'

/** How long a FINISHED job stays readable so the client can collect its result. */
export const JOB_TTL_MS = 60 * 60 * 1000

/**
 * Backstop for a job that never settles at all. Every ffmpeg stage now carries
 * its own wall-clock and idle deadline (see `videoStageTimeoutMs` /
 * `videoStageIdleMs`), so the slowest legitimate render fails far inside this
 * window. It still matters because an in-flight job holds one of the GLOBAL
 * MAX_CONCURRENT slots: a wedged job denies renders to every other user.
 */
export const STUCK_JOB_MS = 6 * JOB_TTL_MS

/**
 * Wall-clock budget for the post-render UPLOAD phase (bucket-limit heal +
 * storeVisualizer).
 *
 * Every ffmpeg stage settles under its own deadline, but the upload that
 * follows had none: `ensureVideoBucketLimit()` is a Management-API fetch with
 * no signal, and `storeVisualizer()` pushes up to ~380 MB to Supabase. Either
 * can hang indefinitely, and a job parked in `'uploading'` still counts toward
 * BOTH `activeCount()` (a global MAX_CONCURRENT slot) and `activeJobForUser()`
 * (the per-user single-flight) — so one stalled socket 409s that user with
 * `user_busy` and taxes everyone else until STUCK_JOB_MS reaps it 6 hours later.
 *
 * Generous enough that a slow-but-real upload of the largest supported render
 * finishes comfortably; the point is that the phase always settles.
 */
export const UPLOAD_PHASE_MS = 15 * 60 * 1000

/**
 * Whether a job should be dropped from the in-process map. Pure — the caller
 * supplies `now`, so the whole retention state space is unit-testable without
 * waiting hours.
 *
 * Note the asymmetry is intentional: a finished job is reaped relatively
 * eagerly, but an in-flight one must NEVER be reaped early. Dropping a job
 * whose ffmpeg child is still alive frees its concurrency slot *and* its
 * per-user single-flight guard while the real work continues, which lets actual
 * in-flight renders exceed MAX_CONCURRENT without bound.
 */
export function shouldReapJob(
  job: { status: ReapableJobStatus; createdAt: number },
  now: number,
): boolean {
  const age = now - job.createdAt
  const finished = job.status === 'done' || job.status === 'error'
  return finished ? age > JOB_TTL_MS : age > STUCK_JOB_MS
}
