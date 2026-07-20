import { spawn } from 'child_process'
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import ffprobeInstaller from '@ffprobe-installer/ffprobe'
// Relative extension-full import (not the @/ alias) so the smoke test can
// exercise this module directly under plain Node type-stripping.
import { buildTextOverlay, DEFAULT_TEXT_COLOR } from './finalize-render.ts'

// ── Final video renderer ─────────────────────────────────────────────────────
// Composes the finished YouTube video / vertical Short for a song from the
// pieces the user already made: the pinned visualizer loop, the current mix's
// audio, and the artwork text lockup (artist / rule / title).
//
//   Pass 1: normalize the visualizer to the target frame (cover-scale, 30fps)
//           and splice it into a SEAMLESS loop unit — the clip's tail
//           crossfades into its head, so end-frame == start-frame and the unit
//           can repeat forever without a visible cut.
//   Pass 2: -stream_loop the unit for the song's length, flash the text lockup
//           (fade in/out) at scheduled points, mux the audio, encode H.264+AAC
//           with +faststart — upload-ready for YouTube/Shorts.
//
// The bundled ffmpeg (@ffmpeg-installer, npm-hosted so installs work behind
// proxies and on Railway nixpacks) is a 2018 build: no xfade filter. The
// crossfade is therefore built from trim/concat/fade-alpha/overlay, which are
// ancient and stable:  base = tail ⧺ head[D..L],  over = head faded in over
// [0,D],  unit = overlay(base, over). unit(0)=tail(0)=clip(L)=unit(L) — seam
// closed. All filter args are numbers we compute, never user strings.

const FFMPEG = ffmpegInstaller.path
const FFPROBE = ffprobeInstaller.path

export type VideoFormat = 'youtube' | 'shorts'

export const VIDEO_DIMENSIONS: Record<VideoFormat, { w: number; h: number }> = {
  youtube: { w: 1920, h: 1080 },
  shorts: { w: 1080, h: 1920 },
}

// Hard ceiling: at maxrate 4 Mbps + 256k AAC, 12 minutes ≈ 380 MB — safely
// under the mf-video bucket's 500 MB limit. Longer songs get a clear error
// instead of a failed upload after minutes of encoding.
export const MAX_SONG_SECONDS = 12 * 60
export const SHORTS_LENGTHS = [15, 30, 60] as const

export type RenderProgress = (fraction: number, stage: string) => void

export type BuildVideoArgs = {
  visualizerUrl: string
  audioUrl: string
  title: string
  artist: string
  format: VideoFormat
  color?: string
  /** Shorts only: where in the song the clip starts (seconds). */
  startSec?: number
  /** Shorts only: clip length in seconds (15/30/60). */
  clipSeconds?: number
  /**
   * Duration recorded at upload time (mb_versions.duration_seconds). Used when
   * ffprobe can't read a duration from the audio container (VBR MP3s without
   * a Xing header, odd WAV/M4A headers) — the file usually still decodes fine.
   */
  fallbackAudioSeconds?: number
  onProgress?: RenderProgress
}

export type BuiltVideo = {
  bytes: Buffer
  durationSec: number
  width: number
  height: number
}

// ── Flash schedule ───────────────────────────────────────────────────────────
// When the title card appears. Deterministic and pure so it's unit-testable:
// an intro card once the video settles, periodic reminders through the body,
// and an outro card before the end. Never overlapping, never off the end.
export type FlashWindow = { start: number; end: number }
export const FLASH_VISIBLE_SEC = 5
export const FLASH_FADE_SEC = 0.5

export function flashWindows(totalSec: number): FlashWindow[] {
  const V = FLASH_VISIBLE_SEC
  if (totalSec < 12) {
    // Too short for a schedule — one card across the middle.
    const start = Math.max(0.5, totalSec * 0.15)
    const end = Math.min(totalSec - 1, start + V)
    return end - start >= 1.5 ? [{ start, end }] : []
  }
  const windows: FlashWindow[] = [{ start: 2, end: 2 + V }]
  // Body cards roughly every 45s, stretched for very long songs so the count
  // stays bounded (≤ ~10 cards regardless of length).
  const step = Math.max(45, Math.ceil(totalSec / 9))
  const outroStart = totalSec - 11
  for (let t = step; t + V < outroStart - 8; t += step) {
    windows.push({ start: t, end: t + V })
  }
  if (outroStart > windows[windows.length - 1].end + 8) {
    windows.push({ start: outroStart, end: outroStart + V })
  }
  return windows
}

// ── Small process helpers ────────────────────────────────────────────────────

function run(bin: string, args: string[], onStdout?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderrTail = ''
    proc.stdout.on('data', (d: Buffer) => {
      if (onStdout) for (const line of d.toString().split('\n')) onStdout(line)
    })
    proc.stderr.on('data', (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-4000)
    })
    proc.on('error', reject)
    proc.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`${bin.split('/').pop()} exited ${code}: ${stderrTail.slice(-1500)}`))
    })
  })
}

