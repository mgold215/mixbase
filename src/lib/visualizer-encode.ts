import { spawn } from 'child_process'
import { mkdtemp, readFile, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { armDeadline } from './proc-deadline.ts'

// The ffmpeg half of the WebM→MP4 visualizer normalization, split out from
// visualizer-transcode.ts so it can be imported by a test.
//
// This module must NEVER import '@/lib/supabase' (directly or transitively):
// the '@/' alias doesn't resolve under Node's type stripping, and loading the
// Supabase client needs service-role env. Every lib covered by
// scripts/*-test.mjs obeys the same rule — relative, extension-full imports
// only. visualizer-transcode.ts keeps the storage/DB half.

const FFMPEG = ffmpegInstaller.path

// A visualizer loop is seconds long and under 10 MB; a minute of wall clock is
// generous. SIGKILL, not SIGTERM — ffmpeg catches SIGTERM (see video-render.ts).
export const TRANSCODE_TIMEOUT_MS = 60_000

/**
 * ffmpeg arguments for a silent, iOS-decodable H.264 MP4.
 *
 * Every flag here is load-bearing for the reason this conversion exists — iOS
 * AVPlayer playback — so they are exported and asserted on by
 * scripts/visualizer-transcode-test.mjs rather than left as inline literals a
 * later cleanup could "simplify" away.
 */
export function mp4EncodeArgs(src: string, out: string): string[] {
  return [
    '-y', '-v', 'error',
    '-i', src,
    '-an',                          // visualizers are silent; the mix is the audio
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',          // baseline decodability on Apple hardware
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', // libx264 requires even dimensions
    '-crf', '20',
    '-preset', 'veryfast',
    '-movflags', '+faststart',      // moov up front so playback starts mid-download
    out,
  ]
}

export function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr?.on('data', d => { stderr += String(d); if (stderr.length > 20_000) stderr = stderr.slice(-10_000) })
    // Shared watchdog rather than a bare setTimeout+kill: killing without
    // SETTLING leaves the promise pending forever if the child survives the
    // signal or a descendant holds stderr open, which is the original wedged-
    // render outage. idleMs = 0 — this encode writes no progress stream, so
    // only the wall-clock ceiling applies.
    armDeadline(proc, TRANSCODE_TIMEOUT_MS, 0, 'visualizer transcode', reject)
    proc.on('error', err => reject(err))
    proc.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-800)}`))
    })
  })
}

// ── Concurrency gate for the request-path transcode ──────────────────────────
// /api/visualizer/save forks libx264 inline in the request handler. A rate
// limiter caps how OFTEN one user can ask; this caps how many run AT ONCE
// across all users, which is the property that actually protects the container.
// Without it, N concurrent saves meant N concurrent encoders on the same box as
// any in-flight final render — the CPU-starvation shape behind the wedged-render
// outage.
//
// The boot heal is deliberately NOT gated: it is one-shot, already strictly
// sequential, and must be free to converge. Worst case is heal + MAX_INFLIGHT
// saves, which is bounded and small.
const MAX_INFLIGHT_TRANSCODES = 2
let inFlight = 0

/** Returns false when the box is already at capacity; caller should 503. */
export function tryAcquireTranscodeSlot(): boolean {
  if (inFlight >= MAX_INFLIGHT_TRANSCODES) return false
  inFlight++
  return true
}

export function releaseTranscodeSlot(): void {
  if (inFlight > 0) inFlight--
}

/** Test/observability hook — how many encodes are running right now. */
export function inFlightTranscodes(): number {
  return inFlight
}

/** Transcode a WebM (VP8/VP9) visualizer loop to a silent H.264 MP4. */
export async function webmToMp4(webm: Buffer | Uint8Array): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'viz-transcode-'))
  const src = join(dir, 'in.webm')
  const out = join(dir, 'out.mp4')
  try {
    await writeFile(src, webm)
    await runFfmpeg(mp4EncodeArgs(src, out))
    return await readFile(out)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

// The MP4 twin lives beside the original: <path>.webm → <path>-h264.mp4.
// Deterministic, so re-running the heal after a partial failure converges
// (upload is upsert) instead of piling up duplicates.
export function mp4TwinPath(webmPath: string): string {
  return webmPath.replace(/\.webm$/, '') + '-h264.mp4'
}

/**
 * Inverse of mp4TwinPath: the original WebM a twin was converted FROM, or null
 * if this path isn't a twin.
 *
 * The heal repoints rows to the twin and deliberately leaves the original in
 * storage as a rollback path. But every delete path derives its storage key
 * from the row's video_url — which is now the MP4 — so without this the
 * original was unreachable by deletion forever. That silently reintroduced the
 * orphaned-bytes-after-GDPR-delete bug that /api/auth/delete-account was
 * written to fix. Deleting a path that doesn't exist is a no-op in Supabase
 * Storage, so passing this candidate unconditionally is safe.
 */
export function webmOriginalPath(mp4Path: string): string | null {
  if (!mp4Path.endsWith('-h264.mp4')) return null
  return mp4Path.slice(0, -'-h264.mp4'.length) + '.webm'
}
