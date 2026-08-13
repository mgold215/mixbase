// /api/visualizer/finalize contract test — exercises the REAL pure helpers
// (src/lib/visualizer-finalize.ts via Node type stripping), no inline copies.
//
// Run: node scripts/viz-finalize-test.mjs
//
// The finalize route indexes objects the browser PUT directly into mf-video
// via signed URLs. Its storage-path gate is the ownership boundary: the key's
// first segment must be the caller's own (already-verified) projectId, the
// basename must be the viz-<stamp> shape clients generate, and the extension
// dispatches mp4-validate vs webm-transcode. These checks lock that gate.

import {
  MAX_FINALIZE_BYTES,
  MAX_FINALIZE_WEBM_BYTES,
  MIN_CLIP_SECONDS,
  MP4_PROBE_BYTES,
  parseVizStoragePath,
  sanitizeSettings,
} from '../src/lib/visualizer-finalize.ts'
import { defaultRecipe } from '../src/lib/fx/recipe.ts'

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const PID = '123e4567-e89b-42d3-a456-426614174000'
const OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

// ── parseVizStoragePath ─────────────────────────────────────────────────────

check('accepts an owned mp4 key', parseVizStoragePath(PID, `${PID}/viz-1755100000000.mp4`)?.ext === 'mp4')
check('accepts an owned webm key', parseVizStoragePath(PID, `${PID}/viz-1755100000000.webm`)?.ext === 'webm')

check("rejects another project's prefix", parseVizStoragePath(PID, `${OTHER}/viz-1755100000000.mp4`) === null)
check('rejects traversal', parseVizStoragePath(PID, `${PID}/../${OTHER}/viz-1.mp4`) === null)
check('rejects nested paths', parseVizStoragePath(PID, `${PID}/sub/viz-1.mp4`) === null)
check('rejects non-viz basenames', parseVizStoragePath(PID, `${PID}/audio-1.mp4`) === null)
check('rejects other extensions', parseVizStoragePath(PID, `${PID}/viz-1.mov`) === null)
check('rejects double extensions', parseVizStoragePath(PID, `${PID}/viz-1.mp4.webm`) === null)
check('rejects an empty stamp', parseVizStoragePath(PID, `${PID}/viz-.mp4`) === null)
check('rejects overlong paths', parseVizStoragePath(PID, `${PID}/viz-${'a'.repeat(200)}.mp4`) === null)
check('rejects non-strings', parseVizStoragePath(PID, 42) === null && parseVizStoragePath(PID, null) === null)
check('rejects query-ish suffixes', parseVizStoragePath(PID, `${PID}/viz-1.mp4?x=1`) === null)

// ── sanitizeSettings ────────────────────────────────────────────────────────

{
  const recipe = defaultRecipe('pulse', 'youtube', 99)
  const out = sanitizeSettings(JSON.parse(JSON.stringify(recipe)))
  check('round-trips a valid recipe', JSON.stringify(out) === JSON.stringify(recipe))
  check('nulls garbage', sanitizeSettings({ v: 9 }) === null && sanitizeSettings('x') === null)
  check('nulls absent settings', sanitizeSettings(undefined) === null && sanitizeSettings(null) === null)
  const clamped = sanitizeSettings({ ...recipe, scene: { id: 'pulse', params: { punch: 999 } } })
  check('clamps recipe params on the way in', clamped?.scene.params.punch === 2.5, `got ${clamped?.scene.params.punch}`)
}

// ── constants sanity (route + client budgets agree) ─────────────────────────

check('mp4 cap covers 4K exports with headroom', MAX_FINALIZE_BYTES === 200 * 1024 * 1024)
check('webm cap covers the 45 MB fallback ceiling', MAX_FINALIZE_WEBM_BYTES === 80 * 1024 * 1024)
check('minimum duration matches finalize-video', MIN_CLIP_SECONDS === 0.5)
check('probe window is faststart-sized', MP4_PROBE_BYTES === 2 * 1024 * 1024)

console.log(failures === 0 ? '\nAll viz-finalize tests passed' : `\n${failures} viz-finalize test(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
