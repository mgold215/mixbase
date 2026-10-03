#!/usr/bin/env node
// Contract test for the Cassette Studio moving cover — a no-AI animated loop
// of a cover, built from the layers every render keeps:
//   src/lib/cassette-motion.ts        findHubs + prepareMotionAssets (sharp)
//   src/lib/cassette-motion-scene.ts  the per-frame scene (sharp-free)
//   src/lib/cassette-render.ts        sliced worker render → MP4
//   src/lib/cassette-render-worker.ts one slice: Skia canvas → ffmpeg
//
// Drives the REAL modules under Node type stripping on @napi-rs/canvas + the
// app's ffmpeg. What can silently break a moving cover:
//  - hub detection: two clear holes → both spin; one clear + one cloudy →
//    the clear one is mirrored; none → NOTHING spins and the cassette is drawn
//    exactly as photographed (no hole cut where the hubs "should" be);
//  - the loop seam (frame `total` must be frame 0; the wrap no bigger a step
//    than any other);
//  - per-frame determinism — frame K must render identically standalone or
//    after other frames, or the worker slices won't join seamlessly;
//  - @napi-rs/canvas retaining a snapshot of every canvas drawn into a context
//    until reset: the near-plane layer is redrawn every frame after being
//    drawn into the frame, so the worker must reset its frame context before
//    every frame (~330 MB per 40 portrait frames otherwise — measured below).
//    The scene also resets the near-plane context itself each frame; that one
//    is hygiene (it only ever receives the immutable pre-scaled plate, whose
//    snapshot is shared), so there is no memory witness for it;
//  - framing: the cassette and the title must stay inside every format.
//
// Fail-first witnesses (each RUN and confirmed to fail when the guard is removed):
//  - the worker's ctx.reset() → the worker source check fails, and the
//    precondition shows what it costs
//  - prepareMotionAssets cutting/spinning on detected=false → the
//    static-cassette checks fail
//
// Run: node scripts/cassette-motion-test.mjs  (also part of `npm test`)

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import sharp from 'sharp'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import {
  findHubs, prepareMotionAssets, createCassetteMotion, motionCrop, letteringRect,
} from '../src/lib/cassette-motion.ts'
import { renderCassetteMotion } from '../src/lib/cassette-render.ts'
import { FREE_FORMATS, FREE_FPS } from '../src/lib/free-render.ts'
import { COVER, placeSubject, tintLettering } from '../src/lib/cassette-studio.ts'

const require = createRequire(import.meta.url)
const FFMPEG = require('@ffmpeg-installer/ffmpeg').path

let failures = 0
function check(name, ok, detail = '') {
  if (ok) console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
  else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures++ }
}