async function probeJson(file: string): Promise<{
  format?: { duration?: string }
  streams?: Array<{ codec_type?: string; duration?: string; width?: number; height?: number; codec_name?: string }>
}> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file])
    let out = ''
    let err = ''
    proc.stdout.on('data', (d: Buffer) => { out += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-2000) })
    proc.on('error', reject)
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`ffprobe exited ${code}: ${err}`))
      try { resolve(JSON.parse(out)) } catch { reject(new Error('ffprobe returned unparseable JSON')) }
    })
  })
}

// Decode the file to a null sink and read the final timestamp. Slower than a
// metadata probe but works on files that carry no duration in the header —
// most importantly the free-effects visualizers, which browsers record with
// MediaRecorder as streamed webm (duration is unwritable in a non-seekable
// stream, so ffprobe reports nothing for format or streams).
function measureDurationByDecoding(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, ['-v', 'error', '-i', file, '-f', 'null', '-progress', 'pipe:1', '-'])
    let micros = 0
    let err = ''
    proc.stdout.on('data', (d: Buffer) => {
      for (const line of d.toString().split('\n')) {
        const m = line.match(/^out_time_ms=(\d+)/) // misnamed by ffmpeg: microseconds
        if (m) micros = Math.max(micros, Number(m[1]))
      }
    })
    proc.stderr.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-1500) })
    proc.on('error', reject)
    proc.on('close', code => {
      if (code === 0 && micros > 0) resolve(micros / 1e6)
      else reject(new Error(`Could not measure duration by decoding: ${err || `ffmpeg exited ${code}`}`))
    })
  })
}

export async function probeDuration(file: string, label = 'media'): Promise<number> {
  const info = await probeJson(file)
  const fromFormat = parseFloat(info.format?.duration ?? '')
  if (Number.isFinite(fromFormat) && fromFormat > 0) return fromFormat
  for (const s of info.streams ?? []) {
    const d = parseFloat(s.duration ?? '')
    if (Number.isFinite(d) && d > 0) return d
  }
  try {
    return await measureDurationByDecoding(file)
  } catch {
    throw new Error(`Could not determine ${label} duration`)
  }
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url.split('?')[0]}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.length === 0) throw new Error('Downloaded file is empty')
  await writeFile(dest, bytes)
}

// ffmpeg -progress pipe:1 emits `out_time_ms=<µs>` lines (misnamed: microseconds).
function progressParser(totalSec: number, report: (frac: number) => void): (line: string) => void {
  return line => {
    const m = line.match(/^out_time_ms=(\d+)/)
    if (m) report(Math.min(1, Number(m[1]) / 1e6 / totalSec))
  }
}

