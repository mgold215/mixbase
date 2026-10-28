#!/usr/bin/env node
// Contract test for the Cassette Studio ONE-CLICK flow's pure parts:
//   src/lib/handwriting-sheet.ts  the one-photo handwriting setup, the title
//                                 as written, signature over title lockup
//   src/lib/cassette-studio.ts    automatic lettering spot, the cover
//                                 extended to 9:16 / 16:9 for the moving scenes
//   src/lib/video-loop.ts         seamless silent loop of a generated clip
//   src/lib/scene-brief.ts        the template brief (no API key)
//
// The promise under test: a sheet photo is read with nothing typed (name on
// line one kept whole, the 36 shapes after it labelled A–Z 0–9 by order, a
// miscount refused); a title is written the way the artist writes it; the
// handwriting lands in the calm corner away from the cassette; the extended
// frame keeps the real cover pixels in its middle; and a looped clip's last
// frame is its first.
//
// Run: node scripts/cassette-quick-test.mjs  (also part of `npm test`)

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import sharp from 'sharp'
import { readHandwritingSheet, signatureFromLettering, stackLockup, titleForHandwriting } from '../src/lib/handwriting-sheet.ts'
import {
  COVER, OUTPAINT_SIZES, buildOutpaintRequest, finishOutpaint, isOwnStudioKey, pickLetteringPosition, signatureKey,
} from '../src/lib/cassette-studio.ts'
import { loopFilter, seamlessLoop, videoSeconds } from '../src/lib/video-loop.ts'
import { DEFAULT_MOTION, templateBrief, writeSceneBrief } from '../src/lib/scene-brief.ts'

const require = createRequire(import.meta.url)
const FFMPEG = require('@ffmpeg-installer/ffmpeg').path

let failures = 0
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`)
  else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures++ }
}
const svg = (w, h, body) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`))

// A handwriting sheet: a looping "signature" stroke on line 1, then 36
// separated marks in three rows of 13 / 13 / 10 (shapes alternate so no two
// neighbours merge). Ink on unevenly lit paper.
function sheetSvg(perRow) {
  let body = '<path d="M80 120 C 140 40, 200 200, 260 110 S 380 60, 440 130 S 560 170, 640 100" stroke="#151515" stroke-width="14" fill="none" stroke-linecap="round"/>'
  let y = 260
  for (const n of perRow) {
    for (let i = 0; i < n; i++) {
      const x = 70 + i * 62
      body += i % 2
        ? `<rect x="${x}" y="${y}" width="30" height="56" fill="none" stroke="#151515" stroke-width="9"/>`
        : `<circle cx="${x + 15}" cy="${y + 28}" r="20" fill="none" stroke="#151515" stroke-width="9"/>`
    }
    y += 130
  }
  return svg(1000, 720, `
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#eef0f2"/><stop offset="1" stop-color="#c2c6ca"/></linearGradient></defs>
    <rect width="1000" height="720" fill="url(#g)"/>${body}`).jpeg({ quality: 90 }).toBuffer()
}

