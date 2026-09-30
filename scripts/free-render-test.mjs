// Server-side free visualizer contract test — exercises the REAL production
// modules (src/lib/free-render.ts + free-render-worker.ts via Node type
// stripping) on the same @napi-rs/canvas + ffmpeg the server uses.
//
// Run: node scripts/free-render-test.mjs
//
// Why this suite exists: the iOS app's free generator renders on the server
// (it has no browser canvas to record). It used to be a separate ffmpeg
// imitation with 3 of the web's 12 effects; it now runs the web engine itself,
// so the app offers exactly what the web does. What can silently break that:
//  - the effect list drifting from the web's (EFFECTS in free-effects.ts);
//  - the formats drifting from the web's FORMAT_CONFIG;
//  - an old app build's effect id ('drift') being rejected;
//  - @napi-rs/canvas retaining a snapshot of every canvas drawn into a context
//    until ctx.reset() — ~70 MB/frame for Drone Shot, which OOM-killed a 30s
//    render. The worker resets per frame; the checks below prove the reset is
//    still needed (so a library fix shows up here) and pixel-identical.
//
// Fail-first witnesses (each RUN and confirmed to fail when the guard is removed):
//  - drop ctx.reset() from the worker → the Drone render's RSS check fails
//  - drop the 'drift' alias           → the legacy-id check fails

import { spawn } from 'child_process'
import { readFileSync } from 'fs'
import { createRequire } from 'module'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { EFFECTS, EFFECT_IDS } from '../src/lib/free-effects.ts'
import {
  FREE_FORMATS, isFreeFormat, resolveFreeEffect, freeEffectList, clampFreeBpm,
  sliceCount, sliceEncodeArgs, renderFreeVisualizer,
} from '../src/lib/free-render.ts'

const require = createRequire(import.meta.url)
const FFMPEG = require('@ffmpeg-installer/ffmpeg').path

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// ── Parity with the web generator ────────────────────────────────────────────
const list = freeEffectList()
check('effect list is exactly the web engine\'s, in order',
  JSON.stringify(list.map(e => e.id)) === JSON.stringify(EFFECT_IDS), list.map(e => e.id).join(','))
check('effect labels come from the web engine',
  list.every(e => e.label === EFFECTS[e.id].label && e.beatSynced === EFFECTS[e.id].beatSynced))
for (const id of EFFECT_IDS) {
  if (resolveFreeEffect(id) !== id) check(`resolves web id ${id}`, false)
}
check('every web effect id is accepted', EFFECT_IDS.every(id => resolveFreeEffect(id) === id))
check('legacy app id "drift" still renders (Cinematic Drift)', resolveFreeEffect('drift') === 'kenburns')
check('unknown / prototype ids are rejected',
  resolveFreeEffect('nope') === null && resolveFreeEffect('toString') === null &&
  resolveFreeEffect('__proto__') === null && resolveFreeEffect(7) === null)

// The web's formats live in a client component module; read the literal table
// rather than importing it (it pulls in '@/' aliases Node can't resolve).
const shared = readFileSync(new URL('../src/components/visualizer/shared.ts', import.meta.url), 'utf8')
const webFormats = {}
for (const m of shared.matchAll(/(\w+):\s*\{\s*label:\s*'([^']+)',\s*width:\s*(\d+),\s*height:\s*(\d+),\s*duration:\s*(\d+)/g)) {
  webFormats[m[1]] = { label: m[2], width: +m[3], height: +m[4], duration: +m[5] }
}
check('formats match the web FORMAT_CONFIG exactly',
  Object.keys(webFormats).length > 0 &&
  JSON.stringify(Object.keys(webFormats).sort()) === JSON.stringify(Object.keys(FREE_FORMATS).sort()) &&
  Object.entries(webFormats).every(([k, v]) => JSON.stringify(v) === JSON.stringify(FREE_FORMATS[k])),
  JSON.stringify(webFormats))
check('format guard', isFreeFormat('canvas') && isFreeFormat('story') && !isFreeFormat('toString') && !isFreeFormat(1))
check('bpm clamps like the web field',
  clampFreeBpm(20) === 60 && clampFreeBpm(500) === 200 && clampFreeBpm(128.4) === 128 &&
  clampFreeBpm(undefined) === 122 && clampFreeBpm(NaN) === 122)

// ── Slicing ──────────────────────────────────────────────────────────────────
check('6s loop on a big box: 2 slices', sliceCount(180, 24) === 2, String(sliceCount(180, 24)))
check('30s loop on a big box: capped at 4', sliceCount(900, 24) === 4, String(sliceCount(900, 24)))
check('1-CPU box: never below 1 slice', sliceCount(900, 1) === 1 && sliceCount(1, 24) === 1)
const args = sliceEncodeArgs(1080, 1920, '/tmp/x.mp4')
check('slice encode: raw RGBA from stdin at the frame size',
  args.join(' ').includes('-f rawvideo -pix_fmt rgba -s 1080x1920 -framerate 30 -i pipe:0'))
check('slice encode: silent H.264 yuv420p + faststart (iOS-playable)',
  args.includes('-an') && args.includes('libx264') && args[args.indexOf('-pix_fmt', args.indexOf('libx264')) + 1] === 'yuv420p' &&
  args.includes('+faststart'))

