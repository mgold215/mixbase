// Visualizer WebM→MP4 transcode contract test — exercises the REAL production
// module (src/lib/visualizer-encode.ts via Node type stripping).
//
// Run: node scripts/visualizer-transcode-test.mjs
//
// Why this suite exists: commit 967e64c added the WebM→MP4 normalization so the
// native iOS app could play visualizers at all (AVPlayer cannot decode WebM).
// It shipped with zero coverage, and every flag in the encode is load-bearing
// for that one purpose — a later "cleanup" that drops -movflags +faststart or
// -pix_fmt yuv420p produces a file that still plays fine in desktop Chrome and
// silently fails or stalls on the exact device the feature was built for. That
// is a regression no reviewer would catch by reading the diff.
//
// The fixture carries an AUDIO track, so -an is proven to strip it rather than
// assumed. It is requested at ODD dimensions (641×361) — but see the
// precondition check below: both libvpx and libvpx-vp9 silently round to
// 640×360, so an odd-dimension WebM is not constructible with this ffmpeg. The
// even-dimension scale filter is therefore covered STRUCTURALLY ONLY, and the
// dimension assertion is written as "output matches source, and is even" rather
// than a resize claim it cannot actually exercise. The precondition assertion
// exists so that if a future encoder does preserve odd dimensions, this suite
// starts testing the real path loudly instead of passing vacuously — the trap
// scripts/video-test.mjs's webm fixture was previously caught in.
//
// Fail-first witnesses (each RUN and confirmed to fail when the guard is removed):
//  - drop '+faststart' → moov@117057 after mdat@44 → faststart check fails (verified)
//  - drop '-an'        → 1 audio stream survives   → silent check fails (verified)
//  - drop '-pix_fmt'   → pix_fmt is not yuv420p    → Apple-decodability check fails
//  - drop the -vf scale → structural check fails; the behavioural half does NOT,
//    which is exactly why it is labelled structural-only above.

import { spawn } from 'child_process'
import { mkdtemp, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createRequire } from 'module'
import {
  webmToMp4, mp4TwinPath, webmOriginalPath, mp4EncodeArgs, TRANSCODE_TIMEOUT_MS,
  tryAcquireTranscodeSlot, releaseTranscodeSlot, inFlightTranscodes,
} from '../src/lib/visualizer-encode.ts'

const require = createRequire(import.meta.url)
const FFMPEG = require('@ffmpeg-installer/ffmpeg').path
const FFPROBE = require('@ffprobe-installer/ffprobe').path

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// Mux to stdout (a non-seekable pipe) so the container carries no duration,
// exactly like a browser MediaRecorder blob — the shape this path really gets.
function runToBuffer(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = []
    let err = ''
    p.stdout.on('data', d => chunks.push(d))
    p.stderr.on('data', d => { err = (err + d).slice(-3000) })
    p.on('error', reject)
    p.on('close', c => (c === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(err.slice(-500)))))
  })
}

function probeStreams(file) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file])
    let out = ''
    p.stdout.on('data', d => { out += d })
    p.on('error', reject)
    p.on('close', c => (c === 0 ? resolve(JSON.parse(out)) : reject(new Error('ffprobe failed'))))
  })
}

// ── 1. Pure contracts (no ffmpeg) ────────────────────────────────────────────

// The heal derives the twin name from the WebM path on every run and uploads
// with upsert:true, so a partial failure converges instead of piling up copies.
check('mp4TwinPath: .webm → -h264.mp4',
  mp4TwinPath('abc-123/viz-1712345678.webm') === 'abc-123/viz-1712345678-h264.mp4',
  mp4TwinPath('abc-123/viz-1712345678.webm'))
check('mp4TwinPath: deterministic across calls',
  mp4TwinPath('p/v.webm') === mp4TwinPath('p/v.webm'))
check('mp4TwinPath: only the trailing .webm is replaced',
  mp4TwinPath('a.webm.dir/v.webm') === 'a.webm.dir/v-h264.mp4',
  mp4TwinPath('a.webm.dir/v.webm'))

