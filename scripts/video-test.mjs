// Video finalizer smoke test — exercises the REAL production module
// (src/lib/video-render.ts via Node type stripping), no inline copies.
//
// Run: node scripts/video-test.mjs
//
// Builds synthetic inputs with the bundled ffmpeg (a 4s moving-pattern
// visualizer clip + sine-wave audio), serves them over a local HTTP server
// (the renderer downloads via fetch, same as production), renders a YouTube
// video and a Short, then asserts on the actual output files:
//  - container duration matches the audio / clip length
//  - frame size is 1920×1080 (YouTube) and 1080×1920 (Short)
//  - H.264 video + AAC audio streams both present
//  - the title card is VISIBLE during a scheduled flash window and ABSENT
//    outside it (frame-differencing against the text overlay's whiteness)
//  - flashWindows() schedule is sane across song lengths

import { spawn } from 'child_process'
import { mkdtemp, rm, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createServer } from 'http'
import { createRequire } from 'module'
import { buildFinalVideo, flashWindows, probeDuration } from '../src/lib/video-render.ts'

const require = createRequire(import.meta.url)
const FFMPEG = require('@ffmpeg-installer/ffmpeg').path
const FFPROBE = require('@ffprobe-installer/ffprobe').path
const sharp = require('sharp')

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', d => { err = (err + d).slice(-3000) })
    p.on('close', c => (c === 0 ? resolve() : reject(new Error(`${args[args.length - 1]}: ${err.slice(-500)}`))))
  })
}

// Run ffmpeg writing the container to stdout (a non-seekable pipe) and save it.
// This produces the same header shape as a browser MediaRecorder blob: the
// muxer can't seek back to write the duration, so the file carries none.
function runToFile(bin, args, dest) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = []
    let err = ''
    p.stdout.on('data', d => chunks.push(d))
    p.stderr.on('data', d => { err = (err + d).slice(-3000) })
    p.on('close', async c => {
      if (c !== 0) return reject(new Error(err.slice(-500)))
      await (await import('fs/promises')).writeFile(dest, Buffer.concat(chunks))
      resolve()
    })
  })
}

function probeStreams(file) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', file])
    let out = ''
    p.stdout.on('data', d => { out += d })
    p.on('close', c => (c === 0 ? resolve(JSON.parse(out).streams) : reject(new Error('ffprobe failed'))))
  })
}