// ── Synthetic cassette layers ───────────────────────────────────────────────
// An opaque shell (trimmed to the shell, like a real cut-out) with an
// asymmetric colour pattern — so any rotation of any part of it changes
// pixels — and hub holes of a chosen opacity.
function makeLayer(w, h, holes = []) {
  const buf = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      buf[o] = (x * 7 + y) % 256
      buf[o + 1] = (y * 5) % 256
      buf[o + 2] = ((x >> 3) * 40 + (y >> 4) * 17) % 256
      buf[o + 3] = 255
      for (const hl of holes) {
        if ((x + 0.5 - hl.cx) ** 2 + (y + 0.5 - hl.cy) ** 2 < hl.r ** 2) buf[o + 3] = hl.alpha
      }
    }
  }
  return buf
}
const png = (raw, w, h) => sharp(raw, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer()
const holesAt = (w, h, alphaL, alphaR) => [
  { cx: w * 0.288, cy: h * 0.44, r: w * 0.045, alpha: alphaL },
  { cx: w * 0.712, cy: h * 0.44, r: w * 0.045, alpha: alphaR },
]

// ── findHubs ────────────────────────────────────────────────────────────────
console.log('findHubs')
const LW = 600, LH = 380
const near = (a, b, tol) => Math.abs(a - b) <= tol
{
  const both = findHubs(makeLayer(LW, LH, holesAt(LW, LH, 0, 0)), LW, LH)
  check('two clear hub discs → detected', both.detected === true && both.hubs.length === 2)
  check('…at the holes, left then right',
    near(both.hubs[0].cx, LW * 0.288, 1.5) && near(both.hubs[1].cx, LW * 0.712, 1.5) &&
    near(both.hubs[0].cy, LH * 0.44, 1.5) && near(both.hubs[1].cy, LH * 0.44, 1.5),
    both.hubs.map(h => `${h.cx.toFixed(1)},${h.cy.toFixed(1)}`).join(' '))
  check('…with the holes\' radius', both.hubs.every(h => near(h.r, LW * 0.045, 2)), both.hubs.map(h => h.r).join(','))

  const one = findHubs(makeLayer(LW, LH, holesAt(LW, LH, 128, 0)), LW, LH)
  check('one clear + one semi-opaque → still detected', one.detected === true && one.hubs.length === 2)
  check('…the clear hole is found where it is', near(one.hubs[1].cx, LW * 0.712, 1.5))
  check('…and mirrored about the shell\'s centre line', near(one.hubs[0].cx, LW - one.hubs[1].cx, 1e-6) && one.hubs[0].cy === one.hubs[1].cy)

  const none = findHubs(makeLayer(LW, LH), LW, LH)
  check('no see-through holes → detected=false', none.detected === false)
}

// ── prepareMotionAssets ─────────────────────────────────────────────────────
console.log('\nprepareMotionAssets')
const holedRaw = makeLayer(LW, LH, holesAt(LW, LH, 0, 0))
const assetsYes = await prepareMotionAssets(holedRaw, LW, LH)
{
  const sm = await sharp(assetsYes.staticPng).metadata()
  const hm = await sharp(assetsYes.hubSpritePng).metadata()
  const r = Math.max(...findHubs(holedRaw, LW, LH).hubs.map(h => h.r))
  const R = Math.ceil(r * 1.36)
  check('static layer is the layer\'s size', sm.width === LW && sm.height === LH && sm.channels === 4)
  check('hub sprite is 2R×2R (R = 1.36 × hole radius)', hm.width === 2 * R && hm.height === 2 * R && assetsYes.spriteR === R, `${hm.width}x${hm.height}, R=${assetsYes.spriteR}`)
  check('two hubs to spin', assetsYes.detected === true && assetsYes.hubs.length === 2)
  const st = await sharp(assetsYes.staticPng).raw().toBuffer()
  const at = (x, y) => st[(y * LW + Math.round(x)) * 4 + 3]
  const hb = assetsYes.hubs[0]
  check('the hub disc is cut out of the static layer (just past the hole)', at(hb.cx + r * 1.05, Math.round(hb.cy)) === 0)
  check('the shell beyond the sprite is untouched', at(hb.cx + r * 2, Math.round(hb.cy)) === 255 && Buffer.compare(st.subarray(0, LW * 4), holedRaw.subarray(0, LW * 4)) === 0)
}
const plainRaw = makeLayer(LW, LH)
const assetsNo = await prepareMotionAssets(plainRaw, LW, LH)
{
  const st = await sharp(assetsNo.staticPng).raw().toBuffer()
  check('detected=false → nothing spins (no hubs, no sprite radius)', assetsNo.detected === false && assetsNo.hubs.length === 0 && assetsNo.spriteR === 0)
  check('detected=false → the static layer IS the layer (no hole cut)', Buffer.compare(st, plainRaw) === 0)
  const hm = await sharp(assetsNo.hubSpritePng).metadata()
  check('detected=false → a 1×1 placeholder sprite (still decodable by a worker)', hm.width === 1 && hm.height === 1)
}

// ── The scene ───────────────────────────────────────────────────────────────
console.log('\nscene: seam, determinism, reset, static cassette')
const layerFactory = (w, h) => { const c = createCanvas(w, h); return { canvas: c, ctx: c.getContext('2d') } }
async function plateImage(size) {
  const c = createCanvas(size, size)
  const g = c.getContext('2d')
  const grad = g.createLinearGradient(0, 0, size, size)
  grad.addColorStop(0, '#203040'); grad.addColorStop(1, '#c08050')
  g.fillStyle = grad; g.fillRect(0, 0, size, size)
  for (let i = 0; i < 60; i++) { g.fillStyle = `hsl(${i * 23},60%,${30 + (i % 5) * 8}%)`; g.fillRect((i * 97) % size, (i * 61) % size, size / 12, size / 18) }
  return loadImage(await sharp(c.toBuffer('image/png')).jpeg({ quality: 90 }).toBuffer())
}
const SC = 600                                     // small cover for fast frame checks
const sbox = { left: 180, top: 210, width: 240, height: 152 }
const plate = await plateImage(SC)
async function sceneAssets(raw) {
  const small = await sharp(raw, { raw: { width: LW, height: LH, channels: 4 } }).resize(sbox.width, sbox.height, { fit: 'fill' }).raw().toBuffer()
  return prepareMotionAssets(small, sbox.width, sbox.height)
}
const sYes = await sceneAssets(holedRaw)
const sNo = await sceneAssets(plainRaw)
async function scene(a, { W = 240, H = 240, grain = false, override = {} } = {}) {
  const [staticLayer, hubSprite] = await Promise.all([loadImage(a.staticPng), loadImage(a.hubSpritePng)])
  const draw = createCassetteMotion({
    W, H, duration: 6, fps: 30, seed: 7, cover: SC, plate, staticLayer, hubSprite, box: sbox,
    hubs: a.hubs, spriteR: a.spriteR, layerScale: staticLayer.width / sbox.width, lettering: null,
    createLayer: layerFactory, grain, ...override,
  })
  const c = createCanvas(W, H)
  const ctx = c.getContext('2d')
  return {
    frame(f, reset = true) {
      if (reset) ctx.reset()
      draw(ctx, f)
      return Buffer.from(ctx.getImageData(0, 0, W, H).data)
    },
  }
}
const meanDiff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length }
const same = (a, b) => a.length === b.length && Buffer.compare(a, b) === 0
const TOTAL = 6 * 30
check('detected cassette for the scene checks', sYes.detected === true && sNo.detected === false)
{
  const s = await scene(sYes)
  const f0 = s.frame(0), f1 = s.frame(1), last = s.frame(TOTAL - 1), wrap = s.frame(TOTAL), mid = s.frame(45)
  check('seam: frame TOTAL is frame 0 (grain off)', same(f0, wrap))
  const step = meanDiff(f0, f1), seam = meanDiff(last, f0)
  check('seam: the wrap is no bigger a step than any other', seam > 0 && seam < step * 2.5 + 0.05, `wrap ${seam.toFixed(3)} vs step ${step.toFixed(3)}`)
  check('it actually moves', meanDiff(f0, mid) > step * 3, `${meanDiff(f0, mid).toFixed(2)}`)
}
for (const grain of [false, true]) {
  const a = await scene(sYes, { grain })
  const b = await scene(sYes, { grain })
  const alone = a.frame(77)
  for (let f = 0; f < 12; f++) b.frame(f)
  check(`frame K standalone = frame K after other frames (grain ${grain ? 'on' : 'off'})`, same(alone, b.frame(77)))
  b.frame(150)
  check(`…and again after a later frame (grain ${grain ? 'on' : 'off'})`, same(alone, b.frame(77)))
}
{
  const a = await scene(sYes, { grain: true })
  const b = await scene(sYes, { grain: true })
  for (let f = 0; f < 6; f++) { a.frame(f, false); b.frame(f, true) }
  check('the scene paints the whole frame (a per-frame ctx.reset() is pixel-identical)', same(a.frame(6, false), b.frame(6, true)))
  const g0 = a.frame(30), g1 = (await scene(sYes, { grain: false })).frame(30)
  check('grain on differs from grain off (the knob does something)', !same(g0, g1))
}
{
  // detected=false: the cassette is drawn exactly as photographed. Reference:
  // the ORIGINAL layer as a plain image with nothing to spin.
  const small = await sharp(plainRaw, { raw: { width: LW, height: LH, channels: 4 } }).resize(sbox.width, sbox.height, { fit: 'fill' }).raw().toBuffer()
  const ref = { staticPng: await png(small, sbox.width, sbox.height), hubSpritePng: sNo.hubSpritePng, hubs: [], spriteR: 0 }
  const s = await scene(sNo)
  const r = await scene(ref)
  let identical = true
  for (const f of [0, 22, 45, 90, 179]) if (!same(s.frame(f), r.frame(f))) identical = false
  check('detected=false → the hub region never changes relative to the still cassette (no hole, no spin)', identical)
  // Witness: the same comparison catches a spin over the fallback geometry.
  const fallback = findHubs(small, sbox.width, sbox.height).hubs
  const spun = await scene(sNo, { override: { hubs: fallback, spriteR: 14, hubSprite: await loadImage(ref.staticPng) } })
  check('witness: a sprite spun over the fallback hubs IS caught', !same(spun.frame(22), r.frame(22)))
}
{
  // Snapshot leak: the scene redraws its near-plane layer every frame AFTER
  // having drawn it into the frame, so without a per-frame reset of the frame
  // context every frame's near-plane pixels stay retained (copy-on-write). The
  // worker resets per frame; this proves the reset is still needed here (so a
  // library fix shows up) and that it bounds a render. Real sizes (3000²
  // cover → 1080×1920).
  const big = await plateImage(COVER)
  const bigBox = placeSubject(LW, LH, 3)
  const bigLayer = await sharp(holedRaw, { raw: { width: LW, height: LH, channels: 4 } }).resize(bigBox.width, bigBox.height, { fit: 'fill' }).raw().toBuffer()
  const a = await prepareMotionAssets(bigLayer, bigBox.width, bigBox.height)
  const [staticLayer, hubSprite] = await Promise.all([loadImage(a.staticPng), loadImage(a.hubSpritePng)])
  const W = 1080, H = 1920
  const measure = async reset => {
    const draw = createCassetteMotion({
      W, H, duration: 6, fps: 30, seed: 1, cover: COVER, plate: big, staticLayer, hubSprite, box: bigBox,
      hubs: a.hubs, spriteR: a.spriteR, layerScale: 1, lettering: null, createLayer: layerFactory,
    })
    const c = createCanvas(W, H), ctx = c.getContext('2d')
    ctx.reset(); draw(ctx, 0)
    const rss0 = process.memoryUsage().rss
    for (let f = 1; f <= 40; f++) {
      if (reset) ctx.reset()
      draw(ctx, f)
      await new Promise(r => setImmediate(r))
    }
    return (process.memoryUsage().rss - rss0) / 1e6
  }
  const leaked = await measure(false)
  const contained = await measure(true)
  check('precondition: without a per-frame reset the near-plane snapshots pile up', leaked > 150, `${leaked.toFixed(0)} MB over 40 frames`)
  check('with the worker\'s per-frame reset, 40 portrait frames stay bounded', contained < 100, `${contained.toFixed(0)} MB over 40 frames`)
  // …and the worker really does it, before every frame, with the GLOBAL frame
  // index (draw(ctx, t) would collapse every slice onto the same frames).
  const worker = readFileSync(new URL('../src/lib/cassette-render-worker.ts', import.meta.url), 'utf8')
  const loop = worker.slice(worker.indexOf('for (let f = job.start; f < job.end; f++)'))
  check('worker: ctx.reset() then draw(dc, f) inside the frame loop',
    loop.length > 0 && /ctx\.reset\(\)\s*\n\s*draw\(dc, f\)/.test(loop.replace(/^\s*\/\/.*$/gm, '').replace(/\n\s*\n/g, '\n')))
  check('worker: the Worker is spawned by the literal new URL(\'./cassette-render-worker.ts\', import.meta.url)',
    readFileSync(new URL('../src/lib/cassette-render.ts', import.meta.url), 'utf8')
      .includes("new Worker(new URL('./cassette-render-worker.ts', import.meta.url), { workerData: slice })"))
  check('worker: never loads sharp (only the sharp-free scene module)',
    !/from ['"]sharp['"]|cassette-motion\.ts|cassette-studio\.ts/.test(worker) &&
    !/from ['"]sharp['"]|from ['"]\.\/cassette-(motion|studio)\.ts['"]/.test(readFileSync(new URL('../src/lib/cassette-motion-scene.ts', import.meta.url), 'utf8')))
}

// ── Framing ─────────────────────────────────────────────────────────────────
console.log('\nframing')
{
  let inside = true, margin = true, aspect = true, worst = 1
  const shapes = [[LW, LH], [380, 600], [500, 500]]       // face-on cassette, stood on end, square case
  for (const [id, f] of Object.entries(FREE_FORMATS)) {
    for (const [sw, sh] of shapes) {
      for (let seed = 0; seed < 200; seed++) {
        const box = placeSubject(sw, sh, seed)
        const cr = motionCrop(COVER, box, f.width, f.height)
        if (Math.abs(cr.w / cr.h - f.width / f.height) > 1e-9) aspect = false
        const ok = cr.x >= 0 && cr.y >= 0 && cr.x + cr.w <= COVER + 1e-9 && cr.y + cr.h <= COVER + 1e-9 &&
          box.left >= cr.x && box.top >= cr.y && box.left + box.width <= cr.x + cr.w + 1e-9 && box.top + box.height <= cr.y + cr.h + 1e-9
        if (!ok) { inside = false; console.error(`    ${id} ${sw}x${sh} seed ${seed}: box ${JSON.stringify(box)} crop ${JSON.stringify(cr)}`) }
        // The breathing zoom tops out at ~1.078 (≈3.6% per side); the cassette
        // must survive it on the cropped axis.
        const m = Math.min((box.left - cr.x) / cr.w, (cr.x + cr.w - box.left - box.width) / cr.w,
          (box.top - cr.y) / cr.h, (cr.y + cr.h - box.top - box.height) / cr.h)
        worst = Math.min(worst, m)
        if (m < 0.04) margin = false
      }
    }
  }
  check('motionCrop: the crop has the format\'s aspect', aspect)
  check('motionCrop: the cassette is inside the frame for all four formats', inside)
  check('motionCrop: …with room for the breathing zoom (≥4% each side)', margin, `worst ${(worst * 100).toFixed(1)}%`)
}
{
  let ok = true
  for (const f of Object.values(FREE_FORMATS)) {
    for (const pos of ['bottom-left', 'bottom-center', 'bottom-right', 'top-left', 'top-center', 'top-right']) {
      for (const size of ['small', 'medium', 'large']) {
        for (const [lw, lh] of [[600, 160], [1200, 140], [300, 600], [800, 800], [2400, 120], [90, 900]]) {
          const r = letteringRect(f.width, f.height, lw, lh, pos, size)
          const good = r.w > 0 && r.h > 0 && r.x >= 0 && r.y >= 0 && r.x + r.w <= f.width + 1e-9 && r.y + r.h <= f.height + 1e-9 &&
            Math.abs(r.w / r.h - lw / lh) < 1e-6
          if (!good) { ok = false; console.error(`    ${f.width}x${f.height} ${pos}/${size} ${lw}x${lh}: ${JSON.stringify(r)}`) }
        }
      }
    }
  }
  check('letteringRect stays inside the frame (every format × position × size × shape) at the lettering\'s aspect', ok)
}

// ── End-to-end: real worker threads + ffmpeg ─────────────────────────────────
console.log('\nend-to-end render')
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
  const box = placeSubject(LW, LH, 11)
  const layer = await sharp(holedRaw, { raw: { width: LW, height: LH, channels: 4 } }).resize(box.width, box.height, { fit: 'fill' }).raw().toBuffer()
  const assets = await prepareMotionAssets(layer, box.width, box.height)
  const pc = createCanvas(COVER, COVER), pg = pc.getContext('2d')
  const grad = pg.createLinearGradient(0, 0, 0, COVER)
  grad.addColorStop(0, '#1c2a3a'); grad.addColorStop(0.7, '#6a5040'); grad.addColorStop(1, '#2a1a10')
  pg.fillStyle = grad; pg.fillRect(0, 0, COVER, COVER)
  const plateJpeg = await sharp(pc.toBuffer('image/png')).jpeg({ quality: 90 }).toBuffer()
  const word = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="160"><path d="M20 120 L120 30 L220 120 L320 30 L420 120 L520 30" stroke="#fff" stroke-width="26" fill="none"/></svg>')).png().toBuffer()
  const title = { png: await tintLettering(word, '#e03a3e'), position: 'bottom-left', size: 'medium' }

  const t0 = Date.now()
  const mp4 = await renderCassetteMotion({ plateJpeg, assets, box, title, format: 'square', seed: 5 })
  const info = await probe(mp4)
  const frames = Number((info.match(/frame=\s*(\d+)/g) ?? []).pop()?.replace(/\D/g, '') ?? 0)
  const want = FREE_FORMATS.square.duration * FREE_FPS
  check('square renders a 1080x1080 H.264 MP4', /h264/.test(info) && /1080x1080/.test(info), `${mp4.length} bytes in ${Date.now() - t0} ms`)
  check(`sliced render concatenates to exactly ${want} frames (6s @ 30fps)`, frames === want, `${frames} frames`)
  check('output is silent', !/Audio:/.test(info))

  let rejected = false
  try { await renderCassetteMotion({ plateJpeg: Buffer.from('not an image'), assets, box, title: null, format: 'square' }) } catch { rejected = true }
  check('a broken plate fails the render instead of hanging', rejected)
}

console.log(failures ? `\n✗ ${failures} cassette-motion check(s) failed` : '\n✓ cassette-motion: all checks passed')
process.exit(failures ? 1 : 0)