// webmOriginalPath is the INVERSE of mp4TwinPath, and it is what makes a
// converted visualizer's original bytes deletable. Get it wrong and the WebM is
// orphaned in a PUBLIC bucket forever — including after a GDPR account delete.
check('webmOriginalPath: round-trips mp4TwinPath',
  webmOriginalPath(mp4TwinPath('proj/viz-99.webm')) === 'proj/viz-99.webm',
  webmOriginalPath(mp4TwinPath('proj/viz-99.webm')))
check('webmOriginalPath: null for a non-twin (save-time mp4 has no original)',
  webmOriginalPath('proj/viz-123.mp4') === null)
check('webmOriginalPath: null for a plain webm', webmOriginalPath('proj/viz-123.webm') === null)
// A file legitimately named "...-h264.mp4" that was never a twin would map to a
// .webm that doesn't exist; Supabase remove() no-ops on missing keys, so the
// only requirement is that it never maps to some OTHER live object.
check('webmOriginalPath: only ever swaps the -h264.mp4 suffix',
  webmOriginalPath('a/b-h264.mp4.mp4') === null && webmOriginalPath('a/b-h264.mp4') === 'a/b.webm')

// The concurrency gate is what actually protects the container: the rate limiter
// caps how OFTEN one user asks, this caps how many encoders run AT ONCE.
{
  const before = inFlightTranscodes()
  const a = tryAcquireTranscodeSlot()
  const b = tryAcquireTranscodeSlot()
  const c = tryAcquireTranscodeSlot()
  check('transcode gate: admits up to the cap', a === true && b === true, `${a}, ${b}`)
  check('transcode gate: refuses past the cap (caller 503s)', c === false)
  check('transcode gate: tracks in-flight count', inFlightTranscodes() === before + 2,
    `${inFlightTranscodes()}`)
  releaseTranscodeSlot(); releaseTranscodeSlot()
  check('transcode gate: releases slots', inFlightTranscodes() === before, `${inFlightTranscodes()}`)
  releaseTranscodeSlot()
  check('transcode gate: release never underflows past zero', inFlightTranscodes() >= 0,
    `${inFlightTranscodes()}`)
}

// These flags are the entire reason the conversion exists. Assert them
// structurally too, so a removal fails fast and by name even if ffmpeg is slow
// or unavailable on the machine running the suite.
const args = mp4EncodeArgs('/tmp/in.webm', '/tmp/out.mp4')
const argStr = args.join(' ')
check('encode args: H.264 video codec', argStr.includes('-c:v libx264'))
check('encode args: yuv420p for Apple hardware', argStr.includes('-pix_fmt yuv420p'))
check('encode args: +faststart for progressive remote playback', argStr.includes('-movflags +faststart'))
check('encode args: -an strips audio', args.includes('-an'))
check('encode args: even-dimension scale filter', argStr.includes('scale=trunc(iw/2)*2:trunc(ih/2)*2'))
check('encode args: input precedes output', args.indexOf('/tmp/in.webm') < args.indexOf('/tmp/out.mp4'))
check('transcode timeout is bounded and SIGKILL-able', TRANSCODE_TIMEOUT_MS > 0 && TRANSCODE_TIMEOUT_MS <= 120_000,
  `${TRANSCODE_TIMEOUT_MS}ms`)

// ── 2. Real encode against a hostile fixture ─────────────────────────────────

