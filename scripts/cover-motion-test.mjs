#!/usr/bin/env node
// Contract test for the DESIGNED moving cover: a model plans how a finished
// cover moves, and the server draws that plan over the real cover pixels.
//   src/lib/cover-motion.ts         the plan: shape, strict reader, geometry
//   src/lib/cover-motion-scene.ts   the per-frame scene (sharp-free)
//   src/lib/cover-motion-render.ts  sliced worker render → MP4
//   src/lib/cover-motion-worker.ts  one slice: Skia canvas → ffmpeg
//   src/lib/cover-motion-direct.ts  the model call that writes the plan
//
// Drives the REAL modules under Node type stripping on @napi-rs/canvas + the
// app's ffmpeg. What can silently break a designed loop:
//  - a plan is model output: anything out of range, half-filled or too long
//    must be clamped or dropped before it reaches the canvas;
//  - a plan is written against the SQUARE cover but drawn in 9:16 and 16:9,
//    where the cover is only the middle of the frame;
//  - the loop seam (frame `total` must be frame 0, and the step across the
//    wrap no bigger than any other step);
//  - per-frame determinism, or worker slices will not join;
//  - the camera showing past the picture's edge;
//  - @napi-rs/canvas keeping a snapshot of every canvas drawn into a context
//    until reset: the worker must reset its frame context every frame.
//
// Run: node scripts/cover-motion-test.mjs  (also part of `npm test`)

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import sharp from 'sharp'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import {
  CAMERA_MOVES, ELEMENT_KINDS, GLOW_PACES, MAX_ELEMENTS, PARTICLE_LOOKS, SHIMMER_LOOKS,
  areaToFrame, coverSquare, hexColor, parseMotionRecipe, pointToFrame, templateRecipe,
} from '../src/lib/cover-motion.ts'
import { cameraAt, createCoverMotion } from '../src/lib/cover-motion-scene.ts'
import { renderCoverMotion } from '../src/lib/cover-motion-render.ts'
import { HUB_SYMMETRY, MOTION_MODELS, MOTION_SCHEMA, MOTION_SYSTEM, refineSpins, writeMotionRecipe } from '../src/lib/cover-motion-direct.ts'

const require = createRequire(import.meta.url)
const FFMPEG = require('@ffmpeg-installer/ffmpeg').path

let failures = 0
function check(name, ok, detail = '') {
  if (ok) console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
  else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures++ }
}

// The flat shape the model is asked for: every field present, unused ones empty.
const whole = { x: 0, y: 0, w: 1, h: 1 }
const wire = (kind, o = {}) => ({ kind, look: 'none', area: whole, at: { x: 0.5, y: 0.5 }, path: [], color: '#000000', amount: 0.4, angle: 0, radius: 0, laps: 0, ...o })
const line = [{ x: 0.1, y: 0.6 }, { x: 0.4, y: 0.3 }, { x: 0.9, y: 0.6 }]
const FULL = {
  summary: '  Sand blows   across. ',
  camera: { move: 'push', amount: 0.5 },
  grain: 0.4,
  elements: [
    wire('particles', { look: 'sand', color: '#FBE7BD', angle: 368 }),
    wire('glow', { look: 'pulse', at: { x: 0.9, y: 0.88 }, radius: 0.04, color: '#f31' }),
    wire('shimmer', { look: 'water', area: { x: 0.1, y: 0.5, w: 0.5, h: 0.3 } }),
    wire('sweep', { area: { x: 0.3, y: 0.2, w: 0.3, h: 0.2 }, color: '#fff3d8', angle: 20 }),
    wire('trace', { path: line, color: '#d2ffb8', laps: 2 }),
  ],
}

