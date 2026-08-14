// FX recipe/macro logic test — exercises the REAL production modules
// (src/lib/fx/recipe.ts + types.ts + upload.ts via Node type stripping), no
// inline copies.
//
// Run: node scripts/fx-test.mjs
//
// Covers the pure logic tier of the visualizer FX engine: recipe construction,
// macro→param resolution (neutral position must be an exact identity — that is
// what keeps the shipped default look untouched), and validateRecipe(), the
// only door for untrusted recipe data (localStorage drafts, later DB settings).
// The last section drives the real signed-URL save path against a stubbed
// fetch — that one is about retry semantics, not pure logic.

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
import { uploadVisualizer, VizUploadError } from '../src/lib/fx/upload.ts'

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

// A real mb_versions id shape — the audio segment only survives validation for
// one of these now.
const VERSION_ID = '3f1c8d2e-9a44-4b17-8f0e-6c2d51ab77e9'

{
  const r = validateRecipe({
    v: 1,
    format: 'youtube',
    resolution: 'high',
    scene: { id: 'pulse', params: {} },
    audio: { versionId: VERSION_ID, startSec: -4, bpm: 10, offsetSec: 0.2 },
  })
  check('4K sticks on youtube', r?.resolution === 'high')
  check('audio segment survives with a real version UUID', r?.audio?.versionId === VERSION_ID)
  check('audio segment sanitizes its numbers', r?.audio?.startSec === 0 && r?.audio?.bpm === 60 && r?.audio?.offsetSec === 0.2)
}

// ── audio.versionId must be a UUID ──────────────────────────────────────────
// The id is persisted into mb_visualizers.settings and phase 2 will resolve it
// against mb_versions. Until this landed, ANY string up to 64 chars round-tripped
// straight through validation into the database — every other id in the codebase
// goes through isUuid (src/lib/validators.ts).
{
  const base = defaultRecipe('pulse', 'canvas', 5)
  const withAudio = (versionId) =>
    validateRecipe({ ...base, audio: { versionId, startSec: 0, bpm: 120, offsetSec: 0 } })

  check('traversal-shaped versionId drops the audio segment',
    withAudio('../../etc')?.audio === null)
  check('plain non-UUID versionId drops the audio segment', withAudio('abc')?.audio === null)
  check('empty versionId drops the audio segment', withAudio('')?.audio === null)
  check('non-string versionId drops the audio segment',
    validateRecipe({ ...base, audio: { versionId: 42, startSec: 0, bpm: 120, offsetSec: 0 } })?.audio === null)
  check('a real UUID is kept', withAudio(VERSION_ID)?.audio?.versionId === VERSION_ID)
  check('uppercase UUIDs are accepted (Postgres emits lowercase, clients vary)',
    withAudio(VERSION_ID.toUpperCase())?.audio?.versionId === VERSION_ID.toUpperCase())
}

// ── isValidMod ──────────────────────────────────────────────────────────────

check(
  'isValidMod accepts a sane mod and rejects junk',
  isValidMod({ source: 'bass', target: 'punch', amount: 0.7 }) &&
    !isValidMod({ source: 'sub', target: 'punch', amount: 0.7 }) &&
    !isValidMod({ source: 'bass', target: 'punch', amount: 2 }) &&
    !isValidMod('bass'),
)

// ── Signed-URL save path: retry semantics ───────────────────────────────────
// Drives the REAL src/lib/fx/upload.ts against a stubbed fetch. Two shipped
// bugs are locked here, both of which only bite when a response is LOST (the
// bytes land, the answer doesn't) — the failure mode no happy-path test sees:
//
//  1. the PUT retry replayed the SAME signed URL. /api/upload-url signs with
//     `{ upsert: false }`, so the replay hit an already-written object and
//     failed: bytes in the bucket, no row, and the user told the save failed.
//  2. the /api/visualizer/finalize fetch was unwrapped, so a lost response
//     escaped uploadVisualizer and dropped the caller (FreeStudio.saveRendered)
//     into the legacy multipart re-upload — a SECOND copy of the bytes plus a
//     second row.

const PROJECT_ID = 'd41f9a02-77bc-4e63-9a1e-2b8c5f0d3a44'
// The shape /api/upload-url enforces server-side (VIZ_KEY_RE).
const VIZ_KEY = new RegExp(`^${PROJECT_ID}/viz-[A-Za-z0-9_-]{1,64}\\.mp4$`)

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// Run uploadVisualizer with `handler` standing in for the network. Returns the
// call log plus whatever the upload resolved/threw.
async function runUpload(handler) {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    // Only the JSON calls carry a parseable body — the PUT body is the Blob.
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    const kind = target === '/api/upload-url' ? 'sign'
      : target === '/api/visualizer/finalize' ? 'finalize'
        : 'put'
    calls.push({ kind, target, body })
    return handler(kind, { target, body, calls })
  }
  try {
    const result = await uploadVisualizer({
      blob: new Blob([new Uint8Array(1024)]),
      contentType: 'video/mp4',
      projectId: PROJECT_ID,
      title: 'Canvas · Pulse',
      settings: defaultRecipe('pulse', 'canvas', 9),
      sourceImageUrl: null,
    })
    return { calls, result, error: null }
  } catch (error) {
    return { calls, result: null, error }
  } finally {
    globalThis.fetch = realFetch
  }
}

