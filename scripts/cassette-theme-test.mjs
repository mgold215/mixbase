#!/usr/bin/env node
// Contract test for the Cassette Studio THEME — the owner's saved recipe that
// every release is rendered in (src/lib/cassette-theme.ts).
//
// The theme lives in a storage KEY (the bucket takes images only). What can
// silently break it: a key that does not round-trip (a release rendered with
// the wrong framing or look), a look code that decodes to something else, a
// key that passes for another user's, and the lettering text a song is
// typed with (the title, or artist + title, never an empty line).
//
// Run: node scripts/cassette-theme-test.mjs  (also part of `npm test`)

import { parseThemeKey, themeKey, themeLetteringText, themeToJson } from '../src/lib/cassette-theme.ts'
import { FILTER_PRESETS, IDENTITY_FILTER, decodeFilter, encodeFilter } from '../src/lib/cover-filters.ts'

let failures = 0
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`)
  else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures++ }
}

const me = '11111111-2222-4333-8444-555555555555', them = '99999999-2222-4333-8444-555555555555'
const look = { ...FILTER_PRESETS[1].settings, preset: FILTER_PRESETS[1].id, brightness: 12, grain: 30 }
const theme = {
  subjectTs: '1790000000000',
  placement: { x: 0.3, y: 0.88, scale: null },
  lettering: 'artist-title',
  align: 'left',
  color: '#F4F1EA',
  position: 'bottom-right',
  size: 'large',
  filter: look,
  formats: ['canvas', 'youtube'],
  clipTitle: false,
}

console.log('theme key')
{
  const key = themeKey(me, theme, 1790000001234)
  check('key is a studio PNG under the owner', key.startsWith(`studio/${me}/theme-1790000001234-`) && key.endsWith('.png'), key)
  const p = parseThemeKey(key, me)
  check('round-trips the subject', p?.subjectTs === '1790000000000')
  check('round-trips placement (percents; auto stays auto)', p && p.placement.x === 0.3 && p.placement.y === 0.88 && p.placement.scale === null, JSON.stringify(p?.placement))
  check('round-trips lettering mode + alignment', p?.lettering === 'artist-title' && p?.align === 'left')
  check('round-trips the ink colour (lower-cased hex)', p?.color === '#f4f1ea', p?.color)
  check('round-trips position + size', p?.position === 'bottom-right' && p?.size === 'large')
  check('round-trips the look', p?.filter && encodeFilter(p.filter) === encodeFilter(look), p?.filter && encodeFilter(p.filter))
  check('round-trips the clip formats in order', JSON.stringify(p?.formats) === JSON.stringify(['canvas', 'youtube']))
  check('round-trips the clip-title flag', p?.clipTitle === false)
  check('carries its save time', p?.ts === '1790000001234')

  const plain = themeKey(me, { ...theme, filter: null, formats: [], color: 'auto', clipTitle: true }, 1790000001234)
  const q = parseThemeKey(plain, me)
  check('no look, no clips, auto colour', q && q.filter === null && q.formats.length === 0 && q.color === 'auto' && q.clipTitle === true, plain)
  const ident = parseThemeKey(themeKey(me, { ...theme, filter: IDENTITY_FILTER }, 1790000001234), me)
  check('an identity look is still a look code (saving "Original" is explicit)', ident !== null && ident.filter !== null && encodeFilter(ident.filter) === encodeFilter(IDENTITY_FILTER))
  check('duplicate formats collapse', JSON.stringify(parseThemeKey(themeKey(me, { ...theme, formats: ['canvas', 'canvas', 'story'] }, 1790000001234), me)?.formats) === JSON.stringify(['canvas', 'story']))
  check('a save time that is not a stamp cannot be parsed back', parseThemeKey(themeKey(me, theme, 1), me) === null)

  check("another user's theme is not mine", parseThemeKey(key, them) === null)
  check('a subject key is not a theme', parseThemeKey(`studio/${me}/subject-1790000000000.png`, me) === null)
  check('a bad look code is rejected, not guessed', parseThemeKey(key.replace(/-f[0-9a-z]+-m/, '-fzzzzzzzzzzzzzzzzzzzzzz-m'), me) === null)
  check('an unknown position is rejected', parseThemeKey(key.replace('bottom-right', 'middle'), me) === null)
  check('a placement over 100% is rejected', parseThemeKey(key.replace('-p30-88-a', '-p300-88-a'), me) === null)
  let threw = false
  try { themeKey(me, { ...theme, subjectTs: 'abc' }, 1790000001234) } catch { threw = true }
  check('a malformed subject stamp cannot be saved', threw)
  check('decodeFilter still agrees with the embedded code', decodeFilter(encodeFilter(look)) !== null)
}

console.log('\ntheme json')
{
  const j = themeToJson(me, { ...theme, ts: '1790000001234' })
  check('subject is the full studio key', j.subject === `studio/${me}/subject-1790000000000.png`)
  check('placement fields are flat', j.place_x === 0.3 && j.place_y === 0.88 && j.place_scale === null)
  check('saved_at is an ISO time', j.saved_at === new Date(1790000001234).toISOString())
}

console.log('\nlettering text')
{
  check('title mode letters the title', themeLetteringText('title', '  Not 2  Late ', 'moodmixformat') === 'Not 2 Late')
  check('artist-title mode stacks artist over title', themeLetteringText('artist-title', 'Not 2 Late', 'moodmixformat') === 'moodmixformat\nNot 2 Late')
  check('a missing artist name falls back to the title alone', themeLetteringText('artist-title', 'Not 2 Late', '  ') === 'Not 2 Late')
  check('existing and none letter nothing typed', themeLetteringText('existing', 'x', 'y') === null && themeLetteringText('none', 'x', 'y') === null)
  check('an empty title is null, never an empty line', themeLetteringText('title', '   ', 'a') === null)
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\nall cassette-theme checks passed')