// ── The reader ──────────────────────────────────────────────────────────────
console.log('parseMotionRecipe')
{
  const r = parseMotionRecipe(FULL)
  check('a full plan in the model\'s flat shape reads whole', r !== null && r.elements.length === 5, r?.elements.map(e => e.kind).join(','))
  check('the summary is tidied', r.summary === 'Sand blows across.')
  check('an angle is brought into 0–360', r.elements[0].angle === 8)
  check('colours are normalised (#RGB, upper case)', r.elements[0].color === '#fbe7bd' && r.elements[1].color === '#ff3311')
  check('a glow\'s pace comes from the flat "look" field', r.elements[1].pace === 'pulse')
  check('a trace keeps its path and laps', r.elements[4].path.length === 3 && r.elements[4].laps === 2)
  check('an element carries only its own fields', !('path' in r.elements[0]) && !('area' in r.elements[1]))

  check('not a plan → null', parseMotionRecipe(null) === null && parseMotionRecipe({}) === null && parseMotionRecipe({ camera: { move: 'float' } }) === null)
  check('an unknown camera move → null', parseMotionRecipe({ ...FULL, camera: { move: 'orbit', amount: 1 } }) === null)
  const wild = parseMotionRecipe({
    summary: 'x'.repeat(900), camera: { move: 'float', amount: 9 }, grain: -3,
    elements: [
      wire('particles', { look: 'confetti' }),                       // not a look
      wire('glow', { at: { x: 4, y: -2 }, radius: 50, amount: 7 }),   // out of range
      wire('shimmer', { area: { x: 0.5, y: 0.5, w: 0.01, h: 0.4 } }), // too thin to draw
      wire('trace', { path: [{ x: 0.2, y: 0.2 }] }),                  // one point is not a line
      wire('mist', { amount: 0 }),                                    // nothing to draw
      wire('lasers'),                                                 // not a kind
      wire('sweep', { area: { x: 0.8, y: 0.8, w: 0.9, h: 0.9 }, color: 'red' }),
      'nonsense', null,
    ],
  })
  check('numbers are clamped', wild.camera.amount === 1 && wild.grain === 0 && wild.summary.length === 200)
  check('broken elements are dropped, sound ones kept', wild.elements.length === 2 && wild.elements[0].kind === 'glow' && wild.elements[1].kind === 'sweep', wild.elements.map(e => e.kind).join(','))
  const g = wild.elements[0], sw = wild.elements[1]
  check('a glow is kept inside the cover and within reach', g.at.x === 1 && g.at.y === 0 && g.radius === 0.6 && g.amount === 1)
  check('an area is cut to the cover', Math.abs(sw.area.x + sw.area.w - 1) < 1e-9 && Math.abs(sw.area.y + sw.area.h - 1) < 1e-9)
  check('a colour that is not hex falls back', sw.color === '#ffffff' && hexColor('#12345') === '#fff4e0')
  const many = parseMotionRecipe({ ...FULL, elements: Array.from({ length: 12 }, () => wire('particles', { look: 'dust' })) })
  check(`at most ${MAX_ELEMENTS} elements`, many.elements.length === MAX_ELEMENTS)
  const long = parseMotionRecipe({ ...FULL, elements: [wire('trace', { path: Array.from({ length: 40 }, (_, i) => ({ x: i / 40, y: 0.5 })) })] })
  check('a path is capped at 16 points', long.elements[0].path.length === 16)
  check('the plain plan reads back as itself', JSON.stringify(parseMotionRecipe(templateRecipe())) === JSON.stringify(templateRecipe()))
  check('a plan with no usable element is still a plan', parseMotionRecipe({ ...FULL, elements: [] })?.elements.length === 0)
  check('the plain plan adds nothing blind: a camera and grain only', templateRecipe().elements.length === 0 && templateRecipe().camera.move === 'push')
  const reel = parseMotionRecipe({ ...FULL, elements: [wire('spin', { at: { x: 0.4, y: 0.3 }, radius: 0.03, laps: 2, amount: 0 })] }).elements[0]
  check('a reel is kept though it has no amount, and carries no shape until one is found', reel?.kind === 'spin' && reel.laps === 2 && !('squash' in reel) && !('tilt' in reel))
  const kept = parseMotionRecipe({ ...FULL, elements: [{ kind: 'spin', at: { x: 0.4, y: 0.3 }, radius: 0.03, laps: 2, squash: 0.2, tilt: 200 }] }).elements[0]
  check('a stored reel keeps its found shape, in range', kept.squash === 0.4 && kept.tilt === 20)
}