// ── Main entry ───────────────────────────────────────────────────────────────
export async function buildFinalVideo(args: BuildVideoArgs): Promise<BuiltVideo> {
  const { visualizerUrl, audioUrl, title, artist, format, onProgress } = args
  const color = args.color ?? DEFAULT_TEXT_COLOR
  const { w: W, h: H } = VIDEO_DIMENSIONS[format]
  const report = (f: number, stage: string) => { try { onProgress?.(f, stage) } catch { /* progress is best-effort */ } }

  const dir = await mkdtemp(join(tmpdir(), 'mb-video-'))
  try {
    // ── Fetch inputs ────────────────────────────────────────────────────────
    report(0.01, 'Fetching visualizer + audio')
    const vizFile = join(dir, 'viz.input')
    const audioFile = join(dir, 'audio.input')
    await Promise.all([download(visualizerUrl, vizFile), download(audioUrl, audioFile)])

    const [vizDur, audioDur] = await Promise.all([
      probeDuration(vizFile, 'visualizer'),
      probeDuration(audioFile, 'audio').catch(err => {
        // Some uploads (VBR MP3 without a Xing header, quirky WAV/M4A) carry
        // no readable duration metadata but still decode fine — fall back to
        // the duration measured client-side at upload instead of failing.
        const fallback = args.fallbackAudioSeconds ?? 0
        if (fallback > 0) return fallback
        throw err
      }),
    ])
    if (vizDur < 0.5) throw new Error('Visualizer clip is too short to loop')

    // ── Output timing ───────────────────────────────────────────────────────
    let startSec = 0
    let outDur: number
    if (format === 'shorts') {
      const clip = SHORTS_LENGTHS.includes((args.clipSeconds ?? 30) as typeof SHORTS_LENGTHS[number])
        ? (args.clipSeconds ?? 30) : 30
      startSec = Math.max(0, Math.min(args.startSec ?? 0, Math.max(0, audioDur - 5)))
      outDur = Math.min(clip, audioDur - startSec)
    } else {
      outDur = audioDur
    }
    if (outDur > MAX_SONG_SECONDS) {
      throw new Error(`Song is longer than ${MAX_SONG_SECONDS / 60} minutes — final video would exceed storage limits`)
    }
    if (outDur < 3) throw new Error('Not enough audio to render a video')

    // ── Pass 1: seamless loop unit at target frame size ─────────────────────
    // D = crossfade length, L = unit length. unit(t): t∈[0,D] blends the
    // clip's tail into its head; t∈(D,L] is the clip itself. unit(L)=clip(L)=
    // unit(0), so repeats are seamless ("transition between the looped videos").
    report(0.03, 'Building seamless loop')
    const D = Math.min(1.0, vizDur * 0.25)
    const L = vizDur - D
    const unitFile = join(dir, 'unit.mp4')
    const norm = `fps=30,scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`
    const unitGraph = [
      `[0:v]${norm},format=yuva420p,split=3[s1][s2][s3]`,
      `[s1]trim=start=${L.toFixed(3)},setpts=PTS-STARTPTS[tail]`,
      `[s2]trim=start=${D.toFixed(3)}:end=${L.toFixed(3)},setpts=PTS-STARTPTS[rest]`,
      `[tail][rest]concat=n=2:v=1:a=0[base]`,
      `[s3]trim=end=${L.toFixed(3)},setpts=PTS-STARTPTS,fade=t=in:st=0:d=${D.toFixed(3)}:alpha=1[over]`,
      `[base][over]overlay=x=0:y=0,format=yuv420p[unit]`,
    ].join(';')
    await run(FFMPEG, [
      '-y', '-i', vizFile,
      '-filter_complex', unitGraph,
      '-map', '[unit]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-r', '30',
      '-progress', 'pipe:1',
      unitFile,
    ], progressParser(L, f => report(0.03 + f * 0.15, 'Building seamless loop')))

    const unitDur = await probeDuration(unitFile)
    if (unitDur < 0.2) throw new Error('Loop unit came out empty')

    // ── Text overlay PNG: the artwork lockup, scaled to this frame ──────────
    // Width drives the type scale exactly like the artwork (fractions of W),
    // so the video card matches the finalized cover.
    const overlay = await buildTextOverlay(title, artist, W, 'medium', true, color)
    const textFile = join(dir, 'text.png')
    await writeFile(textFile, overlay.png)

    // ── Pass 2: loop for the song, flash text, mux audio ────────────────────
    report(0.2, 'Rendering full video')
    const windows = flashWindows(outDur)
    const F = FLASH_FADE_SEC
    const loops = Math.ceil(outDur / unitDur) + 1

    const parts: string[] = [`[0:v]trim=end=${outDur.toFixed(3)},setpts=PTS-STARTPTS[bg]`]
    let chain = 'bg'
    if (windows.length > 0) {
      const splitLabels = windows.map((_, i) => `[t${i}]`).join('')
      parts.push(`[2:v]format=rgba${windows.length > 1 ? `,split=${windows.length}${splitLabels}` : '[t0]'}`)
      windows.forEach((win, i) => {
        // Fade the card in at win.start and out at win.end; enable bounds the
        // overlay work (and guarantees zero contribution outside the window).
        parts.push(
          `[t${i}]fade=t=in:st=${win.start.toFixed(3)}:d=${F}:alpha=1,` +
          `fade=t=out:st=${win.end.toFixed(3)}:d=${F}:alpha=1[f${i}]`
        )
        const next = `v${i}`
        parts.push(
          `[${chain}][f${i}]overlay=x=(W-w)/2:y=(H-h)/2:` +
          `enable='between(t,${win.start.toFixed(3)},${(win.end + F).toFixed(3)})'[${next}]`
        )
        chain = next
      })
    }
    // Shorts are a cut from the middle of a song — fade audio at both edges so
    // the clip doesn't start or stop mid-waveform. Full videos play the song
    // out naturally.
    const audioFilter = format === 'shorts'
      ? `[1:a]atrim=end=${outDur.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.3,afade=t=out:st=${Math.max(0, outDur - 1.5).toFixed(3)}:d=1.5[aud]`
      : `[1:a]atrim=end=${outDur.toFixed(3)},asetpts=PTS-STARTPTS[aud]`
    parts.push(audioFilter)

    const outFile = join(dir, 'final.mp4')
    const inputArgs = [
      '-stream_loop', String(loops - 1), '-i', unitFile,
      ...(startSec > 0 ? ['-ss', startSec.toFixed(3)] : []), '-i', audioFile,
      '-loop', '1', '-i', textFile,
    ]
    await run(FFMPEG, [
      '-y', ...inputArgs,
      '-filter_complex', parts.join(';'),
      '-map', `[${chain}]`, '-map', '[aud]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
      '-maxrate', '4M', '-bufsize', '8M', '-pix_fmt', 'yuv420p', '-r', '30',
      '-c:a', 'aac', '-b:a', '256k', '-ar', '48000',
      '-movflags', '+faststart',
      '-t', outDur.toFixed(3),
      '-progress', 'pipe:1',
      outFile,
    ], progressParser(outDur, f => report(0.2 + f * 0.75, 'Rendering full video')))

    report(0.96, 'Finishing')
    const bytes = await readFile(outFile)
    if (bytes.length === 0) throw new Error('Encoder produced an empty file')
    const durationSec = await probeDuration(outFile)
    return { bytes, durationSec, width: W, height: H }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
