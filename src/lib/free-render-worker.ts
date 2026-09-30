import { parentPort, workerData } from 'node:worker_threads'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { EFFECTS, type EffectId, type LayerHandle } from './free-effects.ts'

// One slice of a server-side free visualizer render (see free-render.ts).
//
// Runs the WEB generator's own effect engine (free-effects.ts) against a Skia
// canvas and pipes raw RGBA frames [start, end) into its own ffmpeg, which
// writes one H.264 segment. It lives in a worker thread because canvas drawing
// is synchronous CPU work — tens to hundreds of ms per 1080p frame — and doing
// it on the main thread would freeze every other request for the length of
// the render.
//
// Every effect is deterministic per frame (frameRng(seed, frame), periodic
// curves), so frame K renders identically whichever worker draws it; that is
// what makes slicing the loop across workers seamless.

export type FreeRenderSlice = {
  image: Uint8Array
  effect: EffectId
  W: number
  H: number
  duration: number
  fps: number
  bpm: number
  seed: number
  start: number
  end: number
  total: number
  ffmpeg: string
  args: string[]
}

async function run(job: FreeRenderSlice): Promise<void> {
  const img = await loadImage(Buffer.from(job.image))
  const canvas = createCanvas(job.W, job.H)
  const ctx = canvas.getContext('2d')
  // Skia's canvas implements the 2D API the engine uses; the casts bridge
  // @napi-rs/canvas's own type names to the DOM ones the engine is typed with.
  const createLayer = (w: number, h: number): LayerHandle => {
    const c = createCanvas(w, h)
    return {
      canvas: c as unknown as CanvasImageSource,
      ctx: c.getContext('2d') as unknown as CanvasRenderingContext2D,
    }
  }
  const draw = EFFECTS[job.effect].create({
    W: job.W,
    H: job.H,
    duration: job.duration,
    fps: job.fps,
    bpm: job.bpm,
    seed: job.seed,
    image: img as unknown as CanvasImageSource,
    imageWidth: img.width,
    imageHeight: img.height,
    createLayer,
  })

  const proc = spawn(job.ffmpeg, job.args, { stdio: ['pipe', 'ignore', 'pipe'] })
  let stderr = ''
  proc.stderr?.on('data', d => { stderr += String(d); if (stderr.length > 20_000) stderr = stderr.slice(-10_000) })
  const closed = new Promise<number | null>((resolve, reject) => {
    proc.on('error', reject)
    proc.on('close', code => resolve(code))
  })
  // A dead encoder surfaces as EPIPE on the next write; the exit code below
  // carries the real reason, so swallow the stream error itself.
  proc.stdin!.on('error', () => {})

  const dc = ctx as unknown as CanvasRenderingContext2D
  for (let f = job.start; f < job.end; f++) {
    if (proc.exitCode !== null) break
    // @napi-rs/canvas keeps a snapshot of every canvas drawn INTO a context
    // until that context is reset — ~70 MB per frame for Drone Shot's scratch
    // layer, which OOM-killed a 30s render. Every effect paints the whole
    // frame, so resetting first is pixel-identical (free-render-test.mjs
    // asserts both properties).
    ctx.reset()
    // t = frame / TOTAL (not TOTAL - 1): the last frame is one step before the
    // wrap, so the loop is seamless — the engine's contract.
    draw(dc, f / job.total, f)
    const { data } = ctx.getImageData(0, 0, job.W, job.H)
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    if (!proc.stdin!.write(buf)) await once(proc.stdin!, 'drain')
    // Each readback is a native 8 MB buffer freed by a finalizer that only
    // runs once the loop yields; a tight synchronous loop grows without bound.
    else await new Promise(resolve => setImmediate(resolve))
  }
  proc.stdin!.end()

  const code = await closed
  if (code !== 0) throw new Error(`ffmpeg exited ${code}: ${stderr.slice(-800)}`)
}

run(workerData as FreeRenderSlice).then(
  () => parentPort?.postMessage({ ok: true }),
  (err: unknown) => parentPort?.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) }),
)