// ── Square cover → frame ────────────────────────────────────────────────────
console.log('\ngeometry')
{
  const sq = coverSquare(1080, 1920)
  check('portrait: the cover is the middle 1080 square', sq.left === 0 && sq.top === 420 && sq.size === 1080)
  const sl = coverSquare(1920, 1080)
  check('landscape: the cover is the middle 1080 square', sl.left === 420 && sl.top === 0 && sl.size === 1080)
  const p = pointToFrame({ x: 0.5, y: 0.25 }, 1080, 1920)
  check('a cover point lands inside the cover\'s square', p.x === 540 && p.y === 420 + 270)
  const all = areaToFrame(whole, 1080, 1920)
  check('"the whole cover" means the whole frame', all.x === 0 && all.y === 0 && all.w === 1080 && all.h === 1920)
  const low = areaToFrame({ x: 0, y: 0.6, w: 1, h: 0.4 }, 1080, 1920)
  check('an area reaching the bottom edge runs to the frame\'s bottom', low.y === 420 + 648 && low.y + low.h === 1920 && low.w === 1080)
  const mid = areaToFrame({ x: 0.3, y: 0.2, w: 0.3, h: 0.2 }, 1920, 1080)
  check('an area inside the cover stays inside it', Math.abs(mid.x - (420 + 324)) < 1e-6 && Math.abs(mid.w - 324) < 1e-6 && Math.abs(mid.y - 216) < 1e-6)
}

// ── Camera ──────────────────────────────────────────────────────────────────
console.log('\ncamera')
{
  let worst = Infinity, seam = 0
  for (const move of CAMERA_MOVES) for (const amount of [0, 0.3, 0.6, 1]) for (const [W, H] of [[1080, 1920], [1920, 1080], [1080, 1080]]) {
    for (let i = 0; i < 240; i++) {
      const c = cameraAt(move, amount, i / 240, W, H)
      worst = Math.min(worst, (c.z - 1) / 2 * W - Math.abs(c.dx), (c.z - 1) / 2 * H - Math.abs(c.dy))
    }
    const a = cameraAt(move, amount, 0, W, H), b = cameraAt(move, amount, 1, W, H)
    seam = Math.max(seam, Math.abs(a.z - b.z), Math.abs(a.dx - b.dx), Math.abs(a.dy - b.dy))
  }
  check('the picture always covers the frame (every move, amount and shape)', worst >= 0, `tightest margin ${worst.toFixed(2)} px`)
  check('every move ends where it began', seam < 1e-6)
}

