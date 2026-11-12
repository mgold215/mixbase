import { parentPort, workerData } from 'node:worker_threads'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import type { MotionLayerFactory } from './cassette-motion-scene.ts'
import { createCoverMotion } from './cover-motion-scene.ts'
import type { MotionRecipe } from './cover-motion.ts'
import { armDeadline } from './proc-deadline.ts'

// One slice of a designed moving-cover render (see cover-motion-render.ts).
//
// Draws frames [start, end) of the loop with the scene engine
// (cover-motion-scene.ts, sharp-free) on a Skia canvas and pipes raw RGBA
// into its own ffmpeg, which writes one H.264 segment. Same shape as
// cassette-render-worker.ts, and for the same reasons: canvas drawing is
// synchronous CPU work that must not run on the request thread, and the scene
// is deterministic per GLOBAL frame index, so slices join seamlessly.

export type CoverMotionSlice = {
  /** JPEG: the cover fitted to the frame's shape. */
  still: Uint8Array
  recipe: MotionRecipe
  W: number
  H: number
  seed: number
  start: number
  end: number
  total: number
  ffmpeg: string
  args: string[]
  /** Wall-clock budget for this slice's encoder (its own SIGKILL watchdog). */
  timeoutMs: number
}

async function run(job: CoverMotionSlice): Promise<void> {
  const still = await loadImage(Buffer.from(job.still))
  const canvas = createCanvas(job.W, job.H)
  const ctx = canvas.getContext('2d')
  // Skia's canvas implements the 2D API the scene uses; the casts bridge
  // @napi-rs/canvas's own type names to the DOM ones the scene is typed with.
  const createLayer: MotionLayerFactory = (w, h) => {
    const c = createCanvas(w, h)
    return {
      canvas: c as unknown as CanvasImageSource,
      ctx: c.getContext('2d') as unknown as CanvasRenderingContext2D,
    }
  }
  const draw = createCoverMotion({
    W: job.W, H: job.H, total: job.total, seed: job.seed,
    still: still as unknown as CanvasImageSource & { width: number; height: number },
    recipe: job.recipe,
    createLayer,
  })

  const proc = spawn(job.ffmpeg, job.args, { stdio: ['pipe', 'ignore', 'pipe'] })
  let stderr = ''
  proc.stderr?.on('data', d => { stderr += String(d); if (stderr.length > 20_000) stderr = stderr.slice(-10_000) })
  const closed = new Promise<number | null>((resolve, reject) => {
    armDeadline(proc, job.timeoutMs, 0, 'cover motion slice', reject)
    proc.on('error', reject)
    proc.on('close', code => resolve(code))
  })
  // The render loop stops as soon as the encoder is gone for any reason, so a
  // pending 'drain' wait can never outlive it.
  let dead = false
  const gone = closed.then(() => { dead = true }, () => { dead = true })
  // A dead encoder surfaces as EPIPE on the next write; the exit code below
  // carries the real reason, so swallow the stream error itself.
  proc.stdin!.on('error', () => {})

  const dc = ctx as unknown as CanvasRenderingContext2D
  for (let f = job.start; f < job.end; f++) {
    if (dead) break
    // @napi-rs/canvas keeps a snapshot of every canvas drawn INTO a context
    // until that context is reset (see free-render-worker.ts): here the
    // shimmer and glint layers and the grain tiles, every frame. The scene
    // paints the whole frame, so resetting first changes no pixel
    // (scripts/cover-motion-test.mjs asserts it).
    ctx.reset()
    draw(dc, f)
    const { data } = ctx.getImageData(0, 0, job.W, job.H)
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    if (!proc.stdin!.write(buf)) await Promise.race([once(proc.stdin!, 'drain'), gone])
    // Each readback is a native 8 MB buffer freed by a finalizer that only
    // runs once the loop yields; a tight synchronous loop grows without bound.
    else await new Promise(resolve => setImmediate(resolve))
  }
  proc.stdin!.end()

  const code = await closed
  if (code !== 0) throw new Error(`ffmpeg exited ${code}: ${stderr.slice(-800)}`)
}

run(workerData as CoverMotionSlice).then(
  () => parentPort?.postMessage({ ok: true }),
  (err: unknown) => parentPort?.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) }),
)
