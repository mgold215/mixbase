#!/usr/bin/env node
// The colours a share page is lit with (src/lib/share-palette.ts), and the
// rules the two public players keep while they move (src/lib/share-fx.ts,
// src/components/ShareStage.tsx, the ".share-…" block of globals.css).
// Run: node scripts/share-palette-test.mjs

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  paletteFromPixels, DEFAULT_PALETTE, PENDING_PALETTE, rgbToHsl, hslToRgb, luminance,
} from '../src/lib/share-palette.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

let failures = 0
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
  else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures++ }
}

// ── Picture builders ────────────────────────────────────────────────────────
// A deterministic generator: the same pictures every run.
let seed = 7
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
const clamp8 = (v) => Math.max(0, Math.min(255, Math.round(v)))

/** `n` RGBA pixels around `rgb`, each channel wandering by ±spread. */
function field(rgb, n, spread = 14) {
  const out = []
  for (let i = 0; i < n; i++) {
    const k = (rand() - 0.5) * 2 * spread
    out.push(clamp8(rgb[0] + k), clamp8(rgb[1] + k * 0.9), clamp8(rgb[2] + k * 0.8), 255)
  }
  return out
}
const picture = (...parts) => new Uint8ClampedArray(parts.flat())
const hueOf = (rgb) => rgbToHsl(...rgb)[0]
const satOf = (rgb) => rgbToHsl(...rgb)[1]
const hueGap = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d) }
const isRgb = (c) => Array.isArray(c) && c.length === 3 && c.every(v => Number.isInteger(v) && v >= 0 && v <= 255)

console.log('share-palette: colour maths\n')
for (const c of [[200, 40, 40], [30, 90, 220], [240, 220, 60], [12, 12, 12], [250, 250, 250], [120, 70, 160]]) {
  const back = hslToRgb(...rgbToHsl(...c))
  check(`rgb → hsl → rgb round-trips ${c}`, back.every((v, i) => Math.abs(v - c[i]) <= 1), String(back))
}
check('luminance: black 0, white 1', luminance([0, 0, 0]) === 0 && Math.abs(luminance([255, 255, 255]) - 1) < 1e-9)

console.log('\nshare-palette: nothing to read\n')
check('no pixels → the default palette', paletteFromPixels(new Uint8ClampedArray(0)) === DEFAULT_PALETTE)
check('fully transparent → the default palette', paletteFromPixels(new Uint8ClampedArray(400)) === DEFAULT_PALETTE)
check('the pending palette carries no colour (lights stay down until a cover is read)',
  PENDING_PALETTE.muted && PENDING_PALETTE.glow.every(c => satOf(c) < 0.08))

// ── The owner's kind of cover ───────────────────────────────────────────────
// Earth, amber and cream: the averages below are measured off the real covers
// (2026-11-15). The old single "accent" was their average multiplied up — mud.
console.log('\nshare-palette: earthy covers come out as their own colour, lifted\n')
const EARTHY = {
  BUGONIA: [103, 70, 48],
  'CAPITAL HILL': [170, 123, 78],
  ERIS: [181, 128, 62],
  'ECHOES IN THE DUST': [152, 107, 84],
  GHOSTS: [124, 74, 63],
}
for (const [name, avg] of Object.entries(EARTHY)) {
  const p = paletteFromPixels(picture(field(avg, 900, 22)))
  const sourceHue = hueOf(avg)
  check(`${name}: not treated as colourless`, !p.muted)
  check(`${name}: main light keeps the cover's hue`, hueGap(hueOf(p.glow[0]), sourceHue) <= 14,
    `cover ${Math.round(sourceHue)}°, light ${Math.round(hueOf(p.glow[0]))}°`)
  check(`${name}: main light is more saturated than the cover`, satOf(p.glow[0]) > satOf(avg) + 0.08,
    `${satOf(avg).toFixed(2)} → ${satOf(p.glow[0]).toFixed(2)}`)
  // One colour family → its neighbours (gold, ember), never a stranger. 30°
  // from orange is an acid lime; the step is 18°.
  check(`${name}: the other two lights are near neighbours, not strangers`,
    p.glow.slice(1).every(c => hueGap(hueOf(c), hueOf(p.glow[0])) <= 22),
    p.glow.map(c => Math.round(hueOf(c)) + '°').join(' '))
  check(`${name}: no light is a green (the lime the first version made)`,
    p.glow.every(c => { const h = hueOf(c); return h < 62 || h > 180 }))
}