// ── Sheet ───────────────────────────────────────────────────────────────────
console.log('handwriting sheet: nothing to type')
{
  const res = await readHandwritingSheet(await sheetSvg([13, 13, 10]))
  check('a full sheet is read', res.ok, res.ok ? '' : res.error)
  if (res.ok) {
    check('36 letters taught', res.glyphs.length === 36, String(res.glyphs.length))
    check('labelled A–Z then 0–9, in order', res.glyphs.map(g => g.char).join('') === 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')
    check('each letter is its own PNG', res.glyphs.every(g => g.png[0] === 0x89 && g.width > 10 && g.height > 10))
    const sig = res.signature
    check('the signature is line one, kept whole (wide, not cut into letters)', sig.width > 500 && sig.height < 220, `${sig.width}x${sig.height}`)
    const raw = await sharp(sig.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    let ink = 0
    for (let i = 3; i < raw.data.length; i += 4) if (raw.data[i] > 128) ink++
    check('…with its ink and none of the letters under it', ink > 3000 && raw.info.height < 220, `${ink} ink px`)
  }
  const letters = await readHandwritingSheet(await sheetSvg([13, 13]))
  check('letters only (26) is accepted too', letters.ok && letters.glyphs.length === 26 && letters.glyphs[25].char === 'Z')
  const short = await readHandwritingSheet(await sheetSvg([13, 12, 10]))
  check('a miscount is refused with the numbers, never guessed', !short.ok && short.found === 35 && short.expected === 36, JSON.stringify(short.ok ? 'ok?!' : short))
  const one = await readHandwritingSheet(await svg(800, 300, '<rect width="800" height="300" fill="#eee"/><path d="M50 150 L700 150" stroke="#111" stroke-width="16"/>').jpeg().toBuffer())
  check('one line alone is refused with what to write', !one.ok && /first line/.test(one.error))
}

console.log('\nsignature from an earlier lettering')
{
  // White ink + alpha, the shape extractHandwriting returns: a name over a title.
  const two = await sharp({ create: { width: 700, height: 300, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } } })
    .composite([
      { input: await svg(700, 300, '<path d="M40 70 C 120 10, 200 130, 300 60 S 480 30, 600 80" stroke="#fff" stroke-width="14" fill="none"/>').png().toBuffer(), left: 0, top: 0 },
      { input: await svg(700, 300, '<rect x="40" y="180" width="40" height="80" fill="#fff"/><rect x="120" y="180" width="40" height="80" fill="#fff"/><rect x="200" y="180" width="40" height="80" fill="#fff"/>').png().toBuffer(), left: 0, top: 0 },
    ]).png().toBuffer()
  const sig = await signatureFromLettering(two)
  check('the first of two lines becomes the signature', sig && sig.height < 140 && sig.width > 450, sig ? `${sig.width}x${sig.height}` : 'null')
  const oneLine = await sharp({ create: { width: 400, height: 120, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } } })
    .composite([{ input: await svg(400, 120, '<rect x="20" y="20" width="40" height="80" fill="#fff"/><rect x="100" y="20" width="40" height="80" fill="#fff"/>').png().toBuffer(), left: 0, top: 0 }]).png().toBuffer()
  check('a single line is never taken for a signature', (await signatureFromLettering(oneLine)) === null)
  const me = '11111111-2222-4333-8444-555555555555'
  check('signature key belongs to its owner only', isOwnStudioKey(signatureKey(me, 1790000000000), me, 'signature') && !isOwnStudioKey(signatureKey(me, 1790000000000), '99999999-2222-4333-8444-555555555555', 'signature'))
  check('a signature key is not a subject or lettering', !isOwnStudioKey(signatureKey(me, 1790000000000), me, 'subject') && !isOwnStudioKey(signatureKey(me, 1790000000000), me, 'lettering'))
}

console.log('\nthe title as it is written')
{
  check('capitals', titleForHandwriting('Not 2 Late').text === 'NOT 2 LATE')
  check('accents stripped, curly quote straightened', titleForHandwriting('Café ’Til Dawn').text === "CAFE 'TIL DAWN", titleForHandwriting('Café ’Til Dawn').text)
  const emoji = titleForHandwriting('Night 🌙 Drive')
  check('unwritable characters dropped and reported', emoji.text === 'NIGHT DRIVE' && emoji.dropped.length === 1, JSON.stringify(emoji))
  const long = titleForHandwriting('Everything You Never Said To Me')
  check('a long title breaks onto two lines near the middle', long.text.split('\n').length === 2 && Math.abs(long.text.split('\n')[0].length - long.text.split('\n')[1].length) <= 8, long.text)
  check('a short title stays on one line', !titleForHandwriting('Toil').text.includes('\n'))
}