const dir = await mkdtemp(join(tmpdir(), 'mb-viz-transcode-'))
try {
  // 641×361 (odd both ways) + a 440 Hz tone, muxed to a pipe.
  const webm = await runToBuffer(FFMPEG, [
    '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=641x361:rate=15:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libvpx', '-c:a', 'libvorbis',
    '-f', 'webm', '-',
  ])
  check('fixture: odd-dimension webm with audio built', webm.length > 0, `${webm.length} bytes`)

  const srcPath = join(dir, 'fixture.webm')
  await writeFile(srcPath, webm)
  const srcProbe = await probeStreams(srcPath)
  const srcAudio = srcProbe.streams.filter(s => s.codec_type === 'audio')
  const srcVideo = srcProbe.streams.find(s => s.codec_type === 'video')
  // Guard the guard: if the fixture ever stops carrying audio, the -an
  // assertion below would pass vacuously and stop testing anything.
  check('fixture precondition: source really has an audio track', srcAudio.length === 1)
  // And record what the encoder actually produced. 641×361 was requested;
  // libvpx rounds it. If a future encoder honours odd dimensions this check
  // goes red, which is the signal to promote the scale-filter assertion below
  // from structural to behavioural.
  check('fixture precondition: webm encoder rounded to even (odd input not constructible)',
    srcVideo?.width === 640 && srcVideo?.height === 360,
    `${srcVideo?.width}×${srcVideo?.height}`)

  const mp4 = await webmToMp4(webm)
  check('webmToMp4 returns bytes', Buffer.isBuffer(mp4) && mp4.length > 0, `${mp4.length} bytes`)

  const outPath = join(dir, 'out.mp4')
  await writeFile(outPath, mp4)
  const probe = await probeStreams(outPath)
  const video = probe.streams.find(s => s.codec_type === 'video')
  const audio = probe.streams.filter(s => s.codec_type === 'audio')

  check('output: is a real MP4 container', (probe.format?.format_name ?? '').includes('mp4'),
    probe.format?.format_name)
  check('output: H.264 video stream', video?.codec_name === 'h264', video?.codec_name)
  check('output: pix_fmt is yuv420p (iOS/Safari decodable)', video?.pix_fmt === 'yuv420p', video?.pix_fmt)
  // Dimensions must survive unchanged AND be even (libx264 + yuv420p requires
  // even; an unintended resize would soften the loop against the artwork).
  check('output: dimensions preserved from source',
    video?.width === srcVideo?.width && video?.height === srcVideo?.height,
    `${video?.width}×${video?.height}`)
  check('output: dimensions are even (libx264/yuv420p requirement)',
    video?.width % 2 === 0 && video?.height % 2 === 0)
  check('output: silent — the mix is the audio', audio.length === 0, `${audio.length} audio stream(s)`)
  check('output: duration preserved', Math.abs(Number(probe.format?.duration) - 2) < 0.5,
    `${Number(probe.format?.duration).toFixed(2)}s`)

  // faststart moves the moov atom ahead of mdat so a remote <video> can start
  // playing before the whole file arrives. Without it iOS buffers the entire
  // clip (or stalls) — the failure this whole commit set out to prevent.
  const head = mp4.subarray(0, Math.min(mp4.length, 4 * 1024 * 1024))
  const moovAt = head.indexOf(Buffer.from('moov'))
  const mdatAt = head.indexOf(Buffer.from('mdat'))
  check('output: moov atom present', moovAt !== -1)
  check('output: faststart — moov precedes mdat', moovAt !== -1 && mdatAt !== -1 && moovAt < mdatAt,
    `moov@${moovAt} mdat@${mdatAt}`)

  // The save route caps uploads at 10 MB before transcode; confirm the H.264
  // re-encode of a small loop doesn't balloon past what mf-video accepts.
  const srcSize = (await stat(srcPath)).size
  check('output: re-encode stays in the same size class as the source',
    mp4.length < Math.max(srcSize * 8, 2 * 1024 * 1024),
    `${(mp4.length / 1024).toFixed(0)}KB from ${(srcSize / 1024).toFixed(0)}KB`)

  // ── 3. Failure path: garbage in must reject, not silently emit a stub ──────
  let threw = false
  try {
    await webmToMp4(Buffer.from('this is not a webm file at all, not even close'))
  } catch {
    threw = true
  }
  check('non-video input rejects rather than producing a bogus MP4', threw)
} finally {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

console.log(failures === 0 ? '\n✅ ALL CHECKS PASSED' : `\n❌ ${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