// Extract one frame at time t and count near-white pixels (the default text
// color) in the middle band where the card renders.
async function whiteCountAt(file, t, w, h) {
  const dir = await mkdtemp(join(tmpdir(), 'mb-frame-'))
  const frame = join(dir, 'f.png')
  try {
    await run(FFMPEG, ['-y', '-ss', String(t), '-i', file, '-frames:v', '1', frame])
    const band = { left: 0, top: Math.round(h * 0.35), width: w, height: Math.round(h * 0.3) }
    const { data, info } = await sharp(frame).extract(band).raw().toBuffer({ resolveWithObject: true })
    let n = 0
    for (let i = 0; i < data.length; i += info.channels) {
      if (data[i] >= 235 && data[i + 1] >= 235 && data[i + 2] >= 235) n++
    }
    return n
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

// ── 1. flashWindows schedule ─────────────────────────────────────────────────
{
  const w20 = flashWindows(20)
  check('20s video gets intro card', w20.length >= 1 && w20[0].start === 2, JSON.stringify(w20))
  const w240 = flashWindows(240)
  const inBounds = w240.every(w => w.start >= 0 && w.end <= 240 - 5)
  const ordered = w240.every((w, i) => i === 0 || w.start > w240[i - 1].end + 5)
  check('4min schedule: multiple cards, in bounds, non-overlapping',
    w240.length >= 4 && inBounds && ordered, `${w240.length} cards`)
  const w600 = flashWindows(600)
  check('10min schedule stays bounded', w600.length >= 4 && w600.length <= 12, `${w600.length} cards`)
  const w8 = flashWindows(8)
  check('very short video: single clamped card', w8.length === 1 && w8[0].end <= 7.5, JSON.stringify(w8))
}

// ── 2. Synthetic inputs ──────────────────────────────────────────────────────
const dir = await mkdtemp(join(tmpdir(), 'mb-videotest-'))
const vizFile = join(dir, 'viz.mp4')
const audio20 = join(dir, 'audio20.wav')
const audio100 = join(dir, 'audio100.wav')
const vizWebm = join(dir, 'viz.webm')
// Moving test pattern ≈ a landscape visualizer loop.
await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=4', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', vizFile])
// Same clip as a MediaRecorder-style webm: streamed to a pipe so the container
// carries NO duration metadata — the shape every free-effects visualizer has.
await runToFile(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=4', '-c:v', 'libvpx', '-f', 'webm', '-'], vizWebm)
await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20', audio20])
await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=100', audio100])

// Serve them over HTTP — the renderer fetches URLs exactly like production.
const server = createServer(async (req, res) => {
  const map = { '/viz.mp4': vizFile, '/viz.webm': vizWebm, '/audio20.wav': audio20, '/audio100.wav': audio100 }
  const file = map[req.url]
  if (!file) { res.writeHead(404); return res.end() }
  res.writeHead(200)
  res.end(await readFile(file))
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

try {
  // ── 3. YouTube render (full 20s "song") ────────────────────────────────────
  {
    let lastStage = ''
    const out = await buildFinalVideo({
      visualizerUrl: `${base}/viz.mp4`,
      audioUrl: `${base}/audio20.wav`,
      title: 'PLAY',
      artist: 'moodmixformat',
      format: 'youtube',
      onProgress: (_f, stage) => { lastStage = stage },
    })
    check('youtube: renderer reported progress stages', lastStage.length > 0, lastStage)
    check('youtube: dimensions 1920×1080', out.width === 1920 && out.height === 1080)
    check('youtube: duration matches song', Math.abs(out.durationSec - 20) < 0.75, `${out.durationSec.toFixed(2)}s`)

    const outFile = join(dir, 'yt.mp4')
    await (await import('fs/promises')).writeFile(outFile, out.bytes)
    const streams = await probeStreams(outFile)
    const v = streams.find(s => s.codec_type === 'video')
    const a = streams.find(s => s.codec_type === 'audio')
    check('youtube: h264 video stream', v?.codec_name === 'h264', v?.codec_name)
    check('youtube: aac audio stream', a?.codec_name === 'aac', a?.codec_name)
    check('youtube: actual frame size', v?.width === 1920 && v?.height === 1080, `${v?.width}×${v?.height}`)

    // Flash check: intro window is [2,7] — card fully visible at t=4.5.
    // t=10 is between windows — card must be gone.
    const inFlash = await whiteCountAt(outFile, 4.5, 1920, 1080)
    const offFlash = await whiteCountAt(outFile, 10, 1920, 1080)
    check('youtube: title card visible mid-flash', inFlash > 2000, `${inFlash} white px`)
    check('youtube: title card absent between flashes', offFlash < inFlash / 10, `${offFlash} vs ${inFlash}`)
  }

  // ── 4. Short render (15s clip from the middle of a 100s song) ─────────────
  {
    const out = await buildFinalVideo({
      visualizerUrl: `${base}/viz.mp4`,
      audioUrl: `${base}/audio100.wav`,
      title: 'PLAY',
      artist: 'moodmixformat',
      format: 'shorts',
      startSec: 30,
      clipSeconds: 15,
    })
    check('shorts: dimensions 1080×1920', out.width === 1080 && out.height === 1920)
    check('shorts: clip length respected', Math.abs(out.durationSec - 15) < 0.75, `${out.durationSec.toFixed(2)}s`)

    const outFile = join(dir, 'short.mp4')
    await (await import('fs/promises')).writeFile(outFile, out.bytes)
    const streams = await probeStreams(outFile)
    const v = streams.find(s => s.codec_type === 'video')
    const a = streams.find(s => s.codec_type === 'audio')
    check('shorts: h264 + aac streams', v?.codec_name === 'h264' && a?.codec_name === 'aac')
    check('shorts: actual frame size', v?.width === 1080 && v?.height === 1920, `${v?.width}×${v?.height}`)

    const dur = await probeDuration(outFile)
    check('shorts: container duration sane', Math.abs(dur - 15) < 0.75, `${dur.toFixed(2)}s`)
  }

  // ── 5. Duration-less webm visualizer (MediaRecorder shape) ─────────────────
  // Regression: free-effects pins are browser-recorded webm with no duration
  // metadata; probeDuration must fall back to decode-measuring and the Short
  // must still render. Before the fallback this threw "Could not determine
  // visualizer duration".
  {
    const webmDur = await probeDuration(join(dir, 'viz.webm'), 'visualizer')
    check('webm: duration measured despite missing metadata', Math.abs(webmDur - 4) < 0.5, `${webmDur.toFixed(2)}s`)

    const out = await buildFinalVideo({
      visualizerUrl: `${base}/viz.webm`,
      audioUrl: `${base}/audio100.wav`,
      title: 'PLAY',
      artist: 'moodmixformat',
      format: 'shorts',
      startSec: 30,
      clipSeconds: 15,
    })
    check('webm shorts: dimensions 1080×1920', out.width === 1080 && out.height === 1920)
    check('webm shorts: clip length respected', Math.abs(out.durationSec - 15) < 0.75, `${out.durationSec.toFixed(2)}s`)
  }
} finally {
  server.close()
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

console.log('---')
console.log(failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
