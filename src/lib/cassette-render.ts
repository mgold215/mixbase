import { Worker } from 'node:worker_threads'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { FREE_FORMATS, FREE_FPS, sliceCount, sliceEncodeArgs, type FreeFormatId } from './free-render.ts'
import { runFfmpeg } from './visualizer-encode.ts'
import type { Box, Hub } from './cassette-motion-scene.ts'
import type { CassetteRenderSlice } from './cassette-render-worker.ts'

// ── Cassette Studio moving cover: the render ─────────────────────────────────
// A no-AI animated loop of a Cassette Studio cover (the scene and why it looks
// the way it does: cassette-motion-scene.ts). Same machinery as the free
// visualizer render (free-render.ts): the loop is sliced across worker
// threads, each drawing its frames on a Skia canvas into its own ffmpeg, and
// the H.264 segments are concatenated losslessly. Same formats, sizes,
// durations and frame rate as the free generator (FREE_FORMATS), so a moving
// cover drops into every slot a free visualizer does.
//
// Relative, extension-full imports only — scripts/cassette-motion-test.mjs
// drives this module under Node type stripping.

const FFMPEG = ffmpegInstaller.path

// A 30s 1080p loop is the longest; this is a hard wall, not a target.
export const CASSETTE_RENDER_TIMEOUT_MS = 240_000

export type CassetteMotionInput = {
  /** JPEG: the cover's scene plate (studio/<uid>/plate-<ts>.jpg), square, cover-size. */
  plateJpeg: Buffer | Uint8Array
  /** From prepareMotionAssets (cassette-motion.ts). */
  assets: { staticPng: Buffer | Uint8Array; hubSpritePng: Buffer | Uint8Array; hubs: Hub[]; spriteR: number }
  /** Where the cassette layer sits in the cover (offsets from its key, size from the layer). */
  box: Box
  /** The coloured title card (studio/<uid>/title-…png) and where it goes, or null. */
  title: { png: Buffer | Uint8Array; position: string; size: string } | null
  format: FreeFormatId
  seed?: number
}


/**
 * The free generator's slice encode, with a bitrate ceiling. The moving cover
 * draws FRESH grain on every frame (cassette-motion-scene.ts) — temporal noise
 * is what makes it read as camera footage — and noise is the one thing H.264
 * cannot predict, so plain CRF 20 lands at 20–28 Mbit/s (a 30 s YouTube loop
 * ≈ 100 MB). Capped CRF keeps quality where it matters and the file a sane
 * size for the iOS player and mf-video. Every slice uses identical settings,
 * so the concat stays lossless.
 */
export function cassetteEncodeArgs(W: number, H: number, out: string): string[] {
  const args = sliceEncodeArgs(W, H, out)
  const crf = args.indexOf('-crf')
  args.splice(crf, 2, '-crf', '22', '-maxrate', '8M', '-bufsize', '16M')
  return args
}

function runSlice(slice: CassetteRenderSlice, deadline: number, stops: (() => void)[]): Promise<void> {
  return new Promise((resolve, reject) => {
    // The LITERAL new Worker(new URL('./…', import.meta.url)) form is what
    // Turbopack recognises and bundles as a worker entry for production
    // (Node 20, no type stripping) — keep it a literal.
    const worker = new Worker(new URL('./cassette-render-worker.ts', import.meta.url), { workerData: slice })
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
      () => finish(new Error('moving cover render timed out')),
      Math.max(0, deadline - Date.now()),
    )
    worker.on('message', (m: { ok: boolean; error?: string }) => finish(m.ok ? undefined : new Error(m.error)))
    worker.on('error', err => finish(err))
    worker.on('exit', code => finish(new Error(`render worker exited ${code} before finishing`)))
  })
}

/** Render a seamless moving-cover loop. Returns MP4 bytes (silent H.264, yuv420p). */
export async function renderCassetteMotion(input: CassetteMotionInput): Promise<Buffer> {
  const { width: W, height: H, duration } = FREE_FORMATS[input.format]
  const total = duration * FREE_FPS
  const slices = sliceCount(total)
  const seed = (input.seed ?? Math.floor(Math.random() * 2 ** 32)) >>> 0
  const deadline = Date.now() + CASSETTE_RENDER_TIMEOUT_MS

  const dir = await mkdtemp(join(tmpdir(), 'cassette-motion-'))
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
        plate: input.plateJpeg,
        staticLayer: input.assets.staticPng,
        hubSprite: input.assets.hubSpritePng,
        title: input.title?.png ?? null,
        position: input.title?.position ?? 'bottom-left',
        size: input.title?.size ?? 'medium',
        box: input.box,
        hubs: input.assets.hubs,
        spriteR: input.assets.spriteR,
        W, H, duration, fps: FREE_FPS, seed,
        start, end, total,
        ffmpeg: FFMPEG,
        args: cassetteEncodeArgs(W, H, seg),
        // Just inside the render deadline, so the encoder's own SIGKILL
        // watchdog fires before the worker is torn down around it.
        timeoutMs: CASSETTE_RENDER_TIMEOUT_MS - 10_000,
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
      'moving cover concat',
    )
    return await readFile(out)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
