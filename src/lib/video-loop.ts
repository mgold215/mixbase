// Seamless loop for a generated clip — so a Spotify Canvas (which loops
// forever) and a YouTube visualizer (which finalize-video loops for the whole
// song) never show a jump where the clip restarts.
//
// The clip's first F seconds are faded in OVER its last F seconds, and the
// result starts at second F: the final frame therefore IS frame F, the frame
// the loop restarts on. Output is D − F long, scaled and cropped to the exact
// format size, silent (an AI model's ambient audio would fight the song),
// H.264/yuv420p with faststart — what AVPlayer, browsers and Spotify accept.
//
// Built with trim/setpts/fade/overlay because @ffmpeg-installer ships a 2018
// ffmpeg with no xfade filter (same constraint as src/lib/video-render.ts).
// Relative, extension-full imports only and no server-only imports —
// scripts/cassette-quick-test.mjs runs it under Node.

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import ffprobeInstaller from '@ffprobe-installer/ffprobe'
import { runFfmpeg } from './visualizer-encode.ts'
import { armDeadline } from './proc-deadline.ts'

const FFPROBE = ffprobeInstaller.path
void ffmpegInstaller

/** The filter graph for a seamless loop of a D-second clip with an F-second blend, at W×H. Exported for the test. */
export function loopFilter(D: number, F: number, W: number, H: number): string {
  const r = (v: number) => v.toFixed(3)
  const lead = Math.max(0, D - 2 * F)
  return [
    `[0:v]fps=30,scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,format=yuva420p,split[a][b]`,
    `[a]trim=start=${r(F)}:end=${r(D)},setpts=PTS-STARTPTS[main]`,
    `[b]trim=start=0:end=${r(F)},setpts=PTS-STARTPTS+${r(lead)}/TB,fade=t=in:st=${r(lead)}:d=${r(F)}:alpha=1[tail]`,
    `[main][tail]overlay=eof_action=pass,format=yuv420p[out]`,
  ].join(';')
}

async function probeSeconds(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file])
    let out = '', err = ''
    // The shared watchdog (a hard deadline, no idle rule: a probe prints once at the end).
    armDeadline(proc, 20_000, 0, 'ffprobe', reject)
    proc.stdout?.on('data', d => { out += String(d) })
    proc.stderr?.on('data', d => { err = (err + String(d)).slice(-1000) })
    proc.on('error', reject)
    proc.on('close', code => {
      const v = parseFloat(out)
      if (code !== 0 || !Number.isFinite(v) || v <= 0) reject(new Error(`ffprobe failed (${code}): ${err.trim()}`))
      else resolve(v)
    })
  })
}

/**
 * Make `input` (any video ffmpeg reads) a seamless, silent W×H loop.
 * Clips too short to blend (< 2.5 s) are only scaled and made silent.
 * Returns MP4 bytes.
 */
export async function seamlessLoop(input: Buffer | Uint8Array, opts: { width: number; height: number; fade?: number }): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'loop-'))
  try {
    const src = join(dir, 'in.mp4'), out = join(dir, 'out.mp4')
    await writeFile(src, input)
    const D = await probeSeconds(src)
    const { width: W, height: H } = opts
    const F = Math.min(opts.fade ?? 1, D * 0.2)
    const enc = ['-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out]
    if (D < 2.5) {
      await runFfmpeg(['-y', '-v', 'error', '-i', src, '-vf', `fps=30,scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`, ...enc], 120_000, 'loop scale')
    } else {
      await runFfmpeg(['-y', '-v', 'error', '-i', src, '-filter_complex', loopFilter(D, F, W, H), '-map', '[out]', '-t', (D - F).toFixed(3), ...enc], 120_000, 'seamless loop')
    }
    return await readFile(out)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Seconds of a video (exported for the test). */
export async function videoSeconds(bytes: Buffer | Uint8Array): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), 'probe-'))
  try {
    const f = join(dir, 'v.mp4')
    await writeFile(f, bytes)
    return await probeSeconds(f)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
