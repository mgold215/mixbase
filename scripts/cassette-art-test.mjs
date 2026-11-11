#!/usr/bin/env node
// Contract test for the Cassette Studio ART ENGINE — covers drawn around the
// artist's cassette from a reference photo:
//   src/lib/cassette-art.ts    take keys, model inputs, reference photo, prompt, finish
//   src/lib/cover-concept.ts   the concept (template half) and the take picker's fallbacks
//   src/lib/still-loop.ts      a cover set gently in motion (the no-AI clip)
//
// No model is called: the promises under test are the ones the code keeps
// without one. A take key can never name another artist's file or another
// song's take; every model is asked for one square picture with the cassette
// photo as its reference, richest input first; the prompt always carries the
// cassette's identity and the rules that keep the picture a cover; with no
// key (or a failed call) the concept is built from the artist's own words and
// the first take is used, so a run never stops on art direction; a take
// becomes exactly a 3000×3000 cover; and any picture, any shape, becomes a
// seamless silent clip of exactly the format's size.
//
// Run: node scripts/cassette-art-test.mjs  (also part of `npm test`)

import sharp from 'sharp'
import {
  ART_MODELS, CASSETTE_IDENTITY, DEFAULT_TAKES, MAX_SCENE, MAX_TAKES, TAKE_SIZE, artModelInputs, artPrompt, buildReference,
  finishTake, isArtModelId, parseTakeKey, storeTake, takeKey,
} from '../src/lib/cassette-art.ts'
import { CASSETTE_PASS, MEDIUMS, REAL_PASS, chooseTake, critiqueTakes, judgeTakes, parseConcept, pickMediums, promptConcept, templateConcept, writeCoverConcept, writeCoverIdeas } from '../src/lib/cover-concept.ts'
import { fitStill, stillLoop, stillLoopFilter } from '../src/lib/still-loop.ts'
import { videoSeconds } from '../src/lib/video-loop.ts'
import { COVER } from '../src/lib/cassette-studio.ts'

