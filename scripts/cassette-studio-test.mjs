#!/usr/bin/env node
// Contract test for Cassette Studio — the real-cassette cover engine:
//   src/lib/handwriting.ts      lifts handwriting off a photo
//   src/lib/cassette-studio.ts  cut-out clean-up, placement, FLUX Fill mask,
//                               composite, lettering, studio key ownership
//   src/lib/cassette-scenes.ts  scene presets + prompt
//
// Drives the real sharp pipeline on synthetic images so every assertion is
// about pixels. The promise under test: the cassette's own pixels survive into
// the cover, the clear shell turns see-through while the label stays solid,
// handwriting comes off the paper without the dust, and a client can never
// name another user's studio file.
//
// Run: node scripts/cassette-studio-test.mjs  (also part of `npm test`)

import sharp from 'sharp'
import { extractHandwriting } from '../src/lib/handwriting.ts'
import {
  COVER, FILL_SIZE, applyLettering, buildFillRequest, composeCover, isOwnStudioKey,
  placeSubject, seeThrough, studioPrefix, trimSubject,
} from '../src/lib/cassette-studio.ts'
import { CASSETTE_SCENES, isSceneId, scenePrompt } from '../src/lib/cassette-scenes.ts'

let failures = 0
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`)
  else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures++ }
}

const svg = (w, h, body) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`))
async function rawOf(buf) {
  return sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
}
const px = (r, x, y) => { const i = (y * r.info.width + x) * 4; return [r.data[i], r.data[i + 1], r.data[i + 2], r.data[i + 3]] }

// ── Handwriting ─────────────────────────────────────────────────────────────
console.log('handwriting: lifts the ink, drops the dust')
{
  // Blue marker strokes on unevenly lit grey paper, plus dust specks far from
  // the writing and an i-dot right next to it.
  const page = await svg(1200, 900, `
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e4e6e8"/><stop offset="1" stop-color="#b9bcc0"/></linearGradient></defs>
    <rect width="1200" height="900" fill="url(#g)"/>
    <path d="M200 300 L300 420 L400 300 L500 420" stroke="#2350c8" stroke-width="22" fill="none" stroke-linecap="round"/>
    <path d="M560 300 L560 420" stroke="#2350c8" stroke-width="22" stroke-linecap="round"/>
    <circle cx="560" cy="262" r="13" fill="#2350c8"/>
    <path d="M620 300 Q700 250 760 330 T900 420" stroke="#2350c8" stroke-width="22" fill="none" stroke-linecap="round"/>
    <circle cx="80" cy="800" r="3" fill="#333"/><circle cx="1100" cy="120" r="3" fill="#333"/><circle cx="1000" cy="820" r="2" fill="#222"/>
  `).jpeg({ quality: 90 }).toBuffer()
  const l = await extractHandwriting(page)
  const r = await rawOf(l.png)
  check('output is a PNG', l.png[0] === 0x89 && l.png[1] === 0x50)
  // Writing spans x 189..911, y 249..431 → crop is close to that, so the far
  // dust specks (x 80 / 1100 / 1000) were dropped rather than widening it.
  check('crop hugs the writing (dust specks dropped)', l.width < 800 && l.width > 690 && l.height < 230 && l.height > 160, `${l.width}x${l.height}`)
  let opaque = 0, rgbWhite = true
  for (let i = 0; i < r.data.length; i += 4) {
    if (r.data[i + 3] > 200) opaque++
    if (r.data[i + 3] > 0 && (r.data[i] !== 255 || r.data[i + 1] !== 255 || r.data[i + 2] !== 255)) rgbWhite = false
  }
  check('strokes are solid ink in the alpha channel', opaque > 20000, String(opaque))
  check('RGB is white everywhere (tintable)', rgbWhite)
  // The i-dot (a small blob INSIDE the writing's box) survives. It is the
  // only ink above the strokes' tops (y≈289 on the page; the crop starts at
  // the dot's top minus padding), so the top band of the crop holds it alone.
  let dotInk = 0
  for (let y = 0; y < 45; y++) for (let x = 0; x < l.width; x++) if (px(r, x, y)[3] > 128) dotInk++
  check('i-dot kept', dotInk > 200, String(dotInk))

  let threw = false
  try { await extractHandwriting(await svg(400, 300, '<rect width="400" height="300" fill="#ddd"/>').jpeg().toBuffer()) } catch { threw = true }
  check('a blank page is refused, not returned as empty lettering', threw)
}

