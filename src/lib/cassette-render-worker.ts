import { parentPort, workerData } from 'node:worker_threads'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { createCassetteMotion, letteringRect, type Box, type Hub, type MotionLayerFactory } from './cassette-motion-scene.ts'
import { armDeadline } from './proc-deadline.ts'

// One slice of a Cassette Studio moving-cover render (see cassette-render.ts).
//
// Draws frames [start, end) of the loop with the scene engine
// (cassette-motion-scene.ts — sharp-free, so this thread never loads sharp)
// on a Skia canvas and pipes raw RGBA into its own ffmpeg, which writes one
// H.264 segment. A worker thread because canvas drawing is synchronous CPU
// work that would otherwise freeze every other request for the whole render.
//
// The scene is deterministic per frame (frameRng(seed, frame) grain, periodic
// camera and reels), and draw() takes the GLOBAL frame index, so frame K
// renders identically whichever worker draws it — that is what makes slicing
// the loop across workers seamless.
//
// Only ENCODED images cross the thread boundary (workerData is copied into
// every worker): a 3000² plate is ~2 MB as JPEG and 27 MB raw.

export type CassetteRenderSlice = {
  /** JPEG: the scene plate, cover-size square (its width is the cover size). */
  plate: Uint8Array
  /** PNG: the cassette layer with the hub discs cut out (or whole, when nothing spins). */
  staticLayer: Uint8Array
  /** PNG: the hub sprite (1×1 transparent when nothing spins). */
  hubSprite: Uint8Array
  /** PNG: the coloured title at its native size, or null for no title card. */
  title: Uint8Array | null
  position: string
  size: string
  box: Box
  hubs: Hub[]
  spriteR: number
  W: number
  H: number
  duration: number
  fps: number
  seed: number
  start: number
  end: number
  total: number
  ffmpeg: string
  args: string[]
  // Wall-clock budget for this slice's encoder. Terminating the worker does
  // not reliably take the ffmpeg child with it, so the child gets its own
  // SIGKILL watchdog like every other spawn in the app.
  timeoutMs: number
}

async function run(job: CassetteRenderSlice): Promise<void> {
  const [plate, staticLayer, hubSprite, title] = await Promise.all([
    loadImage(Buffer.from(job.plate)),
    loadImage(Buffer.from(job.staticLayer)),
    loadImage(Buffer.from(job.hubSprite)),
    job.title ? loadImage(Buffer.from(job.title)) : Promise.resolve(null),
  ])
  if (plate.width !== plate.height) throw new Error(`plate is not square (${plate.width}x${plate.height})`)

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
  type Img = CanvasImageSource & { width: number; height: number }
  const draw = createCassetteMotion({
    W: job.W,
    H: job.H,
    duration: job.duration,
    fps: job.fps,
    seed: job.seed,
    cover: plate.width,
    plate: plate as unknown as Img,
    staticLayer: staticLayer as unknown as Img,
    hubSprite: hubSprite as unknown as Img,
    box: job.box,
    hubs: job.hubs,
    spriteR: job.spriteR,
    layerScale: staticLayer.width / job.box.width,
    lettering: title
      ? { image: title as unknown as Img, rect: letteringRect(job.W, job.H, title.width, title.height, job.position, job.size) }
      : null,
    createLayer,
  })

  const proc = spawn(job.ffmpeg, job.args, { stdio: ['pipe', 'ignore', 'pipe'] })
  let stderr = ''
  proc.stderr?.on('data', d => { stderr += String(d); if (stderr.length > 20_000) stderr = stderr.slice(-10_000) })
  const closed = new Promise<number | null>((resolve, reject) => {
    armDeadline(proc, job.timeoutMs, 0, 'cassette motion slice', reject)
    proc.on('error', reject)
    proc.on('close', code => resolve(code))
  })
  // The render loop stops as soon as the encoder is gone for any reason —
  // exited, killed by the watchdog, or failed to spawn — so a pending 'drain'
  // wait can never outlive it.
  let dead = false
  const gone = closed.then(() => { dead = true }, () => { dead = true })
  // A dead encoder surfaces as EPIPE on the next write; the exit code below
  // carries the real reason, so swallow the stream error itself.
  proc.stdin!.on('error', () => {})

  const dc = ctx as unknown as CanvasRenderingContext2D
  for (let f = job.start; f < job.end; f++) {
    if (dead) break
    // @napi-rs/canvas keeps a snapshot of every canvas drawn INTO a context
    // until that context is reset (see free-render-worker.ts) — here the
    // near-plane, the grain tiles and the plate every frame. The scene paints
    // the whole frame, so resetting first is pixel-identical
    // (scripts/cassette-motion-test.mjs asserts it).
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

run(workerData as CassetteRenderSlice).then(
  () => parentPort?.postMessage({ ok: true }),
  (err: unknown) => parentPort?.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) }),
)