let failures = 0
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`)
  else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures++ }
}
const svg = (w, h, body) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`))
/** mulberry32, so "random" picks are the same every run. */
function seeded(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

// ── Take keys ───────────────────────────────────────────────────────────────
console.log('take keys')
{
  const me = '11111111-2222-4333-8444-555555555555', them = '99999999-2222-4333-8444-555555555555'
  const song = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const k = takeKey(me, song, 1790000000000, 2)
  check('key carries the song, the run and the take', k === `studio/${me}/take-${song}-1790000000000-2.jpg`, k)
  const p = parseTakeKey(k, me)
  check('…and parses back', p && p.projectId === song && p.run === '1790000000000' && p.index === 2, JSON.stringify(p))
  check("another artist's key is not mine", parseTakeKey(k, them) === null)
  for (const bad of [
    `studio/${me}/take-${song}-1790000000000-2.png`, `studio/${me}/take-${song}-1790000000000-12.jpg`,
    `studio/${me}/take-${song}-17-2.jpg`, `studio/${me}/take-NOTAUUID-1790000000000-2.jpg`,
    `studio/${me}/sub/take-${song}-1790000000000-2.jpg`, `studio/${me}/../${them}/take-${song}-1790000000000-2.jpg`,
    `studio/${me}/subject-1790000000000.png`, 42, null,
  ]) check(`rejected: ${String(bad).slice(-44)}`, parseTakeKey(bad, me) === null)
}

// ── Models ──────────────────────────────────────────────────────────────────
console.log('\nmodel inputs')
{
  const ref = 'https://example.test/ref.jpg'
  check('the chain has a first choice and fallbacks, all distinct', ART_MODELS.length >= 2 && new Set(ART_MODELS.map(m => m.slug)).size === ART_MODELS.length)
  check('takes: 1 ≤ default ≤ max ≤ 9 (one digit in the key)', DEFAULT_TAKES >= 1 && DEFAULT_TAKES <= MAX_TAKES && MAX_TAKES <= 9)
  check('isArtModelId knows the chain and nothing else', ART_MODELS.every(m => isArtModelId(m.id)) && !isArtModelId('dall-e') && !isArtModelId(3))
  for (const m of ART_MODELS) {
    const shapes = artModelInputs(m.id, 'PROMPT', ref, 3)
    const refOf = s => s.input_images ?? s.image_input
    check(`${m.id}: every shape carries the prompt and the cassette photo`, shapes.length >= 2 && shapes.every(s => s.prompt === 'PROMPT' && Array.isArray(refOf(s)) && refOf(s).length === 1 && refOf(s)[0] === ref))
    check(`${m.id}: every shape asks for a square`, shapes.every(s => s.aspect_ratio === '1:1' || s.aspect_ratio === `${TAKE_SIZE}x${TAKE_SIZE}`))
    check(`${m.id}: richest shape first, plainest last`, Object.keys(shapes[0]).length > Object.keys(shapes[shapes.length - 1]).length)
  }
  const g = artModelInputs('gpt-image-2', 'P', ref, 3)
  check('gpt-image-2: all takes in one call, at the full size and quality', g[0].number_of_images === 3 && g[0].aspect_ratio === `${TAKE_SIZE}x${TAKE_SIZE}` && g[0].quality === 'high')
  check('gpt-image-2: the count is kept within 1…MAX_TAKES', artModelInputs('gpt-image-2', 'P', ref, 99)[0].number_of_images === MAX_TAKES && artModelInputs('gpt-image-2', 'P', ref, 0)[0].number_of_images === 1)
  check('one-picture models are asked for one picture', ART_MODELS.filter(m => m.perCall === 1).every(m => artModelInputs(m.id, 'P', ref, 3).every(s => s.number_of_images === undefined)))
}

// ── Prompt ──────────────────────────────────────────────────────────────────
console.log('\nprompt')
{
  const p = artPrompt('  A Dutch still life in oil.\n\n The cassette lies among lemons.  ')
  check('opens with what the cassette is', p.startsWith(CASSETTE_IDENTITY) && /red on top, then blue, then yellow/.test(p) && /exactly one cassette/.test(p))
  check('carries the scene, tidied', p.includes('Create a square album cover artwork. A Dutch still life in oil. The cassette lies among lemons.') && !p.includes('lemons..'))
  check('keeps the title area calm and the picture free of text', /lower-centre of the frame calm/.test(p) && /No text, letters, numbers/.test(p))
  check('asks for the cassette to belong to the picture', /this scene's own light/.test(p) && /same medium/.test(p))
  check('…redrawn in the scene\'s perspective, never the reference photo pasted in', /do not paste/.test(p) && /in perspective/.test(p) && /contact shadow/.test(p))
  check('…and for a picture that passes for hand-made', /really photographed or made by hand/.test(p) && /real size/.test(p) && /no glow/.test(p))
  const long = artPrompt('x'.repeat(MAX_SCENE + 500))
  check('an over-long scene is cut, the rules still follow it', !long.includes('x'.repeat(MAX_SCENE + 1)) && /No text, letters/.test(long))
}

// ── Reference photo ─────────────────────────────────────────────────────────
console.log('\nreference photo')
{
  // A "cassette": an opaque red label inside a half-clear shell.
  const subject = await sharp({ create: { width: 800, height: 500, channels: 4, background: { r: 200, g: 200, b: 200, alpha: 0.35 } } })
    .composite([{ input: await svg(600, 300, '<rect width="600" height="300" fill="#c81e1e"/>').png().toBuffer(), left: 100, top: 100 }]).png().toBuffer()
  const ref = await buildReference(subject)
  const { data, info } = await sharp(ref).raw().toBuffer({ resolveWithObject: true })
  const px = (x, y) => [data[(y * info.width + x) * 3], data[(y * info.width + x) * 3 + 1], data[(y * info.width + x) * 3 + 2]]
  check('a 4:3 JPEG', ref[0] === 0xff && ref[1] === 0xd8 && info.width === 1536 && info.height === 1152)
  const c = px(768, 576)
  check('the cassette sits in the middle', c[0] > 170 && c[1] < 70 && c[2] < 70, String(c))
  const corner = px(40, 40)
  check('on a plain light backdrop', corner[0] > 200 && Math.abs(corner[0] - corner[1]) < 6 && Math.abs(corner[1] - corner[2]) < 8, String(corner))
  // Clear shell: the backdrop shows through (lighter than the shell's own grey would be alone).
  const shell = px(768 - 500, 576)
  check('the clear shell lets the backdrop through', shell[0] > 195 && shell[0] < 240, String(shell))
  // Soft contact shadow: just under the cassette is darker than the floor further down.
  let under = 0, floor = 0
  for (let x = 600; x < 936; x += 8) { under += px(x, 576 + 336 + 14)[0]; floor += px(x, 1130)[0] }
  check('a soft shadow where it stands', under < floor - 300, `${under} vs ${floor}`)
  check('never fills the frame (air on every side)', px(768, 60)[0] > 200 && px(60, 576)[0] > 190 && px(1476, 576)[0] > 190)
}

// ── Finish ──────────────────────────────────────────────────────────────────
console.log('\nfrom take to cover')
{
  const take = await svg(1024, 1024, '<rect width="1024" height="1024" fill="#20304a"/><circle cx="512" cy="512" r="200" fill="#e8c020"/>').png().toBuffer()
  const cover = await finishTake(take, 7)
  const meta = await sharp(cover).metadata()
  check(`the cover is exactly ${COVER}×${COVER} JPEG`, meta.width === COVER && meta.height === COVER && meta.format === 'jpeg')
  check('same seed → the same cover', (await finishTake(take, 7)).equals(cover))
  check('another seed → another grain', !(await finishTake(take, 8)).equals(cover))
  const { data } = await sharp(cover).extract({ left: 1400, top: 1400, width: 200, height: 200 }).raw().toBuffer({ resolveWithObject: true })
  let r = 0, b = 0
  for (let i = 0; i < data.length; i += 3) { r += data[i]; b += data[i + 2] }
  check('the picture is not recoloured (the sun is still yellow)', r / (data.length / 3) > 200 && b / (data.length / 3) < 80)
  const wide = await svg(1536, 1024, '<rect width="1536" height="1024" fill="#444"/>').png().toBuffer()
  const wm = await sharp(await finishTake(wide, 1)).metadata()
  check('a take that is not square is cropped to one, never stretched', wm.width === COVER && wm.height === COVER)
  const stored = await sharp(await storeTake(take)).metadata()
  check('a stored take keeps its own size', stored.width === 1024 && stored.height === 1024 && stored.format === 'jpeg')
}

// ── Concept ─────────────────────────────────────────────────────────────────
console.log('\nconcept without a model')
{
  const three = pickMediums(seeded(5))
  check('three different mediums from the list', three.length === 3 && new Set(three).size === 3 && three.every(m => MEDIUMS.includes(m)))
  check('the list has range and no medium that asks for writing', MEDIUMS.length >= 20 && !MEDIUMS.some(m => /manuscript|poster|typograph|lettering|newspaper|comic/i.test(m)))
  check('no medium that invites the generated look', !MEDIUMS.some(m => /neon|glow|surreal|sci-?fi|science-fiction|tilt-shift|infrared|impossible|vast|epic|baroque/i.test(m)), MEDIUMS.filter(m => /neon|glow|surreal|vast/i.test(m)).join(' | '))
  check('every medium can show the cassette\'s three stripe colours', !MEDIUMS.some(m => /black-and-white|black and white|monochrome print$|one or two inks|two-colour|cyanotype/i.test(m)), MEDIUMS.filter(m => /black-and-white|two-colour|cyanotype/i.test(m)).join(' | '))
  check('most mediums are photographs or prints of real things', MEDIUMS.filter(m => /photograph|scan|print|linocut|collage|drawing|sketch|engraving/i.test(m)).length >= MEDIUMS.length * 0.8)
  const t = templateConcept({ title: 'Belladonna' }, seeded(3))
  check('title alone: the scene is about the title, in a named medium', /Belladonna/.test(t.scene) && MEDIUMS.some(m => t.scene.includes(m)) && t.source === 'template', t.scene)
  check('…the cassette is the heart of it', /The cassette is the heart of it/.test(t.scene))
  check('…and it says what it is in a sentence', t.idea.length > 10 && t.label === 'Belladonna')
  check('same dice → the same concept', JSON.stringify(templateConcept({ title: 'Belladonna' }, seeded(3))) === JSON.stringify(t))
  const mine = templateConcept({ title: 'Eris', idea: '  the cassette as the golden apple at a banquet of gods ' }, seeded(3))
  check("the artist's own idea is used as written", mine.scene.includes('the cassette as the golden apple at a banquet of gods') && mine.idea === 'the cassette as the golden apple at a banquet of gods')
  check('a long idea gets a short label', templateConcept({ title: 'X', idea: 'a very long idea that goes on and on well past forty characters' }, seeded(1)).label.length <= 40)
  check('no title, no idea: still a concept', templateConcept({ title: '' }, seeded(2)).scene.length > 80)
  const exact = promptConcept('  A  NASA photograph.   The cassette drifts past the Moon. ', 'Eris')
  check('an exact brief is used as written', exact.scene === 'A NASA photograph. The cassette drifts past the Moon.' && exact.source === 'prompt' && exact.label === 'Eris')
  check('every concept says how it moves', [t, mine, exact].every(c => /reels turn/.test(c.motion)))

  // Without a key the run never waits on art direction.
  const key = process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  try {
    const w = await writeCoverConcept({ title: 'Vitals', genre: 'Ambient' }, seeded(9))
    check('no key: the concept is the template', w.source === 'template' && /Vitals/.test(w.scene))
    const blank = await svg(64, 64, '<rect width="64" height="64" fill="#888"/>').png().toBuffer()
    const v = await judgeTakes(blank, [blank, blank], { idea: 'x' })
    check('no key: the first take is used and nothing is redrawn', v.best === 0 && v.usable === true && v.spot === null && v.fix === '' && v.source === 'first')
    check('no takes: nothing to judge', (await judgeTakes(blank, [], { idea: 'x' })).best === 0)
    const ideas = await writeCoverIdeas({ title: 'Vitals' }, 3, seeded(4))
    check('no key: three template ideas, each in a different medium', ideas.length === 3 && new Set(ideas.map(i => i.scene)).size === 3 && ideas.every(i => i.source === 'template'))
    check('no key: the look check is skipped, not failed', (await critiqueTakes([blank, blank])) === null)
  } finally {
    if (key !== undefined) process.env.ANTHROPIC_API_KEY = key
  }
}

// ── The idea handed back, and the take that is chosen ───────────────────────
console.log('\nchoosing the idea and the take')
{
  const scene = 'A 35mm photograph in plain daylight. The cassette lies half-buried in dry sand, small in the frame, lit by a low sun from the left.'
  const c = parseConcept({ idea: ' The cassette half-buried in sand ', label: 'Buried In Sand', scene, motion: 'Slow push-in. The reels turn.', extra: 1 })
  check('a chosen idea comes back as a concept', c !== null && c.idea === 'The cassette half-buried in sand' && c.scene === scene && c.motion.startsWith('Slow push-in'))
  check('…and gets the default motion when it has none', /reels turn/.test(parseConcept({ idea: 'x', scene }).motion))
  check('not an idea: refused', parseConcept(null) === null && parseConcept('x') === null && parseConcept({ idea: 'x', scene: 'too short' }) === null && parseConcept({ scene }) === null)
  check('an over-long scene is cut to the limit', parseConcept({ idea: 'x', scene: 'a '.repeat(2000) }).scene.length <= MAX_SCENE)

  const verdict = (marks, best = 0) => ({ best, usable: true, spot: 'bottom-center', fix: '', notes: [], scores: marks.map(([cassette, picture]) => ({ cassette, picture })), source: 'claude' })
  const look = reals => reals.map(real => ({ real, tells: real < REAL_PASS ? 'glow and haze' : '', fix: real < REAL_PASS ? 'Take out the glow.' : '' }))
  check('the marks that pass are 7 and 7', REAL_PASS === 7 && CASSETTE_PASS === 7)
  let ch = chooseTake(3, verdict([[9, 9], [9, 7], [9, 6]]), look([3, 8, 9]))
  check('the prettiest take loses when it looks AI-made', ch.best !== 0 && ch.cassetteOk && ch.realOk && ch.fix === '', JSON.stringify(ch))
  check('…to the best of picture and look together', ch.best === 1 || ch.best === 2)
  ch = chooseTake(3, verdict([[9, 9], [9, 8], [4, 9]]), look([4, 5, 9]))
  check('none passes both: the right cassette that looks most real, and a redraw is asked for', ch.best === 1 && ch.cassetteOk && !ch.realOk && ch.fix === 'Take out the glow.', JSON.stringify(ch))
  ch = chooseTake(2, verdict([[4, 9], [5, 8]], 0), look([9, 9]))
  check('no take is the cassette: the judge\'s pick, flagged', ch.best === 0 && !ch.cassetteOk && ch.realOk)
  ch = chooseTake(2, { ...verdict([[4, 9], [5, 8]], 1), fix: 'Three stripes: red, blue, yellow.' }, look([3, 3]))
  check('…and both faults go into the redraw', !ch.cassetteOk && !ch.realOk && /stripes/.test(ch.fix) && /glow/.test(ch.fix), ch.fix)
  ch = chooseTake(3, verdict([[9, 6], [9, 9], [9, 7]]), null)
  check('the look check did not run: the best picture, as before', ch.best === 1 && ch.realOk && ch.cassetteOk)
  ch = chooseTake(2, { best: 0, usable: true, spot: null, fix: '', notes: [], scores: [], source: 'first' }, look([4, 8]))
  check('the judge did not run: the take that looks real', ch.best === 1 && ch.realOk)
  ch = chooseTake(1, { best: 0, usable: true, spot: null, fix: '', notes: [], scores: [], source: 'first' }, null)
  check('nothing ran: the first take, no redraw', ch.best === 0 && ch.cassetteOk && ch.realOk && ch.fix === '')
}

// ── Still loop ──────────────────────────────────────────────────────────────
console.log('\na cover set in motion')
{
  const f = stillLoopFilter(240, 1080, 1920, 30)
  check('one full turn of the camera per loop', f.includes('2*PI*on/240') && f.includes('d=240') && f.includes('s=1080x1920') && f.includes('fps=30'))
  check('live grain, playable pixels', /noise=alls=\d+:allf=t\+u/.test(f) && f.endsWith('format=yuv420p'))
  const cover = await svg(900, 900, '<rect width="900" height="900" fill="#20304a"/><rect x="300" y="350" width="300" height="200" fill="#e8c020"/><rect x="0" y="0" width="900" height="40" fill="#c81e1e"/>').jpeg().toBuffer()
  const tall = await fitStill(cover, 540, 960)
  const tm = await sharp(tall).metadata()
  check('a square fitted to 9:16 is exactly that size', tm.width === 540 && tm.height === 960)
  const { data } = await sharp(tall).raw().toBuffer({ resolveWithObject: true })
  const px = (x, y) => [data[(y * 540 + x) * 3], data[(y * 540 + x) * 3 + 1], data[(y * 540 + x) * 3 + 2]]
  // The whole cover is in the middle (its red top stripe at y = 210…234), bands of itself above and below.
  check('…with the whole picture in the middle', px(270, 222)[0] > 150 && px(270, 222)[2] < 90 && px(270, 480)[0] > 200, `${px(270, 222)} ${px(270, 480)}`)
  check('…over a darkened blur of itself (no black bars)', px(270, 60)[2] > 20 && px(270, 60)[2] < 120, String(px(270, 60)))
  const same = await sharp(await fitStill(cover, 600, 620)).metadata()
  check('a picture already near the shape is simply cropped', same.width === 600 && same.height === 620)
  const clip = await stillLoop(cover, { width: 270, height: 480, seconds: 2, fps: 15 })
  const secs = await videoSeconds(clip)
  check('renders an MP4 of the length asked for', clip.subarray(4, 8).toString() === 'ftyp' && Math.abs(secs - 2) < 0.15, secs.toFixed(2))
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\nall cassette-art checks passed')
