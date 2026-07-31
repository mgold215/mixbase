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