console.log('\nshare-palette: every light is bright enough to be one\n')
for (const [name, avg] of Object.entries({ 'BELLADONNA (dark olive)': [47, 46, 28], 'EVERGREEN (blue-black)': [38, 44, 70], 'deep maroon': [60, 12, 18] })) {
  const p = paletteFromPixels(picture(field(avg, 900, 10)))
  check(`${name}: lights sit in the band that glows on a dark page`,
    p.glow.every(c => { const l = rgbToHsl(...c)[2]; return l >= 0.4 && l <= 0.66 }),
    p.glow.map(c => rgbToHsl(...c)[2].toFixed(2)).join(' '))
  check(`${name}: accent carries a black play icon`, luminance(p.accent) >= 0.3, luminance(p.accent).toFixed(2))
}
// Deep blue is the hard case: vivid, and far too dark for a black triangle.
const blue = paletteFromPixels(picture(field([18, 28, 190], 900, 8)))
check('deep blue: accent is lifted toward white until it carries a black icon', luminance(blue.accent) >= 0.3,
  `${blue.accent} (${luminance(blue.accent).toFixed(2)})`)
check('deep blue: accent is still blue', hueGap(hueOf(blue.accent), 235) <= 20, `${Math.round(hueOf(blue.accent))}°`)

console.log('\nshare-palette: more than one colour\n')
// A blue sky over a red field: both are the picture.
const two = paletteFromPixels(picture(field([40, 110, 220], 600, 12), field([200, 50, 40], 300, 12)))
const twoHues = two.glow.map(hueOf)
check('two real colours: both are among the lights',
  twoHues.some(h => hueGap(h, 217) <= 16) && twoHues.some(h => hueGap(h, 4) <= 16), twoHues.map(Math.round).join('° ') + '°')
check('two real colours: the larger one leads', hueGap(twoHues[0], 217) <= 16)
// Three tiny stripes on a cassette label must not repaint the page — however
// saturated they are. (Pure red on a dull beige: by WEIGHT the red is a third
// of the picture, so it is the coverage rule alone that keeps it out.)
const stripes = paletteFromPixels(picture(field([186, 172, 152], 985, 5), field([238, 16, 16], 15, 3)))
check('a vivid colour covering 1.5% of the cover is not picked',
  stripes.glow.every(c => hueGap(hueOf(c), 0) > 12), stripes.glow.map(c => Math.round(hueOf(c)) + '°').join(' '))
check('a saturated colour covering 8% IS picked',
  paletteFromPixels(picture(field([186, 160, 120], 920, 10), field([30, 60, 220], 80, 6))).glow.some(c => hueGap(hueOf(c), 230) <= 16))

console.log('\nshare-palette: covers with no colour\n')
const grey = paletteFromPixels(picture(field([128, 128, 128], 900, 40).map((v, i) => (i % 4 === 3 ? 255 : v))
  .map((v, i, a) => (i % 4 === 1 || i % 4 === 2 ? a[i - (i % 4)] : v))))
check('black-and-white photograph: muted', grey.muted)
check('black-and-white photograph: lights are tinted neutrals', grey.glow.every(c => satOf(c) <= 0.3),
  grey.glow.map(c => satOf(c).toFixed(2)).join(' '))
check('black-and-white photograph: accent is a light neutral', luminance(grey.accent) >= 0.5 && satOf(grey.accent) <= 0.3)

console.log('\nshare-palette: how bright the cover is (the backdrop dims a pale one)\n')
const pale = paletteFromPixels(picture(field([226, 220, 208], 900, 8)))
const dark = paletteFromPixels(picture(field([30, 24, 20], 900, 6)))
check('pale cover: high tone', pale.tone > 0.6, pale.tone.toFixed(2))
check('dark cover: low tone', dark.tone < 0.05, dark.tone.toFixed(3))

