import { Worker } from 'node:worker_threads'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { availableParallelism, tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { EFFECTS, EFFECT_IDS, type EffectId } from './free-effects.ts'
import { runFfmpeg } from './visualizer-encode.ts'
import type { FreeRenderSlice } from './free-render-worker.ts'

// ── Server-side free visualizer render ───────────────────────────────────────
// The web free generator records a browser canvas; iOS (native app and Safari)
// can't, so /api/visualizer/free renders on the server instead. It runs the
// SAME effect engine as the web (free-effects.ts) on a Skia canvas, so the app
// offers exactly the web's effect list and every loop looks like its web twin.
// Adding an effect to free-effects.ts makes it available here automatically.
//
// Relative, extension-full imports only — covered by scripts/free-render-test.mjs
// under Node type stripping (see visualizer-encode.ts for the rule).

const FFMPEG = ffmpegInstaller.path

export type FreeFormatId = 'canvas' | 'square' | 'youtube' | 'story'

// Mirrors FORMAT_CONFIG in src/components/visualizer/shared.ts (the web
// generator's formats); free-render-test.mjs asserts the two agree.
export const FREE_FORMATS: Record<FreeFormatId, { label: string; width: number; height: number; duration: number }> = {
  canvas:  { label: 'Spotify Canvas', width: 1080, height: 1920, duration: 6 },
  square:  { label: 'Square',         width: 1080, height: 1080, duration: 6 },
  youtube: { label: 'YouTube',        width: 1920, height: 1080, duration: 30 },
  story:   { label: 'Story',          width: 1080, height: 1920, duration: 6 },
}

// Ids the pre-parity server used. App builds still in the field send them, so
// they keep working: 'drift' was the ffmpeg stand-in for Cinematic Drift.
const LEGACY_EFFECT_IDS: Record<string, EffectId> = { drift: 'kenburns' }

export function isFreeFormat(v: unknown): v is FreeFormatId {
  return typeof v === 'string' && Object.hasOwn(FREE_FORMATS, v)
}

/** Web effect id for a requested effect (accepting legacy ids), or null. */
export function resolveFreeEffect(v: unknown): EffectId | null {
  if (typeof v !== 'string') return null
  if (Object.hasOwn(EFFECTS, v)) return v as EffectId
  return Object.hasOwn(LEGACY_EFFECT_IDS, v) ? LEGACY_EFFECT_IDS[v] : null
}

/** The effect list the web generator offers, in its order. */
export function freeEffectList() {
  return EFFECT_IDS.map(id => ({
    id,
    label: EFFECTS[id].label,
    description: EFFECTS[id].description,
    beatSynced: EFFECTS[id].beatSynced,
  }))
}

// Same range the web BPM field clamps to (clampBpm in visualizer/shared.ts).
export function clampFreeBpm(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 122
  return Math.min(200, Math.max(60, Math.round(v)))
}

const FREE_FPS = 30

// A 30s 1080p loop of the heaviest effect (Drone Shot, ~250 ms/frame) is
// minutes of single-core CPU. This is a hard wall, not a target.
export const FREE_RENDER_TIMEOUT_MS = 240_000

// Frames per worker slice, and the most slices one render may use. Two
// renders can run at once (the encoder gate), so this bounds the box at
// 2 × MAX_SLICES drawing threads + their encoders.
const FRAMES_PER_SLICE = 120
const MAX_SLICES = 4

/** How many parallel slices a render of `frames` frames is split into. */
export function sliceCount(frames: number, cpus = availableParallelism()): number {
  const cap = Math.max(1, Math.min(MAX_SLICES, cpus - 1))
  return Math.max(1, Math.min(cap, Math.ceil(frames / FRAMES_PER_SLICE)))
}

/**
 * ffmpeg arguments that encode raw RGBA frames from stdin into one segment.
 * The output flags mirror mp4EncodeArgs: silent H.264 yuv420p is the one
 * shape every surface (web, share page, iOS AVPlayer) can play, and segments
 * with identical settings concatenate losslessly.
 */
export function sliceEncodeArgs(W: number, H: number, out: string): string[] {
  return [
    '-y', '-v', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-framerate', String(FREE_FPS),
    '-i', 'pipe:0',
    '-an',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-crf', '20',
    '-preset', 'veryfast',
    '-movflags', '+faststart',
    out,
  ]
}

function runSlice(slice: FreeRenderSlice, deadline: number, stops: (() => void)[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./free-render-worker.ts', import.meta.url), { workerData: slice })
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
      () => finish(new Error('free visualizer render timed out')),
      Math.max(0, deadline - Date.now()),
    )
    worker.on('message', (m: { ok: boolean; error?: string }) => finish(m.ok ? undefined : new Error(m.error)))
    worker.on('error', err => finish(err))
    worker.on('exit', code => finish(new Error(`render worker exited ${code} before finishing`)))
  })
}

/** Render a seamless free visualizer loop from a still image. Returns MP4 bytes. */
export async function renderFreeVisualizer(
  image: Buffer | Uint8Array,
  opts: { format: FreeFormatId; effect: EffectId; bpm?: number; seed?: number },
): Promise<Buffer> {
  const { width: W, height: H, duration } = FREE_FORMATS[opts.format]
  const total = duration * FREE_FPS
  const slices = sliceCount(total)
  const bpm = clampFreeBpm(opts.bpm)
  const seed = (opts.seed ?? Math.floor(Math.random() * 2 ** 32)) >>> 0
  const deadline = Date.now() + FREE_RENDER_TIMEOUT_MS

  const dir = await mkdtemp(join(tmpdir(), 'viz-free-'))
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
        image,
        effect: opts.effect,
        W, H, duration, fps: FREE_FPS, bpm, seed,
        start, end, total,
        ffmpeg: FFMPEG,
        args: sliceEncodeArgs(W, H, seg),
        // Just inside the render deadline, so the encoder's own SIGKILL
        // watchdog fires before the worker is torn down around it.
        timeoutMs: FREE_RENDER_TIMEOUT_MS - 10_000,
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
      'free visualizer concat',
    )
    return await readFile(out)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