// ── The @napi-rs/canvas snapshot leak + the reset that contains it ───────────
{
  const W = 480, H = 270
  const art = createCanvas(600, 800)
  const a = art.getContext('2d')
  for (let i = 0; i < 200; i++) { a.fillStyle = `hsl(${i * 7},80%,50%)`; a.fillRect((i * 97) % 600, (i * 53) % 800, 60, 40) }
  const img = await loadImage(art.toBuffer('image/png'))
  const layer = (w, h) => { const c = createCanvas(w, h); return { canvas: c, ctx: c.getContext('2d') } }
  // Every effect must paint its whole frame: a reset (transparent) canvas and a
  // dirty one must produce the same pixels, or the reset changes the look.
  let identical = true
  for (const id of EFFECT_IDS) {
    const make = () => {
      const c = createCanvas(W, H)
      const ctx = c.getContext('2d')
      const draw = EFFECTS[id].create({ W, H, duration: 6, fps: 30, bpm: 122, seed: 9, image: img, imageWidth: 600, imageHeight: 800, createLayer: layer })
      return { ctx, draw }
    }
    const A = make(), B = make()
    for (let f = 0; f < 6; f++) { A.draw(A.ctx, f / 180, f); B.ctx.reset(); B.draw(B.ctx, f / 180, f) }
    const pa = A.ctx.getImageData(0, 0, W, H).data, pb = B.ctx.getImageData(0, 0, W, H).data
    let same = pa.length === pb.length
    for (let i = 0; same && i < pa.length; i++) if (pa[i] !== pb[i]) same = false
    if (!same) { identical = false; check(`reset is pixel-identical for ${id}`, false) }
  }
  check('per-frame reset is pixel-identical for every effect', identical)

  // Precondition: the library still retains snapshots without a reset. If a
  // future version fixes it, this flips and says the workaround can go.
  const S = 1500
  const src = createCanvas(S, S), sctx = src.getContext('2d')
  const measure = reset => {
    const dst = createCanvas(200, 200), d = dst.getContext('2d')
    const before = process.memoryUsage().rss
    for (let f = 0; f < 20; f++) {
      if (reset) d.reset()
      sctx.fillStyle = `hsl(${f * 17},50%,50%)`; sctx.fillRect(0, 0, S, S)
      d.drawImage(src, 0, 0, 100, 100, 0, 0, 200, 200)
    }
    return (process.memoryUsage().rss - before) / 1e6
  }
  const leaked = measure(false)
  const contained = measure(true)
  check('precondition: @napi-rs/canvas retains a snapshot per draw without reset', leaked > 100, `${leaked.toFixed(0)} MB over 20 frames`)
  check('reset() releases the retained snapshots', contained < 60, `${contained.toFixed(0)} MB over 20 frames`)
}

// ── End-to-end: real worker threads + ffmpeg ─────────────────────────────────
function probe(buf) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-i', 'pipe:0', '-f', 'null', '-'], { stdio: ['pipe', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', d => { err += d })
    p.stdin.on('error', () => {})
    p.on('error', reject)
    p.on('close', () => resolve(err))
    p.stdin.end(buf)
  })
}
{
  const art = createCanvas(700, 700)
  const a = art.getContext('2d')
  for (let i = 0; i < 120; i++) { a.fillStyle = `hsl(${i * 11},70%,50%)`; a.fillRect((i * 83) % 700, (i * 47) % 700, 80, 80) }
  const png = art.toBuffer('image/png')

  const t0 = Date.now()
  const square = await renderFreeVisualizer(png, { format: 'square', effect: 'glitch', bpm: 128, seed: 1 })
  const info = await probe(square)
  const frames = Number((info.match(/frame=\s*(\d+)/g) ?? []).pop()?.replace(/\D/g, '') ?? 0)
  check('square/glitch renders a 1080x1080 H.264 loop', /h264/.test(info) && /1080x1080/.test(info), `${square.length} bytes in ${Date.now() - t0} ms`)
  check('sliced render concatenates to exactly 180 frames (6s @ 30fps)', frames === 180, `${frames} frames`)
  check('output is silent', !/Audio:/.test(info))

  // Drone Shot is the effect that OOM'd; a 6s 9:16 render must stay bounded.
  const rss0 = process.memoryUsage().rss
  let peak = rss0
  const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss) }, 100)
  const drone = await renderFreeVisualizer(png, { format: 'canvas', effect: 'drone', seed: 2 })
  clearInterval(timer)
  const dinfo = await probe(drone)
  check('canvas/drone renders a 1080x1920 loop', /1080x1920/.test(dinfo), `${drone.length} bytes`)
  check('Drone render memory stays bounded (snapshot leak contained)', (peak - rss0) / 1e6 < 1500,
    `${((peak - rss0) / 1e6).toFixed(0)} MB peak growth`)

  let rejected = false
  try { await renderFreeVisualizer(Buffer.from('not an image'), { format: 'square', effect: 'orbit' }) } catch { rejected = true }
  check('a non-image fails the render instead of hanging', rejected)
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall free-render checks passed')
process.exit(failures ? 1 : 0)