console.log('\nshare-palette: shape\n')
for (const [name, p] of Object.entries({ default: DEFAULT_PALETTE, pending: PENDING_PALETTE, earthy: paletteFromPixels(picture(field([170, 123, 78], 400))), grey, blue })) {
  check(`${name}: accent, three lights and ink are whole 0–255 colours`,
    isRgb(p.accent) && p.glow.length === 3 && p.glow.every(isRgb) && isRgb(p.ink))
  check(`${name}: tone is a number in 0–1`, typeof p.tone === 'number' && p.tone >= 0 && p.tone <= 1)
}

// ── Rules the moving page keeps ─────────────────────────────────────────────
console.log('\nsource contracts\n')
const fx = read('src/lib/share-fx.ts')
const stage = read('src/components/ShareStage.tsx')
const css = read('src/app/globals.css')
const track = read('src/app/share/[token]/ShareClient.tsx')
const album = read('src/components/AlbumPlayer.tsx')

// iOS: an <audio> routed through an AudioContext goes silent when the screen
// locks. The analyser (and the kick branch hung off it) must never be built there.
check('share-fx: no AudioContext on iOS', /if \(!audio \|\| ctxRef\.current \|\| isIOS\(\)\) return/.test(fx))
check('share-fx: only ONE createMediaElementSource (a second would steal the element)',
  (fx.match(/createMediaElementSource\(/g) ?? []).length === 1)
check('share-fx: the kick branch ends in a gain of zero (never audible)', /mute\.gain\.value = 0/.test(fx))
check('share-fx: reduced motion stops the music loop', /prefers-reduced-motion: reduce\)'\)\.matches\) return/.test(fx))
check('share-fx: publishes --energy and --beat', /'--energy'/.test(fx) && /'--beat'/.test(fx))

// One stage, both pages — so they cannot drift apart in feel.
for (const [name, src] of [['ShareClient', track], ['AlbumPlayer', album]]) {
  check(`${name}: backdrop, cover and title come from ShareStage`,
    /import \{ ShareBackdrop, ShareCover, ShareTitle, stageStyle \} from '@\/components\/ShareStage'/.test(src))
  check(`${name}: colours come from the cover (useArtPalette)`, /useArtPalette\(/.test(src))
  check(`${name}: root is the stage`, /className="share-stage /.test(src) && /style=\{stageStyle\(palette\)\}/.test(src))
}

// The handwriting is the artist's file: shown as written. Effects are light on
// it — no filter that recolours the ink.
const hand = stage.slice(stage.indexOf('function HandwrittenTitle'), stage.indexOf('// Letters, not code units'))
check('ShareStage: handwriting ink is not recoloured (no hue-rotate / invert / sepia)',
  hand.length > 0 && !/hue-rotate|invert\(|sepia\(|grayscale\(/.test(hand))
check('ShareStage: the typed title keeps its accessible name', /aria-label=\{title\}/.test(stage))
check('ShareStage: the handwritten title keeps a real heading for screen readers', /<h1 className="sr-only">\{title\}<\/h1>/.test(stage))

// Per-frame work is opacity and transform only: a filter or a shadow whose
// value depends on --energy / --beat re-blurs every frame and drops a phone
// below 60 fps. (The play button's own box-shadow, a 80 px element, is the one
// exception and lives in the components, not here.)
const shareCss = css.slice(css.indexOf('/* ── Public share players'))
const heavy = shareCss.split('\n').filter(l => /^\s*(filter|box-shadow|backdrop-filter|-webkit-mask[a-z-]*|mask[a-z-]*)\s*:/.test(l) && /var\(--(energy|beat)\)/.test(l))
check('globals.css: no filter / shadow / mask is driven by --energy or --beat', heavy.length === 0, heavy.join(' | ').trim())

const reduced = shareCss.slice(shareCss.indexOf('@media (prefers-reduced-motion: reduce)'))
for (const sel of ['.share-aurora > i', '.share-grain', '.share-cover-float', '.share-cover-glint', '.share-title-shine', '.share-title-main .share-letter', '.share-title-late', '.share-hand-write']) {
  check(`reduced motion covers ${sel}`, reduced.includes(sel))
}
// Both entrances start invisible and are revealed by an animation; with the
// animation switched off they must be put back, or the title never appears.
check('reduced motion: letters are made visible', /\.share-title-main \.share-letter \{ animation: none; opacity: 1; \}/.test(reduced))
check('reduced motion: the write-in mask is removed', /\.share-hand-write \{ animation: none; -webkit-mask-image: none; mask-image: none; \}/.test(reduced))

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
