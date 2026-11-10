// A still set gently in motion — the no-AI moving version of ANY cover.
//
// The camera floats: a slow circular drift with a slight breathing zoom, one
// full turn per loop, so the last frame runs straight into the first and a
// Spotify Canvas (which repeats forever) never jumps. Live film grain runs
// over it, which is what keeps a still from reading as a frozen frame.
//
// Used when a cover cannot be filmed by a video model (no credits, the shot
// was refused) and when a cover has no cassette layer to animate (covers
// drawn by the art engine are one picture, not a plate plus a cassette).
//
// Built with zoompan + noise because @ffmpeg-installer ships a 2018 ffmpeg
// (same constraint as video-loop.ts). zoompan places its window on whole
// input pixels, which shows as a shake at this speed; the still is therefore
// fed in at twice the output size so each step is half an output pixel.
// Relative, extension-full imports only — scripts/cassette-art-test.mjs runs
// it under Node.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { runFfmpeg } from './visualizer-encode.ts'

export type StillLoopOptions = {
  width: number
  height: number
  /** Loop length in seconds (default 8 — Canvas takes 3 to 8). */
  seconds?: number
  fps?: number
}

/** How far past the frame the still is scaled so the drift never shows an edge. */
const ZOOM_BASE = 1.07
const ZOOM_SWING = 0.025
/** Drift radius as a fraction of the frame. */
const DRIFT = 0.012

/** The zoompan expression set for an N-frame loop at W×H (input pre-scaled 2×). Exported for the test. */
export function stillLoopFilter(N: number, W: number, H: number, fps: number): string {
  const t = `2*PI*on/${N}`
  const z = `${ZOOM_BASE}+${ZOOM_SWING}*sin(${t})`
  // The window's centre circles the frame's centre; zoompan wants its top-left.
  const x = `(iw-iw/zoom)/2+iw*${DRIFT}*cos(${t})`
  const y = `(ih-ih/zoom)/2+ih*${DRIFT}*sin(${t})`
  return [
    `zoompan=z='${z}':x='${x}':y='${y}':d=${N}:s=${W}x${H}:fps=${fps}`,
    'noise=alls=6:allf=t+u',
    'format=yuv420p',
  ].join(',')
}

/**
 * Fit a picture to exactly W×H without losing any of it: the whole picture
 * sits in the middle and the bands beside it are a blurred, darkened stretch
 * of itself. A picture already close to the shape is simply cropped to it.
 * Returns JPEG.
 */
export async function fitStill(image: Buffer, W: number, H: number): Promise<Buffer> {
  const meta = await sharp(image).rotate().metadata()
  const iw = meta.width ?? W, ih = meta.height ?? H
  const want = W / H, have = iw / ih
  if (Math.abs(have - want) / want < 0.08) {
    return sharp(image).rotate().removeAlpha().resize(W, H, { fit: 'cover' }).jpeg({ quality: 93 }).toBuffer()
  }
  const backdrop = await sharp(image).rotate().removeAlpha().resize(W, H, { fit: 'cover' }).blur(Math.max(12, Math.round(Math.min(W, H) * 0.04))).modulate({ brightness: 0.72 }).toBuffer()
  const inner = await sharp(image).rotate().removeAlpha().resize(W, H, { fit: 'inside' }).toBuffer()
  const im = await sharp(inner).metadata()
  return sharp(backdrop)
    .composite([{ input: inner, left: Math.round((W - (im.width ?? W)) / 2), top: Math.round((H - (im.height ?? H)) / 2) }])
    .jpeg({ quality: 93 })
    .toBuffer()
}

/** Render `still` (any image sharp reads, any shape) as a seamless silent W×H loop. Returns MP4 bytes. */
export async function stillLoop(still: Buffer, opts: StillLoopOptions): Promise<Buffer> {
  const { width: W, height: H } = opts
  const fps = opts.fps ?? 30
  const N = Math.max(30, Math.round((opts.seconds ?? 8) * fps))
  const dir = await mkdtemp(join(tmpdir(), 'still-'))
  try {
    const src = join(dir, 'in.jpg'), out = join(dir, 'out.mp4')
    await writeFile(src, await sharp(await fitStill(still, W, H)).resize(W * 2, H * 2, { fit: 'fill', kernel: 'lanczos3' }).jpeg({ quality: 95 }).toBuffer())
    await runFfmpeg([
      '-y', '-v', 'error', '-i', src,
      '-vf', stillLoopFilter(N, W, H, fps),
      '-frames:v', String(N), '-r', String(fps),
      '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out,
    ], 240_000, 'still loop')
    return await readFile(out)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