console.log('\nlockup: signature over title')
{
  const sig = await svg(600, 120, '<path d="M20 60 C 150 0, 300 120, 580 50" stroke="#fff" stroke-width="12" fill="none"/>').png().toBuffer()
  const title = await svg(400, 160, '<rect x="10" y="10" width="380" height="140" fill="#fff"/>').png().toBuffer()
  const lock = await stackLockup(sig, title)
  check('stacks both into one lettering', lock && lock.height > 160 + 100 && lock.height < 160 + 160, lock ? `${lock.width}x${lock.height}` : 'null')
  const raw = await sharp(lock.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const a = (x, y) => raw.data[(y * raw.info.width + x) * 4 + 3]
  check('…title at the bottom, left-aligned', a(20, raw.info.height - 20) > 200)
  check('…signature on top', (() => { let n = 0; for (let x = 0; x < raw.info.width; x++) for (let y = 0; y < 60; y++) if (a(x, y) > 128) n++; return n > 200 })())
  check('one part alone passes through', (await stackLockup(null, title))?.height > 100 && (await stackLockup(sig, null))?.width > 400)
  check('nothing → nothing', (await stackLockup(null, null)) === null)
}

console.log('\nautomatic lettering spot')
{
  // Busy left half (noise), flat right half; the cassette bottom-right.
  let noise = ''
  for (let i = 0; i < 900; i++) noise += `<rect x="${(i * 37) % 1500}" y="${(i * 91) % 3000}" width="40" height="40" fill="${i % 2 ? '#fff' : '#000'}"/>`
  const art = await svg(3000, 3000, `<rect width="3000" height="3000" fill="#6b7a8a"/>${noise}`).jpeg().toBuffer()
  const box = { left: 1700, top: 2100, width: 1100, height: 700 }
  const pos = await pickLetteringPosition(art, box, 900, 300, 'medium')
  check('picks the calm side', pos.endsWith('right') || pos === 'top-center', pos)
  check('…and not the corner the cassette sits in', pos !== 'bottom-right', pos)
  const flat = await svg(3000, 3000, '<rect width="3000" height="3000" fill="#333"/>').jpeg().toBuffer()
  check('a flat frame keeps the designer default (bottom-left)', (await pickLetteringPosition(flat, { left: 1200, top: 1300, width: 800, height: 600 }, 900, 300)) === 'bottom-left')
  const lowLeft = await pickLetteringPosition(flat, { left: 100, top: 2300, width: 900, height: 600 }, 900, 300)
  check('a cassette in the bottom-left moves the lettering elsewhere', lowLeft !== 'bottom-left', lowLeft)
}

console.log('\nthe cover, extended for the moving scenes')
{
  const cover = await svg(COVER, COVER, `<rect width="${COVER}" height="${COVER}" fill="#20304a"/><rect x="1100" y="1500" width="800" height="500" fill="#e8c020"/>`).jpeg().toBuffer()
  for (const shape of ['portrait', 'landscape']) {
    const req = await buildOutpaintRequest(cover, shape)
    const { width, height } = OUTPAINT_SIZES[shape]
    const im = await sharp(req.image).metadata()
    const mask = await sharp(req.mask).extractChannel(0).raw().toBuffer({ resolveWithObject: true })
    check(`${shape}: request is ${width}×${height}`, im.width === width && im.height === height && mask.info.width === width && mask.info.height === height)
    const m = (x, y) => mask.data[y * width + x]
    const cx = req.inner.left + req.inner.size / 2, cy = req.inner.top + req.inner.size / 2
    check(`${shape}: the cover is kept (mask black in the middle)`, m(Math.round(cx), Math.round(cy)) === 0)
    const bx = shape === 'portrait' ? Math.round(cx) : 10, by = shape === 'portrait' ? 10 : Math.round(cy)
    check(`${shape}: the new band is painted (mask white)`, m(bx, by) === 255)
    check(`${shape}: the seam overlaps a little into the cover`, shape === 'portrait' ? m(Math.round(cx), req.inner.top + 5) === 255 : m(req.inner.left + 5, Math.round(cy)) === 255)
    // A "model" that paints everything red: the real cover must come back in the middle.
    const painted = await sharp({ create: { width, height, channels: 3, background: { r: 255, g: 0, b: 0 } } }).jpeg().toBuffer()
    const outW = shape === 'portrait' ? 1080 : 1920
    const still = await finishOutpaint(painted, cover, req, outW)
    const st = await sharp(still).raw().toBuffer({ resolveWithObject: true })
    const k = outW / width
    const px = (x, y) => { const i = (Math.round(y) * st.info.width + Math.round(x)) * 3; return [st.data[i], st.data[i + 1], st.data[i + 2]] }
    // A point inside the cover's dark field (cover px 750,750), mapped into the frame.
    const mid = px((req.inner.left + req.inner.size * 0.25) * k, (req.inner.top + req.inner.size * 0.25) * k)
    check(`${shape}: the frame is ${outW} wide at the format's shape`, st.info.width === outW && Math.abs(st.info.width / st.info.height - width / height) < 0.01)
    check(`${shape}: the middle is the real cover, not the model's paint`, mid[0] < 80 && mid[2] > 50, mid.join(','))
    const yellow = px((req.inner.left + req.inner.size * (1500 / COVER)) * k, (req.inner.top + req.inner.size * (1750 / COVER)) * k)
    check(`${shape}: the cover's own detail survives (yellow block)`, yellow[0] > 180 && yellow[1] > 150 && yellow[2] < 90, yellow.join(','))
    const band = shape === 'portrait' ? px(cx * k, 20) : px(20, cy * k)
    check(`${shape}: the band is the model's`, band[0] > 200 && band[1] < 60, band.join(','))
  }
}

console.log('\nseamless loop')
{
  check('the blend filter overlays the head over the tail', /trim=start=1\.000:end=6\.000/.test(loopFilter(6, 1, 1080, 1920)) && /fade=t=in:st=4\.000:d=1\.000:alpha=1/.test(loopFilter(6, 1, 1080, 1920)))
  const dir = mkdtempSync(join(tmpdir(), 'qloop-'))
  try {
    const src = join(dir, 'src.mp4')
    const gen = spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src])
    check('test clip generated', gen.status === 0, String(gen.stderr))
    const out = await seamlessLoop(readFileSync(src), { width: 540, height: 960, fade: 1 })
    const secs = await videoSeconds(out)
    check('loop is the clip minus the blend (≈5s)', Math.abs(secs - 5) < 0.25, String(secs))
    const outFile = join(dir, 'out.mp4')
    require('node:fs').writeFileSync(outFile, out)
    const probe = spawnSync(require('@ffprobe-installer/ffprobe').path, ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,pix_fmt', '-of', 'compact', outFile])
    const streams = String(probe.stdout)
    check('silent (no audio stream)', !/codec_type=audio/.test(streams), streams)
    check('exact format size, yuv420p', /width=540\|height=960\|pix_fmt=yuv420p/.test(streams), streams)
    const frame = args => {
      const r = spawnSync(FFMPEG, ['-v', 'error', ...args, '-vf', 'scale=54:96', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'])
      return r.stdout
    }
    const first = frame(['-i', outFile])
    const last = frame(['-sseof', '-0.05', '-i', outFile])
    const middle = frame(['-ss', '2.5', '-i', outFile])
    const diff = (a, b) => { let s = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) s += Math.abs(a[i] - b[i]); return s / Math.min(a.length, b.length) }
    const seam = diff(first, last), motion = diff(first, middle)
    check('the last frame is the first (no jump at the restart)', seam < motion / 3, `seam ${seam.toFixed(2)} vs motion ${motion.toFixed(2)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('\nscene brief without an API key')
{
  const saved = process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  const b = await writeSceneBrief('  rooftop in tokyo,   rain, neon  ')
  check('falls back to the artist\'s own words', b.source === 'template' && b.setting === 'rooftop in tokyo, rain, neon', JSON.stringify(b))
  check('…with the default motion (reels turning, slow push-in)', b.motion === DEFAULT_MOTION && /reels turn/.test(b.motion))
  check('a long description gets a short label', templateBrief('a very long description of a dusty desert motel parking lot at night').label.length <= 41)
  if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\nall cassette-quick checks passed')