// ── See-through ─────────────────────────────────────────────────────────────
console.log('\nsee-through: clear shell turns clear, label stays solid')
// A face-on "cassette" 640×408 (aspect 1.57) on a light backdrop: the frame
// band is backdrop-coloured (clear plastic showing the wall), the label is a
// grey CLOSE to the backdrop (the case that defeats a naive difference matte).
const W = 900, H = 700, CX = 130, CY = 146, CW = 640, CH = 408
const photo = await svg(W, H, `
  <rect width="${W}" height="${H}" fill="#dcdcdc"/>
  <rect x="${CX}" y="${CY}" width="${CW}" height="${CH}" fill="#d6d6d6" stroke="#9a9a9a" stroke-width="4"/>
  <rect x="${CX + 60}" y="${CY + 50}" width="${CW - 120}" height="${CH * 0.6}" fill="#c4c4c4"/>
  <rect x="${CX + 60}" y="${CY + 180}" width="${CW - 120}" height="30" fill="#e8c020"/>
`).png().toBuffer()
const matte = await svg(W, H, `<rect x="${CX}" y="${CY}" width="${CW}" height="${CH}" fill="#fff"/>`).png().toBuffer()
const matteRaw = await sharp(matte).extractChannel(0).raw().toBuffer()
const cutout = await sharp(await sharp(photo).removeAlpha().raw().toBuffer(), { raw: { width: W, height: H, channels: 3 } })
  .joinChannel(matteRaw, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer()
{
  const out = await rawOf(await seeThrough(photo, cutout))
  const frame = px(out, CX + 20, CY + CH - 30)      // bottom shell, backdrop-coloured
  const label = px(out, CX + CW / 2, CY + 120)       // grey label near the backdrop grey
  const stripe = px(out, CX + CW / 2, CY + 195)      // yellow stripe
  const outside = px(out, 20, 20)
  check('clear frame becomes mostly transparent', frame[3] < 110, `alpha ${frame[3]}`)
  check('…but keeps a plastic sheen (not fully gone)', frame[3] > 20, `alpha ${frame[3]}`)
  check('label stays opaque even though its grey is near the backdrop', label[3] > 240, `alpha ${label[3]}`)
  check('label colour untouched', Math.abs(label[0] - 0xc4) < 6, String(label[0]))
  check('stripe opaque and yellow', stripe[3] > 240 && stripe[0] > 200 && stripe[2] < 80, stripe.join(','))
  check('outside the cassette stays transparent', outside[3] === 0)

  // Not face-on / not cassette-shaped → returned unchanged.
  const tallMatte = await svg(W, H, `<rect x="300" y="50" width="200" height="600" fill="#fff"/>`).png().toBuffer()
  const tallRaw = await sharp(tallMatte).extractChannel(0).raw().toBuffer()
  const tallCut = await sharp(await sharp(photo).removeAlpha().raw().toBuffer(), { raw: { width: W, height: H, channels: 3 } })
    .joinChannel(tallRaw, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer()
  const tall = await rawOf(await seeThrough(photo, tallCut))
  check('non-cassette shapes are left alone', px(tall, 400, 600)[3] === 255)
}

// ── Subject, placement, fill request ────────────────────────────────────────
console.log('\nsubject + placement + FLUX Fill request')
const subj = await trimSubject(cutout)
check('trim crops to the object', subj.width === CW && subj.height === CH, `${subj.width}x${subj.height}`)
const box = placeSubject(subj.width, subj.height, 42)
check('placement is inside the cover', box.left > 0 && box.top > 0 && box.left + box.width < COVER && box.top + box.height < COVER)
check('cassette ~40% of the width', box.width > COVER * 0.36 && box.width < COVER * 0.44, String(box.width))
check('stands ~70% down the frame', Math.abs((box.top + box.height) / COVER - 0.7) < 0.03)
check('aspect preserved', Math.abs(box.width / box.height - CW / CH) < 0.02)
check('same seed → same placement', JSON.stringify(placeSubject(subj.width, subj.height, 42)) === JSON.stringify(box))
{
  const { image, mask } = await buildFillRequest(subj.png, box)
  const im = await sharp(image).metadata()
  const m = await sharp(mask).extractChannel(0).raw().toBuffer({ resolveWithObject: true })
  check(`fill canvas is ${FILL_SIZE}²`, im.width === FILL_SIZE && im.height === FILL_SIZE)
  check('mask is the same size as the canvas', m.info.width === FILL_SIZE && m.info.height === FILL_SIZE)
  const s = FILL_SIZE / COVER
  const at = (x, y) => m.data[Math.round(y * s) * FILL_SIZE + Math.round(x * s)]
  check('mask BLACK over the cassette (keep it)', at(box.left + box.width / 2, box.top + box.height * 0.3) === 0)
  check('mask WHITE around it (paint the scene)', at(100, 100) === 255 && at(box.left - 40, box.top + 50) === 255)
}

// ── Composite ───────────────────────────────────────────────────────────────
console.log('\ncomposite')
{
  const bg = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: { r: 40, g: 60, b: 90 } } }).jpeg().toBuffer()
  const art = await composeCover({ background: bg, subject: subj.png, box, kind: 'photo', seed: 1, raw: true })
  const meta = await sharp(art).metadata()
  check(`output is a ${COVER}×${COVER} JPEG`, meta.format === 'jpeg' && meta.width === COVER && meta.height === COVER)
  const r = await sharp(art).raw().toBuffer({ resolveWithObject: true })
  const at = (x, y) => { const i = (y * COVER + x) * 3; return [r.data[i], r.data[i + 1], r.data[i + 2]] }
  const sx = box.width / CW
  const stripe = at(Math.round(box.left + (CW / 2) * sx), Math.round(box.top + 195 * sx))
  // Exposure-matched to the dark scene (so dimmer than the source's 232,192,32)
  // but still unmistakably the stripe: same hue, nothing generated over it.
  check('the real cassette pixels are in the cover (yellow stripe)', stripe[0] > 110 && stripe[1] > 95 && stripe[2] < 60 && stripe[0] > stripe[2] * 3, stripe.join(','))
  check('…exposure pulled toward the night scene, not left at studio brightness', stripe[0] < 220, stripe.join(','))
  const under = at(Math.round(box.left + box.width / 2), box.top + box.height + 6)
  const far = at(200, box.top + box.height + 6)
  check('contact shadow darkens the surface under the cassette', under[2] < far[2] - 10, `${under} vs ${far}`)
  const finished = await composeCover({ background: bg, subject: subj.png, box, kind: 'scene', seed: 1 })
  check('film finish path still outputs a cover-size JPEG', (await sharp(finished).metadata()).width === COVER)
}

