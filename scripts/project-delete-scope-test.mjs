// DELETE /api/projects/[id] storage-scoping contract test.
//
// Run: node scripts/project-delete-scope-test.mjs
//
// THE BUG THIS EXISTS FOR
// The account-delete path has run TWO independent filters over its candidate
// keys since the cross-account leak was closed: the key-shape filter
// (filterToOwnedPrefixes) and the survivor scan. filterToOwnedPrefixes' own
// docstring says the two "cover different halves and both run".
//
// DELETE /api/projects/[id] ran only the scan. delete-account-scope-test.mjs
// asserted the pair for `removeAccountAssets` and nothing asserted it for
// `removeProjectAssets`, so the sibling route sat one function away from a
// green suite while missing half the protection. That is the gap this file
// closes — the property is owned per removal path, not per repo.
//
// WHY THE SCAN ALONE IS NOT ENOUGH HERE
// PATCH /api/projects/[id] accepts artwork_url and instrumental_url as any
// isSupabaseStorageUrl() — protocol and hostname only, no ownership check.
// (The visualizer pins in the same handler DO verify mb_visualizers.user_id;
// these two do not.) So a user can point a throwaway project of their own at a
// stranger's object and delete that project. The scan cannot see it:
//   * pass 1 matches EXACT URLs, and an UNREFERENCED object — a superseded
//     `finalized-<ts>.jpg`, an unpicked `ai-<ts>.webp` — has no surviving row;
//   * pass 2's prefix match is scoped to the project BEING DELETED, so it never
//     looks under the victim's prefix.
// Key shape settles it with no query. Hence both filters.
//
// WHY THE KEY-SHAPE FILTER CANNOT BE THE ONLY FILTER
// mf-audio holds ~121 BUCKET-ROOT objects that name no project at all (most are
// plain human filenames from a pre-prefix era). keyProjectId returns null for
// them, so they pass the shape filter untouched and are judged by the scan
// alone. A filter demanding a project-id prefix would refuse to delete a user's
// own root uploads, stranding them in a PUBLIC bucket. Asserted directly below.
//
// Layers:
//   A) The real pure functions composed exactly as the route composes them,
//      against a crafted cross-project attack — including a NEGATIVE CONTROL
//      that re-runs the same fixture WITHOUT the shape filter and requires the
//      victim's bytes to die, so these checks can never pass vacuously.
//   B) Source contracts over removeProjectAssets for what a pure test cannot
//      see: that both filters are wired, that the shape filter is scoped to the
//      project being deleted, and that removal spends the subtracted set.
//
// Pure — no DB, no network.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { stripComments, functionBody } from './source-contract.mjs'
import {
  AUDIO_BUCKET,
  ARTWORK_BUCKET,
  collectAssetKeys,
  collectAssetUrls,
  filterToOwnedPrefixes,
  scanSurvivingKeys,
  keysSafeToDelete,
} from '../src/lib/project-assets.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const SB = 'https://mdefkqaawrusoaojstpq.supabase.co'
// PA — the project being deleted. PB — a victim's project, a different owner.
const PA = 'b0642fc1-e7ab-4171-83d7-85b6f11a8742'
const PB = '727255a7-fd23-42f9-aa7c-63acf9898093'
const artUrl = (k) => `${SB}/storage/v1/object/public/mf-artwork/${k}`
const audioUrl = (k) => `${SB}/storage/v1/object/public/mf-audio/${k}`

// A select that answers the scan from a per-column table.
function fakeSelect(rowsByColumn = {}) {
  return async (_table, column, urls) =>
    (rowsByColumn[column] ?? []).filter(r => urls.includes(r[column]))
}

// ── A) The pipeline, composed from the real functions ───────────────────────
console.log('— cross-project attack, composed as the route composes it —')

// The victim's LIVE cover — a surviving row still names it, so the scan can see
// this one on its own.
const victimLive = `${PB}/live-cover.jpg`
// The victim's SUPERSEDED render — nothing names it. Invisible to the scan.
// This is the object the shape filter exists for.
const victimOrphan = `${PB}/finalized-old.jpg`
// A bucket-root upload of the deleting project's own. Names no project, so only
// the scan can clear it — it MUST still be deleted or GDPR erasure regresses.
const ownRoot = 'HALFWAY - MIX 1.wav'

// The rows DELETE /api/projects/[id] enumerates for the project it is deleting.
const rows = {
  projects: [{
    artwork_url: artUrl(victimLive),                 // crafted via PATCH
    finalized_artwork_url: artUrl(`${PA}/finalized-1.jpg`),
    instrumental_url: audioUrl(victimOrphan.replace('.jpg', '.wav')), // crafted
  }],
  versions: [
    { audio_url: audioUrl(ownRoot) },                // own legacy root upload
    { audio_url: audioUrl(`${PA}/mix.wav`) },        // own web upload
  ],
  visualizers: [{ source_image_url: artUrl(victimOrphan) }], // crafted
}

const collected = collectAssetKeys(rows)
const candidateUrls = collectAssetUrls(rows)
const select = fakeSelect({ artwork_url: [{ artwork_url: artUrl(victimLive) }] })