{
  // First PUT and first finalize both lose their response; everything else works.
  let puts = 0
  let finalizes = 0
  const run = await runUpload((kind, { body }) => {
    if (kind === 'sign') return jsonResponse({ signedUrl: `https://storage.test/${body.filename}?token=${Date.now()}` })
    if (kind === 'put') {
      puts++
      if (puts === 1) throw new TypeError('Failed to fetch')
      return new Response('', { status: 200 })
    }
    finalizes++
    if (finalizes === 1) throw new TypeError('Failed to fetch')
    return jsonResponse({ id: 'row-1', video_url: 'https://storage.test/public/clip.mp4', transcoded: true })
  })

  const signs = run.calls.filter(c => c.kind === 'sign').map(c => c.body.filename)
  const puttedKeys = run.calls.filter(c => c.kind === 'put').map(c => c.target)
  const claims = run.calls.filter(c => c.kind === 'finalize').map(c => c.body.storagePath)

  check('a lost PUT response is retried once', puttedKeys.length === 2, `${puttedKeys.length} PUT(s)`)
  check('the retry requests a FRESH signed url', signs.length === 2, `${signs.length} signing call(s)`)
  check('the retry writes a NEW key (a replay would hit upsert:false)',
    signs.length === 2 && signs[0] !== signs[1], signs.join(' -> '))
  check('every minted key keeps the server-enforced viz shape', signs.every(k => VIZ_KEY.test(k)), signs.join(', '))
  check('the PUTs target the two distinct signed urls',
    puttedKeys.length === 2 && puttedKeys[0] !== puttedKeys[1])
  check('a lost finalize response retries the claim instead of escaping', claims.length === 2)
  check('the claim names the key that actually received the bytes',
    claims.every(p => p === signs[signs.length - 1]), claims.join(', '))

  // The retry writes a NEW key, so when the first PUT actually delivered and
  // only its response was lost, those bytes are real, unreferenced, and
  // unreachable by every other cleanup path (DELETE /api/visualizer/[id] and
  // account deletion both derive their key from an mb_visualizers row that was
  // never written). Reporting the abandoned key in the claim is the only thing
  // that collects it — /api/visualizer/finalize re-validates it against the
  // caller's own project and deletes it under the same reference check that
  // guards the claimed object.
  const abandoned = run.calls.filter(c => c.kind === 'finalize').map(c => c.body.abandonedPaths)
  check('the claim reports the abandoned first key so the server can sweep it',
    abandoned.every(list => Array.isArray(list) && list.length === 1 && list[0] === signs[0]),
    JSON.stringify(abandoned))
  check('…and never reports the key it is actually claiming',
    abandoned.every(list => !list?.includes(signs[signs.length - 1])), JSON.stringify(abandoned))
  check('the save reports success rather than falling back to a re-upload',
    !run.error && run.result?.video_url === 'https://storage.test/public/clip.mp4',
    run.error ? String(run.error.message) : 'ok')
}

{
  // The ordinary path: one signing, one PUT, one claim, nothing abandoned. The
  // sweep list must stay empty here or every successful save would ask the
  // server to look up keys that were never written.
  const run = await runUpload((kind, { body }) => {
    if (kind === 'sign') return jsonResponse({ signedUrl: `https://storage.test/${body.filename}` })
    if (kind === 'put') return new Response('', { status: 200 })
    return jsonResponse({ id: 'row-1', video_url: 'https://storage.test/public/clip.mp4', transcoded: true })
  })
  const claim = run.calls.find(c => c.kind === 'finalize')?.body
  check('a clean save abandons nothing',
    Array.isArray(claim?.abandonedPaths) && claim.abandonedPaths.length === 0,
    JSON.stringify(claim?.abandonedPaths))
}

{
  // A DEFINITIVE rejection must not retry: re-PUTting after a 403 would just
  // spend the user's bandwidth twice on a policy failure.
  const run = await runUpload((kind, { body }) => {
    if (kind === 'sign') return jsonResponse({ signedUrl: `https://storage.test/${body.filename}` })
    if (kind === 'put') return new Response('denied', { status: 403 })
    return jsonResponse({ error: 'should never be reached' }, 500)
  })
  check('a 403 on the PUT fails fast without a second upload',
    run.calls.filter(c => c.kind === 'put').length === 1)
  check('…and never signs a second key', run.calls.filter(c => c.kind === 'sign').length === 1)
  check('…and surfaces a user-presentable VizUploadError',
    run.error instanceof VizUploadError && /403/.test(run.error.message),
    run.error ? run.error.message : 'resolved')
}

console.log(failures === 0 ? '\nAll fx tests passed' : `\n${failures} fx test(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