// ── Lettering ───────────────────────────────────────────────────────────────
console.log('\nlettering')
{
  const word = await svg(600, 160, '<path d="M20 120 L120 30 L220 120 L320 30 L420 120 L520 30" stroke="#fff" stroke-width="26" fill="none"/>').png().toBuffer()
  const bright = await sharp({ create: { width: COVER, height: COVER, channels: 3, background: '#f0f0f0' } }).jpeg().toBuffer()
  const dark = await sharp({ create: { width: COVER, height: COVER, channels: 3, background: '#101418' } }).jpeg().toBuffer()
  const a = await applyLettering(bright, word)
  const b = await applyLettering(dark, word)
  check('auto colour → ink-black on a bright cover', a.color === '#161616', a.color)
  check('auto colour → marker-white on a dark cover', b.color === '#F4F1EA', b.color)
  const c = await applyLettering(dark, word, { color: '#e03a3e', position: 'top-right' })
  check('explicit colour honoured', c.color === '#e03a3e')
  const r = await sharp(c.jpeg).raw().toBuffer({ resolveWithObject: true })
  let red = 0
  for (let y = 150; y < 900; y += 4) for (let x = COVER - 1500; x < COVER - 150; x += 4) { const i = (y * COVER + x) * 3; if (r.data[i] > 180 && r.data[i + 1] < 90) red++ }
  check('lettering lands top-right', red > 200, String(red))
}

// ── Studio key ownership ────────────────────────────────────────────────────
console.log('\nstudio keys')
{
  const me = '11111111-2222-3333-4444-555555555555'
  const other = '99999999-2222-3333-4444-555555555555'
  const proj = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  check('own subject accepted', isOwnStudioKey(`${studioPrefix(me)}subject-1790000000000.png`, me, 'subject'))
  check('own lettering accepted', isOwnStudioKey(`${studioPrefix(me)}lettering-${proj}-1790000000000.png`, me, 'lettering'))
  check("another user's subject refused", !isOwnStudioKey(`${studioPrefix(other)}subject-1790000000000.png`, me, 'subject'))
  check('traversal refused', !isOwnStudioKey(`${studioPrefix(me)}../${other}/subject-1790000000000.png`, me, 'subject'))
  check('nested path refused', !isOwnStudioKey(`${studioPrefix(me)}x/subject-1790000000000.png`, me, 'subject'))
  check('temp inputs are not subjects', !isOwnStudioKey(`${studioPrefix(me)}tmp-1790000000000-photo.jpg`, me, 'subject'))
  check('kinds are not interchangeable', !isOwnStudioKey(`${studioPrefix(me)}subject-1790000000000.png`, me, 'lettering'))
  check('non-strings refused', !isOwnStudioKey(null, me, 'subject') && !isOwnStudioKey({}, me, 'subject'))
}

// ── Scenes ──────────────────────────────────────────────────────────────────
console.log('\nscenes')
{
  const ids = CASSETTE_SCENES.map(s => s.id)
  check('scene ids unique', new Set(ids).size === ids.length)
  check('isSceneId knows the presets and nothing else', isSceneId(ids[0]) && !isSceneId('__proto__') && !isSceneId('photo'))
  const HYPE = /\b(8k|4k|hyper|ultra[- ]?realistic|masterpiece|render|cgi|surreal|octane|unreal engine)\b/i
  const bad = CASSETTE_SCENES.filter(s => HYPE.test(s.setting) || HYPE.test(scenePrompt(s.setting)))
  check('no AI-art hype vocabulary in any scene prompt', bad.length === 0, bad.map(s => s.id).join(','))
  const p = scenePrompt('a bar counter.  ')
  check('prompt names the cassette, the setting and the eye-level camera', /cassette/.test(p) && /a bar counter\./.test(p) && /[Ee]ye-level/.test(p))
  check('custom setting is length-capped', scenePrompt('x'.repeat(5000)).length < 1200)
}

if (failures) {
  console.error(`\n✗ ${failures} cassette-studio check(s) failed`)
  process.exit(1)
}
console.log('\n✓ cassette-studio: all checks passed')