// ── The scene ───────────────────────────────────────────────────────────────
console.log('\nscene')
const W = 270, H = 480, TOTAL = 48
// A still with detail everywhere, so any displacement of it changes pixels.
const stillRaw = Buffer.alloc(W * 2 * H * 2 * 3)
for (let y = 0; y < H * 2; y++) for (let x = 0; x < W * 2; x++) {
  const o = (y * W * 2 + x) * 3
  stillRaw[o] = 40 + ((x * 3 + y) % 120); stillRaw[o + 1] = 40 + ((y * 2) % 110); stillRaw[o + 2] = 50 + (((x >> 3) * 31 + (y >> 3) * 17) % 100)
}
const stillJpeg = await sharp(stillRaw, { raw: { width: W * 2, height: H * 2, channels: 3 } }).jpeg({ quality: 92 }).toBuffer()
const still = await loadImage(stillJpeg)
const createLayer = (w, h) => { const c = createCanvas(w, h); return { canvas: c, ctx: c.getContext('2d') } }
const sceneOf = (recipe, grain = false) => createCoverMotion({ W, H, total: TOTAL, seed: 11, still, recipe, createLayer, grain })
function frameOf(draw, f, canvas = createCanvas(W, H)) {
  const ctx = canvas.getContext('2d')
  ctx.reset()
  draw(ctx, f)
  return Buffer.from(ctx.getImageData(0, 0, W, H).data)
}
const diff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i += 4) s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); return s / (a.length / 4) }
const plan = parseMotionRecipe({ ...FULL, elements: [...FULL.elements.slice(0, 4), wire('mist', { area: { x: 0, y: 0.5, w: 1, h: 0.4 }, color: '#d9b79a', amount: 0.6 })] })
const planB = parseMotionRecipe({ ...FULL, elements: [wire('trace', { path: line, color: '#d2ffb8', laps: 2, amount: 0.9 }), wire('particles', { look: 'embers', color: '#ffb060', angle: 270 }), wire('particles', { look: 'rain', color: '#cfd8e0', angle: 80 }), wire('particles', { look: 'bubbles', color: '#e8f4ff', angle: 270 }), wire('particles', { look: 'snow', color: '#ffffff', angle: 95 })] })
{
  const draw = sceneOf(plan)
  const f0 = frameOf(draw, 0)
  check('frame `total` is frame 0 exactly', Buffer.compare(frameOf(draw, TOTAL), f0) === 0)
  check('…and so is frame -total', Buffer.compare(frameOf(draw, -TOTAL), f0) === 0)
  check('the frame is fully painted', (() => { for (let i = 3; i < f0.length; i += 4) if (f0[i] !== 255) return false; return true })())

  // Determinism: frame K alone = frame K after others, on one reused canvas.
  const shared = createCanvas(W, H)
  for (const f of [3, 20, 7]) frameOf(draw, f, shared)
  check('frame K is the same picture whatever was drawn before it', Buffer.compare(frameOf(draw, 13, shared), frameOf(sceneOf(plan), 13)) === 0)

  // The wrap is a step like any other.
  for (const [name, p] of [['plan A', plan], ['plan B', planB]]) {
    const d = sceneOf(p)
    const frames = Array.from({ length: TOTAL }, (_, f) => frameOf(d, f))
    const steps = frames.map((fr, i) => diff(fr, frames[(i + 1) % TOTAL]))
    const wrap = steps[TOTAL - 1], inner = steps.slice(0, TOTAL - 1)
    const max = Math.max(...inner)
    check(`${name}: the step across the seam is no bigger than the steps inside the loop`, wrap <= max * 1.05, `seam ${wrap.toFixed(2)}, largest inside ${max.toFixed(2)}`)
    check(`${name}: it moves on every frame`, Math.min(...steps) > 0)
  }

  // Each kind of element draws something: with it, some frame differs from the same frame without it.
  const bare = parseMotionRecipe({ ...FULL, elements: [] })
  const bareFrames = Array.from({ length: TOTAL }, (_, f) => frameOf(sceneOf(bare), f))
  const every = [
    ...PARTICLE_LOOKS.map(look => wire('particles', { look, color: '#ffffff', amount: 0.8, angle: 30 })),
    ...GLOW_PACES.map(look => wire('glow', { look, at: { x: 0.5, y: 0.5 }, radius: 0.3, color: '#ff8a2a', amount: 0.8 })),
    ...SHIMMER_LOOKS.map(look => wire('shimmer', { look, area: { x: 0.2, y: 0.2, w: 0.6, h: 0.6 }, amount: 0.9 })),
    wire('sweep', { area: { x: 0.2, y: 0.3, w: 0.6, h: 0.4 }, color: '#ffffff', amount: 0.9, angle: 20 }),
    wire('mist', { area: whole, color: '#e8e4dc', amount: 0.9 }),
    wire('trace', { path: line, color: '#d2ffb8', amount: 0.9, laps: 1 }),
    wire('spin', { at: { x: 0.5, y: 0.5 }, radius: 0.12, laps: 1 }),
    { ...wire('spin', { at: { x: 0.5, y: 0.5 }, radius: 0.12, laps: 1 }), look: 'flat', squash: 0.6, tilt: 30 },
  ]
  const silent = []
  for (const el of every) {
    const d = sceneOf(parseMotionRecipe({ ...FULL, elements: [el] }))
    let seen = 0
    for (let f = 0; f < TOTAL; f += 2) seen = Math.max(seen, diff(frameOf(d, f), bareFrames[f]))
    if (seen < 0.01) silent.push(`${el.kind}/${el.look}`)
  }
  check(`every element draws (${every.length} kinds and looks)`, silent.length === 0, silent.join(', '))
  check('the test covers every kind', ELEMENT_KINDS.every(k => every.some(e => e.kind === k)))

  // Outside a shimmer's area the picture is untouched.
  const still0 = parseMotionRecipe({ summary: '', camera: { move: 'still', amount: 0 }, grain: 0, elements: [] })
  const sh = parseMotionRecipe({ ...still0, elements: [wire('shimmer', { look: 'water', area: { x: 0.3, y: 0.3, w: 0.4, h: 0.4 }, amount: 1 })] })
  const a = frameOf(sceneOf(still0), 5), b = frameOf(sceneOf(sh), 5)
  let outside = 0, inside = 0
  const sq = coverSquare(W, H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])
    const cx = (x - sq.left) / sq.size, cy = (y - sq.top) / sq.size
    if (cx > 0.34 && cx < 0.66 && cy > 0.34 && cy < 0.66) inside += d
    else if (cx < 0.27 || cx > 0.73 || cy < 0.27 || cy > 0.73) outside += d
  }
  check('a shimmer wavers the picture inside its area and nowhere else', inside > 0 && outside === 0, `inside ${inside}, outside ${outside}`)

  // Grain: fresh every frame, and the reset the worker does changes no pixel.
  const g = sceneOf(plan, true)
  check('grain changes from frame to frame', diff(frameOf(g, 4), frameOf(sceneOf(plan), 4)) > 0.5)
  const c = createCanvas(W, H), cx2 = c.getContext('2d')
  g(cx2, 9); g(cx2, 10)
  check('resetting the context first changes no pixel', Buffer.compare(Buffer.from(cx2.getImageData(0, 0, W, H).data), frameOf(sceneOf(plan, true), 10)) === 0)
  const worker = readFileSync(new URL('../src/lib/cover-motion-worker.ts', import.meta.url), 'utf8')
  check('the worker resets its frame context before every frame', /ctx\.reset\(\)\s*\n\s*draw\(dc, f\)/.test(worker))
}

