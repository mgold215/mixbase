import { Worker } from 'node:worker_threads'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import sharp from 'sharp'
import { cassetteEncodeArgs } from './cassette-render.ts'
import { FREE_FPS, sliceCount } from './free-render.ts'
import type { MotionRecipe } from './cover-motion.ts'
import type { CoverMotionSlice } from './cover-motion-worker.ts'
import { runFfmpeg } from './visualizer-encode.ts'

// ── A designed moving cover: the render ──────────────────────────────────────
// The plan (cover-motion.ts) drawn over the real cover pixels by the scene
// (cover-motion-scene.ts). Same machinery as the other no-AI loops
// (free-render.ts, cassette-render.ts): the loop is sliced across worker
// threads, each drawing its frames on a Skia canvas into its own ffmpeg, and
// the H.264 segments are concatenated losslessly.
//
// Relative, extension-full imports only — scripts/cover-motion-test.mjs
// drives this module under Node type stripping.

const FFMPEG = ffmpegInstaller.path

/** A hard wall, not a target: an 8 s 1080p loop draws in well under a minute. */
export const COVER_MOTION_TIMEOUT_MS = 240_000

/** How much larger than the frame the still is handed to the scene, so the camera's zoom never upscales it. */
const OVERSCAN = 1.12

export type CoverMotionOptions = {
  width: number
  height: number
  /** Loop length in seconds (default 8, the longest a Spotify Canvas takes). */
  seconds?: number
  seed?: number
}

function runSlice(slice: CoverMotionSlice, deadline: number, stops: (() => void)[]): Promise<void> {
  return new Promise((resolve, reject) => {
    // The LITERAL new Worker(new URL('./…', import.meta.url)) form is what
    // Turbopack recognises and bundles as a worker entry for production
    // (Node 20, no type stripping) — keep it a literal.
    const worker = new Worker(new URL('./cover-motion-worker.ts', import.meta.url), { workerData: slice })
    // Lets a sibling's failure stop this slice now rather than at the deadline.
    stops.push(() => finish(new Error('render cancelled')))
    let settled = false
    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Terminating also closes the encoder's stdin, so its ffmpeg exits too.
      void worker.terminate()
      if (err) reject(err)
      else resolve()
    }
    const timer = setTimeout(
      () => finish(new Error('designed motion render timed out')),
      Math.max(0, deadline - Date.now()),
    )
    worker.on('message', (m: { ok: boolean; error?: string }) => finish(m.ok ? undefined : new Error(m.error)))
    worker.on('error', err => finish(err))
    worker.on('exit', code => finish(new Error(`render worker exited ${code} before finishing`)))
  })
}

/**
 * Render `still` (already the frame's shape: the extended cover) moving as
 * `recipe` says. Returns a seamless silent MP4 (H.264, yuv420p).
 */
export async function renderCoverMotion(still: Buffer, recipe: MotionRecipe, opts: CoverMotionOptions): Promise<Buffer> {
  const { width: W, height: H } = opts
  const total = Math.max(30, Math.round((opts.seconds ?? 8) * FREE_FPS))
  const slices = sliceCount(total)
  const seed = (opts.seed ?? Math.floor(Math.random() * 2 ** 32)) >>> 0
  const deadline = Date.now() + COVER_MOTION_TIMEOUT_MS
  // Only an ENCODED image crosses the thread boundary (workerData is copied into every worker).
  const jpeg = await sharp(still).rotate().removeAlpha()
    .resize(Math.round(W * OVERSCAN), Math.round(H * OVERSCAN), { fit: 'cover', kernel: 'lanczos3' })
    .jpeg({ quality: 95 }).toBuffer()

  const dir = await mkdtemp(join(tmpdir(), 'cover-motion-'))
  try {
    const segments: string[] = []
    const jobs: Promise<void>[] = []
    const stops: (() => void)[] = []
    for (let i = 0; i < slices; i++) {
      const start = Math.floor((total * i) / slices)
      const end = Math.floor((total * (i + 1)) / slices)
      const seg = join(dir, `seg${i}.mp4`)
      segments.push(seg)
      jobs.push(runSlice({
        still: jpeg, recipe, W, H, seed, start, end, total,
        ffmpeg: FFMPEG,
        args: cassetteEncodeArgs(W, H, seg),
        // Just inside the render deadline, so the encoder's own SIGKILL
        // watchdog fires before the worker is torn down around it.
        timeoutMs: COVER_MOTION_TIMEOUT_MS - 10_000,
      }, deadline, stops))
    }
    try {
      await Promise.all(jobs)
    } catch (err) {
      for (const stop of stops) stop()
      await Promise.allSettled(jobs)
      throw err
    }

    if (segments.length === 1) return await readFile(segments[0])
    const list = join(dir, 'list.txt')
    await writeFile(list, segments.map(s => `file '${s}'`).join('\n'))
    const out = join(dir, 'out.mp4')
    await runFfmpeg(
      ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out],
      Math.max(5_000, deadline - Date.now()),
      'designed motion concat',
    )
    return await readFile(out)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
