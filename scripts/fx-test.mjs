// FX recipe/macro logic test — exercises the REAL production modules
// (src/lib/fx/recipe.ts + types.ts via Node type stripping), no inline copies.
//
// Run: node scripts/fx-test.mjs
//
// Covers the pure logic tier of the visualizer FX engine: recipe construction,
// macro→param resolution (neutral position must be an exact identity — that is
// what keeps the shipped default look untouched), and validateRecipe(), the
// only door for untrusted recipe data (localStorage drafts, later DB settings).

import { EFFECTS, resolveParams } from '../src/lib/free-effects.ts'
import {
  DEFAULT_BPM,
  MACROS,
  applyMacros,
  defaultRecipe,
  isValidMod,
  macroMultiplier,
  neutralMacros,
  validateRecipe,
} from '../src/lib/fx/recipe.ts'
import { RECIPE_MAX_JSON_BYTES } from '../src/lib/fx/types.ts'

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// ── Macro math ──────────────────────────────────────────────────────────────

check('macroMultiplier(0.5) is exactly 1 (neutral)', macroMultiplier(0.5) === 1)
check('macroMultiplier(0) halves', Math.abs(macroMultiplier(0) - 0.5) < 1e-12)
check('macroMultiplier(1) doubles', Math.abs(macroMultiplier(1) - 2) < 1e-12)
check('macroMultiplier clamps outside 0..1', macroMultiplier(7) === macroMultiplier(1) && macroMultiplier(-3) === macroMultiplier(0))
check('three macros defined with targets', MACROS.length === 3 && MACROS.every((m) => m.targets.length > 0))

{
  const base = resolveParams(EFFECTS.pulse.params)
  const neutral = applyMacros('pulse', undefined, neutralMacros())
  check(
    'neutral macros are an exact identity',
    Object.keys(base).every((k) => neutral[k] === base[k]),
  )
  const energetic = applyMacros('pulse', undefined, { energy: 1 })
  check('energy=1 doubles pulse punch', energetic.punch === 2, `got ${energetic.punch}`)
  check('energy leaves motion-family params alone', energetic.sharpness === base.sharpness)
}

{
  // drone zoom spec caps at 1.6 — motion=1 would double 1 → 2, must clamp.
  const wild = applyMacros('drone', undefined, { motion: 1 })
  check('macro results re-clamp to the spec range', wild.zoom === 1.6, `got ${wild.zoom}`)
}

{
  const toggled = applyMacros('kenburns', { letterbox: true }, { energy: 1, motion: 1, texture: 1 })
  check('macros never touch toggle params', toggled.letterbox === true)
}

{
  // Macros scale the USER's base value, not the default.
  const scaled = applyMacros('pulse', { punch: 0.5 }, { energy: 1 })
  check('macros scale the explicit base value', scaled.punch === 1, `got ${scaled.punch}`)
}

// ── defaultRecipe ───────────────────────────────────────────────────────────

{
  const r = defaultRecipe('kenburns', 'canvas', 1234)
  check(
    'defaultRecipe has the v1 shape',
    r.v === 1 && r.fps === 30 && r.resolution === 'standard' && r.format === 'canvas' &&
      r.fx.length === 0 && r.audio === null && r.bpm === DEFAULT_BPM && r.seed === 1234,
  )
  check('defaultRecipe fills canonical scene params', r.scene.params.zoom === 1 && r.scene.params.vignette === 0.42)
  check('a full recipe sits far under the size cap', JSON.stringify(r).length < RECIPE_MAX_JSON_BYTES / 4)
}

// ── validateRecipe ──────────────────────────────────────────────────────────

{
  const r = defaultRecipe('glitch', 'youtube', 77)
  const round = validateRecipe(JSON.parse(JSON.stringify(r)))
  check('validateRecipe round-trips a default recipe', JSON.stringify(round) === JSON.stringify(r))
}

check('validateRecipe rejects non-objects', validateRecipe(null) === null && validateRecipe('x') === null && validateRecipe([1]) === null)
check('validateRecipe rejects future versions', validateRecipe({ ...defaultRecipe('pulse', 'canvas', 1), v: 2 }) === null)
check('validateRecipe rejects unknown scene effects', validateRecipe({ v: 1, scene: { id: 'nope' } }) === null)

{
  const r = validateRecipe({
    v: 1,
    format: 'weird',
    scene: { id: 'kenburns', params: { zoom: 99, junk: 3, grain: 'red' } },
    macros: { energy: 7, motion: -2, bogus: 1 },
    seed: 3.9,
    bpm: 999,
    resolution: 'high',
    palette: { colors: ['#aabbcc', 'red', '#123456', 42], locked: 'yes' },
    audio: { versionId: 'v'.repeat(100) },
  })
  check('unknown format falls back to canvas', r?.format === 'canvas')
  check('scene params clamp to spec range', r?.scene.params.zoom === 3)
  check('unknown scene params are dropped', r ? !('junk' in r.scene.params) : false)
  check('wrong-typed scene params fall back to defaults', r?.scene.params.grain === 0.07)
  check('macros clamp to 0..1 and drop unknown ids', r?.macros.energy === 1 && r?.macros.motion === 0 && r ? !('bogus' in r.macros) : false)
  check('seed truncates to uint32', r?.seed === 3)
  check('bpm clamps to 60..200', r?.bpm === 200)
  check("4K resolution is youtube-only", r?.resolution === 'standard')
  check('palette keeps only #rrggbb strings', r?.palette.colors.length === 2 && r?.palette.locked === false)
  check('oversized audio versionId is discarded', r?.audio === null)
}

{
  const r = validateRecipe({
    v: 1,
    format: 'youtube',
    resolution: 'high',
    scene: { id: 'pulse', params: {} },
    audio: { versionId: 'abc', startSec: -4, bpm: 10, offsetSec: 0.2 },
  })
  check('4K sticks on youtube', r?.resolution === 'high')
  check('audio segment sanitizes its numbers', r?.audio?.startSec === 0 && r?.audio?.bpm === 60 && r?.audio?.offsetSec === 0.2)
}

// ── isValidMod ──────────────────────────────────────────────────────────────

check(
  'isValidMod accepts a sane mod and rejects junk',
  isValidMod({ source: 'bass', target: 'punch', amount: 0.7 }) &&
    !isValidMod({ source: 'sub', target: 'punch', amount: 0.7 }) &&
    !isValidMod({ source: 'bass', target: 'punch', amount: 2 }) &&
    !isValidMod('bass'),
)

console.log(failures === 0 ? '\nAll fx tests passed' : `\n${failures} fx test(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