// ── The render ──────────────────────────────────────────────────────────────
console.log('\nrender')
{
  const mp4 = await renderCoverMotion(stillJpeg, plan, { width: 270, height: 480, seconds: 2, seed: 3 })
  check('an MP4 comes back', mp4.length > 2000 && mp4.subarray(4, 8).toString() === 'ftyp', `${mp4.length} bytes`)
  const frames = await new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-v', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], { stdio: ['pipe', 'pipe', 'inherit'] })
    let n = 0
    p.stdout.on('data', d => { n += d.length })
    p.on('error', reject)
    p.on('close', () => resolve(n / (270 * 480)))
    p.stdin.on('error', () => {})
    p.stdin.end(mp4)
  })
  check('60 frames of 270×480 (2 s at 30 fps)', frames === 60, `${frames}`)
}

// ── Reels ───────────────────────────────────────────────────────────────────
// A cassette drawn as the covers show it: a dark window with two six-toothed
// hubs, the right one seen at an angle (flattened and leaning).
console.log('\nreels')
{
  const N = 700
  const hub = (cx, cy, r, squash, tilt) => {
    let g = `<g transform="translate(${cx} ${cy}) rotate(${tilt}) scale(1 ${squash})"><circle r="${r * 1.5}" fill="#161616"/><circle r="${r}" fill="#e9e6df"/><circle r="${r * 0.42}" fill="#1b1b1b"/>`
    for (let i = 0; i < 6; i++) g += `<rect x="${-r * 0.13}" y="${-r * 1.02}" width="${r * 0.26}" height="${r * 0.5}" fill="#1b1b1b" transform="rotate(${i * 60 + 11})"/>`
    return g + '</g>'
  }
  const A = { x: 250, y: 300, r: 30 }, B = { x: 450, y: 310, r: 30, squash: 0.7, tilt: 20 }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}"><rect width="${N}" height="${N}" fill="#6b6f66"/><rect x="150" y="150" width="400" height="60" fill="#d9d9d9"/><rect x="150" y="360" width="400" height="24" fill="#c33"/><rect x="150" y="384" width="400" height="24" fill="#36c"/>${hub(A.x, A.y, A.r, 1, 0)}${hub(B.x, B.y, B.r, B.squash, B.tilt)}</svg>`
  const cover = await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer()
  const spin = (x, y, r = 0.045) => ({ kind: 'spin', at: { x, y }, radius: r, laps: 2 })
  const base = { summary: '', camera: { move: 'still', amount: 0 }, grain: 0 }
  // Aimed 1.5% of the cover off, the way a model points.
  const out = await refineSpins(cover, { ...base, elements: [spin(A.x / N + 0.015, A.y / N - 0.012), spin(B.x / N - 0.013, B.y / N + 0.014), { kind: 'mist', area: whole, color: '#ffffff', amount: 0.3, angle: 0 }] })
  const [a, b] = out.elements.filter(e => e.kind === 'spin')
  const off = (e, t) => Math.hypot(e.at.x * N - t.x, e.at.y * N - t.y)
  check('both reels are found, and the other elements are left alone', out.elements.length === 3 && out.elements[2].kind === 'mist')
  check('the front-on reel is centred to within a pixel or two', a && off(a, A) < 2.5, a ? `${off(a, A).toFixed(2)} px of ${N}` : 'dropped')
  check('…and found round', a && a.squash > 0.9, a ? `squash ${a.squash.toFixed(2)}` : '')
  check('the reel seen at an angle is centred too', b && off(b, B) < 3, b ? `${off(b, B).toFixed(2)} px` : 'dropped')
  const lean = b ? Math.min(Math.abs(b.tilt - B.tilt), 180 - Math.abs(b.tilt - B.tilt)) : 99
  check('…with how flat it is and which way it leans', b && Math.abs(b.squash - B.squash) < 0.1 && lean < 12, b ? `squash ${b.squash.toFixed(2)} (true ${B.squash}), lean ${b.tilt.toFixed(0)}° (true ${B.tilt}°)` : '')
  check('the reel stops before the label and the stripes', a && a.radius * N < A.r * 1.9 && a.radius * N > A.r * 0.6, a ? `radius ${(a.radius * N).toFixed(1)} px, hub ${A.r}` : '')
  check('a found shape survives being stored and read back', JSON.stringify(parseMotionRecipe(JSON.parse(JSON.stringify(out))).elements) === JSON.stringify(out.elements))
  const none = await refineSpins(cover, { ...base, elements: [spin(0.5, 0.82)] })
  check('a reel aimed at no hub is dropped', none.elements.length === 0)
  const lone = await refineSpins(cover, { ...base, elements: [spin(A.x / N, A.y / N), spin(0.5, 0.82)] })
  check('one reel found of two asked: neither turns', lone.elements.length === 0)
  const junk = await refineSpins(Buffer.from('not an image'), { ...base, elements: [spin(0.3, 0.4), { kind: 'mist', area: whole, color: '#ffffff', amount: 0.3, angle: 0 }] })
  check('an unreadable cover: the reels go, the rest stays', junk.elements.length === 1 && junk.elements[0].kind === 'mist')
  check('the symmetry bar is a real bar', HUB_SYMMETRY > 0.4 && HUB_SYMMETRY < 0.9)

  // A turning reel changes the hub and nothing outside its disc.
  const img = await loadImage(await sharp(Buffer.from(svg)).resize(540, 540).jpeg({ quality: 92 }).toBuffer())
  const mk = els => createCoverMotion({ W: 270, H: 270, total: 48, seed: 1, still: img, recipe: { ...base, elements: els }, createLayer, grain: false })
  const shot = (d, f) => { const c = createCanvas(270, 270), x = c.getContext('2d'); d(x, f); return Buffer.from(x.getImageData(0, 0, 270, 270).data) }
  const plain = shot(mk([]), 5), turned = shot(mk([a]), 5)
  let inside = 0, outside = 0
  for (let y = 0; y < 270; y++) for (let x = 0; x < 270; x++) {
    const i = (y * 270 + x) * 4, d = Math.abs(plain[i] - turned[i])
    // The still camera zooms 1.02 about the centre.
    const fx = 135 + (a.at.x * 270 - 135) * 1.02, fy = 135 + (a.at.y * 270 - 135) * 1.02
    const r = Math.hypot(x - fx, y - fy) / (a.radius * 270 * 1.02)
    if (r < 0.8) inside += d
    else if (r > 1.25) outside += d
  }
  check('a turning reel moves the hub and touches nothing beyond it', inside > 0 && outside === 0, `inside ${inside}, outside ${outside}`)
}

