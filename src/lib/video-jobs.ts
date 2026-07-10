import { randomUUID } from 'crypto'
import { buildFinalVideo, type VideoFormat, type BuildVideoArgs } from '@/lib/video-render'
import { storeVisualizer } from '@/lib/visualizer-store'
import { ensureVideoBucketLimit } from '@/lib/schema-heal'

// ── In-process video render jobs ─────────────────────────────────────────────
// A full-song encode takes minutes, far beyond an acceptable HTTP request, so
// POST /api/finalize-video starts a job here and the client polls GET for
// progress. State is in-memory by design — the same tradeoff as the app's rate
// limiters: a deploy mid-render loses the job and the client surfaces
// "interrupted, try again". No queue infra, no orphaned rows.

export type VideoJobStatus = 'rendering' | 'uploading' | 'done' | 'error'

export type VideoJob = {
  id: string
  userId: string
  projectId: string
  format: VideoFormat
  status: VideoJobStatus
  /** 0..1 */
  progress: number
  stage: string
  resultUrl?: string
  error?: string
  createdAt: number
}

const jobs = new Map<string, VideoJob>()

// Encoding saturates a core — bound concurrency so renders can't pile up and
// starve the web server. Per-user single-flight keeps one person from queueing
// several multi-minute encodes at once.
const MAX_CONCURRENT = 2
const JOB_TTL_MS = 60 * 60 * 1000

function pruneJobs() {
  const now = Date.now()
  for (const [id, job] of jobs) {
    const finished = job.status === 'done' || job.status === 'error'
    if ((finished && now - job.createdAt > JOB_TTL_MS) || now - job.createdAt > 6 * JOB_TTL_MS) {
      jobs.delete(id)
    }
  }
}

function activeCount(): number {
  let n = 0
  for (const job of jobs.values()) {
    if (job.status === 'rendering' || job.status === 'uploading') n++
  }
  return n
}

export function activeJobForUser(userId: string): VideoJob | null {
  for (const job of jobs.values()) {
    if (job.userId === userId && (job.status === 'rendering' || job.status === 'uploading')) return job
  }
  return null
}

export function getVideoJob(id: string): VideoJob | null {
  return jobs.get(id) ?? null
}

export type StartJobArgs = Omit<BuildVideoArgs, 'onProgress'> & {
  userId: string
  projectId: string
}

export type StartJobResult =
  | { ok: true; job: VideoJob }
  | { ok: false; code: 'user_busy' | 'server_busy'; existing?: VideoJob }

export function startVideoJob(args: StartJobArgs): StartJobResult {
  pruneJobs()

  const existing = activeJobForUser(args.userId)
  if (existing) return { ok: false, code: 'user_busy', existing }
  if (activeCount() >= MAX_CONCURRENT) return { ok: false, code: 'server_busy' }

  const job: VideoJob = {
    id: randomUUID(),
    userId: args.userId,
    projectId: args.projectId,
    format: args.format,
    status: 'rendering',
    progress: 0,
    stage: 'Starting',
    createdAt: Date.now(),
  }
  jobs.set(job.id, job)

  // Fire and forget — the render continues after the POST response returns.
  void runJob(job, args)

  return { ok: true, job }
}

async function runJob(job: VideoJob, args: StartJobArgs) {
  try {
    const built = await buildFinalVideo({
      visualizerUrl: args.visualizerUrl,
      audioUrl: args.audioUrl,
      title: args.title,
      artist: args.artist,
      format: args.format,
      color: args.color,
      startSec: args.startSec,
      clipSeconds: args.clipSeconds,
      fallbackAudioSeconds: args.fallbackAudioSeconds,
      onProgress: (frac, stage) => {
        job.progress = Math.min(0.95, frac)
        job.stage = stage
      },
    })

    job.status = 'uploading'
    job.stage = 'Saving to Media'
    job.progress = 0.96

    // The bucket was created with a 50 MB cap; full songs exceed it. Raise it
    // (idempotent, direct SQL — see schema-heal) before uploading big files.
    if (built.bytes.length > 45 * 1024 * 1024) await ensureVideoBucketLimit()

    const mins = Math.floor(built.durationSec / 60)
    const secs = Math.round(built.durationSec % 60).toString().padStart(2, '0')
    const stored = await storeVisualizer({
      userId: args.userId,
      projectId: args.projectId,
      bytes: built.bytes,
      contentType: 'video/mp4',
      kind: args.format,
      title: args.format === 'youtube' ? `YouTube · ${mins}:${secs}` : `Short · ${mins}:${secs}`,
    })
    if (!stored) throw new Error('Rendered fine but saving to storage failed — try again')

    job.resultUrl = stored.video_url
    job.progress = 1
    job.stage = 'Done'
    job.status = 'done'
  } catch (e) {
    job.status = 'error'
    job.error = e instanceof Error ? e.message : 'Render failed'
    console.error('[video-jobs] render failed:', job.error)
  }
}