// Run the pipeline BOTH ways off the same fixture: with the shape filter (what
// the route must do) and without it (what the route used to do).
async function runPipeline({ withShapeFilter }) {
  const candidates = withShapeFilter ? filterToOwnedPrefixes(collected, [PA]) : collected
  const scan = await scanSurvivingKeys(select, candidateUrls)
  return { doomed: keysSafeToDelete(candidates, scan), scan }
}

const fixed = await runPipeline({ withShapeFilter: true })
const broken = await runPipeline({ withShapeFilter: false })

const dArt = fixed.doomed[ARTWORK_BUCKET]
const dAudio = fixed.doomed[AUDIO_BUCKET]

check('the victim\'s LIVE cover is NOT deleted',
  !dArt.includes(victimLive), JSON.stringify(dArt))

// The load-bearing case: no surviving row names this, so the scan alone would
// hand a stranger's bytes to storage.remove().
check('the victim\'s UNREFERENCED superseded render is NOT deleted',
  !dArt.includes(victimOrphan) && !fixed.scan.survivors[ARTWORK_BUCKET].includes(victimOrphan),
  `doomed=${JSON.stringify(dArt)}`)

check('a crafted instrumental_url under the victim\'s prefix is NOT deleted',
  !dAudio.some(k => k.startsWith(`${PB}/`)), JSON.stringify(dAudio))

check('the deleted project\'s OWN prefixed artwork IS still deleted',
  dArt.includes(`${PA}/finalized-1.jpg`), JSON.stringify(dArt))

check('the deleted project\'s OWN prefixed audio IS still deleted',
  dAudio.includes(`${PA}/mix.wav`), JSON.stringify(dAudio))

// The half the shape filter must NOT break: an unattributable root key.
check('the deleted project\'s OWN bucket-root audio IS still deleted (no GDPR regression)',
  dAudio.includes(ownRoot), JSON.stringify(dAudio))

// ── NEGATIVE CONTROL ────────────────────────────────────────────────────────
// If these pass, the checks above are not vacuous: the same fixture, run the
// old way, really does destroy the victim's bytes. A future refactor that makes
// filterToOwnedPrefixes a no-op fails HERE even if it somehow satisfied the
// assertions above.
console.log('\n— negative control: the same fixture without the shape filter —')

check('NEGATIVE CONTROL: without the shape filter the victim\'s superseded render IS deleted',
  broken.doomed[ARTWORK_BUCKET].includes(victimOrphan),
  JSON.stringify(broken.doomed[ARTWORK_BUCKET]))

check('NEGATIVE CONTROL: without the shape filter a crafted instrumental_url IS deleted',
  broken.doomed[AUDIO_BUCKET].some(k => k.startsWith(`${PB}/`)),
  JSON.stringify(broken.doomed[AUDIO_BUCKET]))

// And the filter must be doing this by SHAPE, not by deleting less in general.
check('NEGATIVE CONTROL: the filter removes only foreign-prefixed keys, nothing else',
  broken.doomed[AUDIO_BUCKET].includes(ownRoot) && dAudio.includes(ownRoot)
  && broken.doomed[ARTWORK_BUCKET].includes(`${PA}/finalized-1.jpg`)
  && dArt.includes(`${PA}/finalized-1.jpg`))

// ── B) Source contracts over the route ──────────────────────────────────────
console.log('\n— route wiring —')

const routeSrc = stripComments(read('src/app/api/projects/[id]/route.ts'))
const removeFn = functionBody(routeSrc, 'async function removeProjectAssets')

check('the removal helper was located', removeFn.length > 0, `${removeFn.length} chars`)

// The property, stated as the pair rather than as one call: BOTH halves run.
check('the removal helper runs BOTH filters — key shape and survivor scan',
  /filterToOwnedPrefixes\(/.test(removeFn) && /survivingAssetKeys\(/.test(removeFn),
  `shape=${/filterToOwnedPrefixes\(/.test(removeFn)} scan=${/survivingAssetKeys\(/.test(removeFn)}`)

// Scoped to the project being deleted. Passing a wider owned set (or a literal)
// would silently re-admit another project's prefix.
check('the key-shape filter is scoped to the project being deleted',
  /filterToOwnedPrefixes\(\s*candidates\s*,\s*\[\s*id\s*\]\s*\)/.test(removeFn),
  removeFn.match(/filterToOwnedPrefixes\([^)]*\)/)?.[0] ?? 'not found')

// Order matters: filtering AFTER the subtraction would let the scan's coverage
// rule spend keys the shape filter should already have removed.
const iFilter = removeFn.indexOf('filterToOwnedPrefixes(')
const iSafe = removeFn.indexOf('keysSafeToDelete(')
check('the key-shape filter runs BEFORE the subtraction',
  iFilter >= 0 && iSafe >= 0 && iFilter < iSafe, `filter=${iFilter} subtract=${iSafe}`)

// The keys handed to storage are the SUBTRACTED set — passing raw candidates
// would make both filters decorative.
check('the removal loop spends the subtracted set, not the raw candidates',
  /const paths = doomed\[bucket\]/.test(removeFn) && !/const paths = candidates\[bucket\]/.test(removeFn))

check('the removal helper does not subtract around the coverage rule',
  !/subtractKeys\(/.test(removeFn))

check('removal goes through the VERIFYING helper, not a raw .remove()',
  /removeStorageObjectsLogged\(/.test(removeFn) && !/storage\.from\([^)]*\)\.remove\(/.test(removeFn))

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