// ── The model call ──────────────────────────────────────────────────────────
console.log('\nthe designer')
{
  const strict = o => o.type !== 'object' || (o.additionalProperties === false && Object.keys(o.properties).every(k => o.required.includes(k)) && Object.values(o.properties).every(v => strict(v.type === 'array' ? v.items : v)))
  check('the schema is closed: every object lists all its fields and allows no others', strict(MOTION_SCHEMA))
  const el = MOTION_SCHEMA.properties.elements.items.properties
  check('the schema offers every kind, look and camera move', ELEMENT_KINDS.every(k => el.kind.enum.includes(k)) && [...PARTICLE_LOOKS, ...GLOW_PACES, ...SHIMMER_LOOKS].every(l => el.look.enum.includes(l)) && CAMERA_MOVES.every(m => MOTION_SCHEMA.properties.camera.properties.move.enum.includes(m)))
  check('the brief explains every kind, look and move', [...ELEMENT_KINDS, ...PARTICLE_LOOKS, ...GLOW_PACES, ...SHIMMER_LOOKS, ...CAMERA_MOVES].every(w => new RegExp(`\\b${w}\\b`).test(MOTION_SYSTEM)))
  check('the brief keeps the cassette and the title out of it', /cassette's body never wavers/.test(MOTION_SYSTEM) && /lower-centre of the cover holds the title/.test(MOTION_SYSTEM))
  check('the brief asks for movement you notice, with a source in the picture', /Very underwhelming/.test(MOTION_SYSTEM) && /Make it readable/.test(MOTION_SYSTEM) && /Motion comes from the picture/.test(MOTION_SYSTEM))
  check('the brief asks for both reels on every cover', /BOTH reels/.test(MOTION_SYSTEM))
  check('two models, the second a stand-in', MOTION_MODELS.length === 2 && MOTION_MODELS[0] !== MOTION_MODELS[1])
  const saved = process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  const p = await writeMotionRecipe(stillJpeg, { idea: 'x' })
  if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved
  check('with no key: the plain plan, and no model named', p.model === null && JSON.stringify(p.recipe) === JSON.stringify(templateRecipe()))
}

if (failures) { console.error(`\n${failures} cover-motion check(s) failed`); process.exit(1) }
console.log('\nall cover-motion checks passed')
