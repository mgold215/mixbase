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

export function runFfmpeg(args: string[], timeoutMs: number = TRANSCODE_TIMEOUT_MS, label = 'visualizer transcode'): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr?.on('data', d => { stderr += String(d); if (stderr.length > 20_000) stderr = stderr.slice(-10_000) })
    // Shared watchdog rather than a bare setTimeout+kill: killing without
    // SETTLING leaves the promise pending forever if the child survives the
    // signal or a descendant holds stderr open, which is the original wedged-
    // render outage. idleMs = 0 — this encode writes no progress stream, so
    // only the wall-clock ceiling applies.
    armDeadline(proc, timeoutMs, 0, label, reject)
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

// ── Server-side free visualizer render ───────────────────────────────────────
// The web free generator records a browser canvas via MediaRecorder, which iOS
// (native app AND Safari) simply does not have. This renders the same idea —
// artwork → seamless motion loop — from a still image with ffmpeg, so every
// client can generate for free through /api/visualizer/free. All motion
// expressions are periodic over the clip, so the exported loop is seamless,
// matching the web generator's t∈[0,1) convention.

// A 30s 1080p zoompan encode is minutes of CPU on a busy container; three
// minutes is a hard wall, not a target (the 6s formats finish in seconds).
export const FREE_RENDER_TIMEOUT_MS = 180_000

export type FreeFormatId = 'canvas' | 'square' | 'youtube'
export type FreeEffectId = 'drift' | 'pulse' | 'orbit'

export const FREE_FORMATS: Record<FreeFormatId, { label: string; width: number; height: number; duration: number }> = {
  canvas:  { label: 'Spotify Canvas', width: 1080, height: 1920, duration: 6 },
  square:  { label: 'Square',         width: 1080, height: 1080, duration: 6 },
  youtube: { label: 'YouTube',        width: 1920, height: 1080, duration: 30 },
}

// Labels match the web generator's effects of the same motion family.
export const FREE_EFFECTS: Record<FreeEffectId, { label: string; description: string; beatSynced: boolean }> = {
  drift: { label: 'Cinematic Drift', description: 'Slow weightless zoom & pan', beatSynced: false },
  pulse: { label: 'Deep Pulse',      description: 'Breathes on the beat',       beatSynced: true },
  orbit: { label: 'Orbit',           description: 'Weightless sway & rotation', beatSynced: false },
}

export function isFreeFormat(v: unknown): v is FreeFormatId {
  return typeof v === 'string' && v in FREE_FORMATS
}
export function isFreeEffect(v: unknown): v is FreeEffectId {
  return typeof v === 'string' && v in FREE_EFFECTS
}

const FREE_FPS = 30

/**
 * The ffmpeg argument list for one free render.
 *
 * Building notes, each load-bearing:
 *  - The source is upscaled ~2.5x and cropped to the output aspect BEFORE
 *    zoompan: zoompan rounds its crop origin to integers, and on a small input
 *    that rounding is a visible one-pixel judder. Sampling from a large canvas
 *    makes the step sub-pixel.
 *  - Expressions avoid commas entirely (pow(a,b) is written as a*a*a) because
 *    a comma inside -vf splits the filter chain.
 *  - The encode flags mirror mp4EncodeArgs: silent H.264 yuv420p +faststart is
 *    the one shape every surface (web, share page, iOS AVPlayer) can play.
 */
export function freeRenderArgs(
  imgPath: string,
  outPath: string,
  opts: { format: FreeFormatId; effect: FreeEffectId; bpm?: number },
): string[] {
  const { width: W, height: H, duration: D } = FREE_FORMATS[opts.format]
  const N = D * FREE_FPS
  // Sampling canvas: ~2.5x the output, even dimensions.
  const SW = Math.round((W * 2.5) / 2) * 2
  const SH = Math.round((H * 2.5) / 2) * 2
  const cover = `scale=${SW}:${SH}:force_original_aspect_ratio=increase`
  const centerCrop = `crop=${SW}:${SH}`

  // θ sweeps 0→2π across the loop but never reaches 2π (on ∈ [0, N)), so the
  // wrap from the last frame back to the first is one ordinary step.
  const theta = `(2*PI*on/${N})`
  const filters: string[] = [cover, centerCrop]

  if (opts.effect === 'drift') {
    // Slow elliptical pan with a breathing zoom — Ken Burns that returns home.
    const z = `1.10+0.05*sin(${theta})`
    const x = `iw/2-(iw/zoom/2)+(iw*0.015)*sin(${theta})`
    const y = `ih/2-(ih/zoom/2)+(ih*0.015)*cos(${theta})`
    filters.push(`zoompan=z='${z}':x='${x}':y='${y}':d=${N}:s=${W}x${H}:fps=${FREE_FPS}`)
  } else if (opts.effect === 'pulse') {
    // Zoom punches on the beat. The beat count is rounded to a whole number of
    // beats per loop so the pulse phase is identical at the seam.
    const bpm = Math.min(200, Math.max(60, Math.round(opts.bpm ?? 122)))
    const beats = Math.max(1, Math.round((D * bpm) / 60))
    // Shaped attack: sin half-wave cubed reads as a punch, not a sway.
    const wave = `(0.5+0.5*sin(2*PI*${beats}*on/${N}-PI/2))`
    const z = `1.12+0.06*${wave}*${wave}*${wave}`
    filters.push(`zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${N}:s=${W}x${H}:fps=${FREE_FPS}`)
  } else {
    // orbit: gentle rotation + breathing zoom. Rendered oversized so the
    // rotation never exposes a corner, then center-cropped to the format.
    const OW = Math.round((W * 1.16) / 2) * 2
    const OH = Math.round((H * 1.16) / 2) * 2
    const z = `1.10+0.04*sin(${theta})`
    filters.push(
      `zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${N}:s=${OW}x${OH}:fps=${FREE_FPS}`,
      `rotate=a='0.045*sin(2*PI*t/${D})'`,
      `crop=${W}:${H}`,
    )
  }

  filters.push('format=yuv420p')

  return [
    '-y', '-v', 'error',
    '-i', imgPath,
    '-vf', filters.join(','),
    '-frames:v', String(N),
    '-an',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-crf', '20',
    '-preset', 'veryfast',
    '-movflags', '+faststart',
    outPath,
  ]
}

/** Render a seamless free visualizer loop from a still image. Returns MP4 bytes. */
export async function renderFreeVisualizer(
  image: Buffer | Uint8Array,
  opts: { format: FreeFormatId; effect: FreeEffectId; bpm?: number },
): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'viz-free-'))
  // ffmpeg sniffs the container from content, so a neutral extension is fine
  // for JPEG/PNG/WebP artwork alike.
  const src = join(dir, 'art.img')
  const out = join(dir, 'out.mp4')
  try {
    await writeFile(src, image)
    await runFfmpeg(freeRenderArgs(src, out, opts), FREE_RENDER_TIMEOUT_MS, 'free visualizer render')
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
