// mf-video key-shape contract test — the one regex that decides both what may
// be WRITTEN into the bucket and what may be DELETED out of it.
//
// Run: node scripts/viz-key-shape-test.mjs
//
// WHY THIS EXISTS
// VIZ_KEY_RE (src/lib/visualizer-finalize.ts) wears two hats:
//   * a GATE — /api/upload-url refuses to sign an mf-video key outside it, and
//     /api/visualizer/finalize refuses to claim one;
//   * a RECOGNIZER — planReap (src/lib/video-orphan-plan.ts) counts every object
//     outside it as keptForeignShape and never deletes it.
// The two roles pull opposite ways. Widening the regex is the only way to make
// the sweep collect a new shape, and it is also the only way to make the sweep
// eligible to delete something it currently protects. Narrowing it is safe for
// deletion and dangerous for coverage: a key the app can WRITE but the sweep
// cannot RECOGNIZE has no cleanup path anywhere in the codebase — invisible in
// Media, unnameable by DELETE /api/visualizer/[id] (it derives its key from a
// row's video_url), missed by /api/auth/delete-account (it starts from rows),
// and skipped by the sweep that exists for exactly this case.
//
// THE DEFECT THIS FILE PINS. The finalize webm lane DERIVES a second key from
// the claimed one: mp4TwinPath() appends '-h264' to the basename. A claim whose
// stamp already filled the regex's 64-character budget produced a 65-69
// character twin — written by this app, unrecognized by this app, unreapable
// forever. The fix bounds the CLAIM (VIZ_WEBM_STAMP_MAX) and leaves the
// recognizer untouched, so nothing already in the bucket changes classification
// and the sweep gains no new licence to delete. The assertions below are what
// hold that shape in place, over the real production key census.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { functionBody, stripComments } from './source-contract.mjs'
import {
  VIZ_KEY_RE,
  VIZ_STAMP_MAX,
  VIZ_TWIN_SUFFIX,
  VIZ_WEBM_STAMP_MAX,
  parseVizStoragePath,
} from '../src/lib/visualizer-finalize.ts'
import { mp4TwinPath, webmOriginalPath } from '../src/lib/visualizer-encode.ts'
import { planReap, REAP_MIN_AGE_MS } from '../src/lib/video-orphan-plan.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// ── The regex as it stood before the bound was introduced ───────────────────
// Verbatim, so the "did any real key change classification?" comparison below is
// an actual before/after and not a restatement of the current code. The only
// edit the fix made to this literal was adding a capture group around the stamp;
// capture groups cannot change what a pattern MATCHES, and the corpus below is
// what proves it rather than asserting it by assumption.
const OLD_VIZ_KEY_RE = /^([0-9a-f-]{36})\/viz-[A-Za-z0-9_-]{1,64}\.(mp4|webm)$/

// ── The production census ───────────────────────────────────────────────────
// Every object in the mf-video bucket, verbatim from
//   select name from storage.objects where bucket_id = 'mf-video' order by name
// run against project mdefkqaawrusoaojstpq on 2026-08-17 (83 rows, oldest
// 2026-07-02, newest 2026-08-14). This is a dated snapshot kept as evidence: the
// gate below is TIGHTER than the one that was live when these were written, so
// the question "does any object that exists today stop being claimable, or stop
// being recognized?" has to be answered against the real population, not against
// invented keys.
const CENSUS = [
  '04b6b309-0e24-49cd-ae1e-6766175d311b/viz-1783768189349-h264.mp4',
  '04b6b309-0e24-49cd-ae1e-6766175d311b/viz-1783768189349.webm',
  '04b6b309-0e24-49cd-ae1e-6766175d311b/viz-1784558373779-h264.mp4',
  '04b6b309-0e24-49cd-ae1e-6766175d311b/viz-1784558373779.webm',
  '10c01454-d785-4b58-9782-61c45cc9e294/viz-1784379334429-h264.mp4',
  '10c01454-d785-4b58-9782-61c45cc9e294/viz-1784379334429.webm',
  '10c01454-d785-4b58-9782-61c45cc9e294/viz-1784381054633-h264.mp4',
  '10c01454-d785-4b58-9782-61c45cc9e294/viz-1784381054633.webm',
  '13420800-de8f-418e-b882-a1be9dfbb543/viz-1786736865181.mp4',
  '13420800-de8f-418e-b882-a1be9dfbb543/viz-1786736878272.mp4',
  '13420800-de8f-418e-b882-a1be9dfbb543/viz-1786736912143.mp4',
  '13420800-de8f-418e-b882-a1be9dfbb543/viz-1786736941928.mp4',
  '13420800-de8f-418e-b882-a1be9dfbb543/viz-1786736959981.mp4',
  '13420800-de8f-418e-b882-a1be9dfbb543/viz-1786736978901.mp4',
  '13420800-de8f-418e-b882-a1be9dfbb543/viz-1786736996721.mp4',
  '13420800-de8f-418e-b882-a1be9dfbb543/viz-1786737011892.mp4',
  '29460c0b-7e77-49cd-9f45-63bcd281e45b/viz-1784118130276-h264.mp4',
  '29460c0b-7e77-49cd-9f45-63bcd281e45b/viz-1784118130276.webm',
  '29e6f208-3f3a-430e-a4a0-ad6bc114da4b/viz-1786579683793.mp4',
  '29e6f208-3f3a-430e-a4a0-ad6bc114da4b/viz-1786579694866.mp4',
  '311cce90-fdf8-4908-8ac1-b8dfb36e74a4/viz-1784117448778-h264.mp4',
  '311cce90-fdf8-4908-8ac1-b8dfb36e74a4/viz-1784117448778.webm',
  '3717c702-2d86-436a-a0bc-1ed94da93d4a/viz-1784311833635-h264.mp4',
  '3717c702-2d86-436a-a0bc-1ed94da93d4a/viz-1784311833635.webm',
  '3717c702-2d86-436a-a0bc-1ed94da93d4a/viz-1784312720675.mp4',
  '375fce07-09c4-4ae9-89eb-50183e3363fb/viz-1783788784879-h264.mp4',
  '375fce07-09c4-4ae9-89eb-50183e3363fb/viz-1783788784879.webm',
  '378a60a2-8d10-44ff-babc-786bc972ac4a/viz-1783613324633-h264.mp4',
  '378a60a2-8d10-44ff-babc-786bc972ac4a/viz-1783613324633.webm',
  '3b0a52f6-11bf-4627-899a-74c3f844dcb4/viz-1785071575038-h264.mp4',
  '3b0a52f6-11bf-4627-899a-74c3f844dcb4/viz-1785071575038.webm',
  '49bf64d7-a571-448d-8b7e-4e432687646c/viz-1783033371134.mp4',
  '49bf64d7-a571-448d-8b7e-4e432687646c/viz-1783033609250.mp4',
  '4b424f6d-75d6-4f2b-86ad-ba3804531e6c/viz-1786146604801.mp4',
  '511c7996-af93-44bf-a4b7-2adb03b32252/viz-1783708812307-h264.mp4',
  '511c7996-af93-44bf-a4b7-2adb03b32252/viz-1783708812307.webm',
  '5639d2a6-c0fe-4822-82f8-2341187d3701/viz-1784118188146-h264.mp4',
  '5639d2a6-c0fe-4822-82f8-2341187d3701/viz-1784118188146.webm',
  '59d0213f-7a75-4fb4-8257-bcbaebb7046e/viz-1786146699655.mp4',
  '727255a7-fd23-42f9-aa7c-63acf9898093/viz-1784223743271.mp4',
  '727255a7-fd23-42f9-aa7c-63acf9898093/viz-1784227071842.mp4',
  '727255a7-fd23-42f9-aa7c-63acf9898093/viz-1784311335517-h264.mp4',
  '727255a7-fd23-42f9-aa7c-63acf9898093/viz-1784311335517.webm',
  '727255a7-fd23-42f9-aa7c-63acf9898093/viz-1784311648018.mp4',
  '727255a7-fd23-42f9-aa7c-63acf9898093/viz-1784730796377-h264.mp4',
  '727255a7-fd23-42f9-aa7c-63acf9898093/viz-1784730796377.webm',
  '727255a7-fd23-42f9-aa7c-63acf9898093/viz-1784730833270.mp4',
  '727255a7-fd23-42f9-aa7c-63acf9898093/viz-1784730869587.mp4',
  '727255a7-fd23-42f9-aa7c-63acf9898093/viz-1784730887559.mp4',
  '727255a7-fd23-42f9-aa7c-63acf9898093/viz-1784730906873.mp4',
  '727255a7-fd23-42f9-aa7c-63acf9898093/viz-1784730951979.mp4',
  'a5f8c9aa-1d3b-48c3-86f9-0c663b7f0f87/viz-1786041926835.mp4',
  'a5f8c9aa-1d3b-48c3-86f9-0c663b7f0f87/viz-1786042050750.mp4',
  'a5f8c9aa-1d3b-48c3-86f9-0c663b7f0f87/viz-1786045314734.mp4',
  'a5f8c9aa-1d3b-48c3-86f9-0c663b7f0f87/viz-1786061933973.mp4',
  'a5f8c9aa-1d3b-48c3-86f9-0c663b7f0f87/viz-1786061974763.mp4',
  'a5f8c9aa-1d3b-48c3-86f9-0c663b7f0f87/viz-1786062029262.mp4',
  'a9241d7e-a296-49ce-8d92-5c76533bab0f/viz-1783447588975.mp4',
  'a9241d7e-a296-49ce-8d92-5c76533bab0f/viz-1783447974043.mp4',
  'a9241d7e-a296-49ce-8d92-5c76533bab0f/viz-1783448143089.mp4',
  'a9241d7e-a296-49ce-8d92-5c76533bab0f/viz-1785071524979.mp4',
  'b0642fc1-e7ab-4171-83d7-85b6f11a8742/viz-1786147184633.mp4',
  'c67db54b-26c9-4be1-9557-f6603aa38da2/viz-1785504315608.mp4',
  'c67db54b-26c9-4be1-9557-f6603aa38da2/viz-1785672515217-h264.mp4',
  'c67db54b-26c9-4be1-9557-f6603aa38da2/viz-1785672515217.webm',
  'c9c4cbd0-c01d-470b-8457-aa149c231c3a/viz-1783464391385-h264.mp4',
  'c9c4cbd0-c01d-470b-8457-aa149c231c3a/viz-1783464391385.webm',
  'c9c4cbd0-c01d-470b-8457-aa149c231c3a/viz-1783643989921-h264.mp4',
  'c9c4cbd0-c01d-470b-8457-aa149c231c3a/viz-1783643989921.webm',
  'd814483f-9e9d-447a-be12-930908d976b5/viz-1783686301809-h264.mp4',
  'd814483f-9e9d-447a-be12-930908d976b5/viz-1783686301809.webm',
  'd814483f-9e9d-447a-be12-930908d976b5/viz-1783686337567.mp4',
  'ee641b52-848b-4ec2-8ecd-72d6f301fffe/viz-1783708908806.mp4',
  'ee641b52-848b-4ec2-8ecd-72d6f301fffe/viz-1785115228025-h264.mp4',
  'ee641b52-848b-4ec2-8ecd-72d6f301fffe/viz-1785115228025.webm',
  'f5b8335b-f75a-4853-ab8d-f7f7a2e70a81/viz-1785544512926-h264.mp4',
  'f5b8335b-f75a-4853-ab8d-f7f7a2e70a81/viz-1785544512926.webm',
  'f5b8335b-f75a-4853-ab8d-f7f7a2e70a81/viz-1786532876384.mp4',
  'fcbf028c-388d-46ff-8799-d10d7b7d19b5/viz-1783464188766-h264.mp4',
  'fcbf028c-388d-46ff-8799-d10d7b7d19b5/viz-1783464188766.webm',
  'fcbf028c-388d-46ff-8799-d10d7b7d19b5/viz-1783622802827-h264.mp4',
  'fcbf028c-388d-46ff-8799-d10d7b7d19b5/viz-1783622802827.webm',
  'fcbf028c-388d-46ff-8799-d10d7b7d19b5/viz-1783622926607.mp4',
]

// Anti-vacuity: every "no real key changed" claim below is only worth anything
// if the census is actually the population it says it is. An emptied or
// truncated fixture would make all of them trivially true.
const stampOf = (k) => k.slice(k.indexOf('/viz-') + '/viz-'.length).replace(/\.(mp4|webm)$/, '')
const twins = CENSUS.filter(k => k.endsWith('-h264.mp4'))
const webms = CENSUS.filter(k => k.endsWith('.webm'))
const plainMp4s = CENSUS.filter(k => k.endsWith('.mp4') && !k.endsWith('-h264.mp4'))

check('the census is the whole bucket as measured', CENSUS.length === 83, `${CENSUS.length} keys`)
check('…with no duplicate rows', new Set(CENSUS).size === CENSUS.length)
check('…covering all three families the app writes',
  twins.length === 22 && webms.length === 22 && plainMp4s.length === 39,
  `${twins.length} twins, ${webms.length} webm, ${plainMp4s.length} plain mp4`)
check('…and every family accounted for, none left over',
  twins.length + webms.length + plainMp4s.length === CENSUS.length)
// The stamps every client has ever generated: a 13-character Date.now(), plus
// the 18 characters a twin costs. That is the whole distribution, and it is why
// a bound at 59 is not a bound anyone can reach.
const stampLens = [...new Set(CENSUS.map(k => stampOf(k).length))].sort((a, b) => a - b)
check('every real stamp is a Date.now() (13) or its twin (18)',
  stampLens.join(',') === '13,18', stampLens.join(','))
check('…so the longest real stamp has enormous headroom under the new bound',
  Math.max(...stampLens) < VIZ_WEBM_STAMP_MAX, `${Math.max(...stampLens)} vs ${VIZ_WEBM_STAMP_MAX}`)
// Each twin is derivable from a webm the bucket also holds (or held): the pair
// convention this whole design rests on is real, not theoretical.
check('every twin in the bucket is mp4TwinPath() of a webm key',
  twins.every(t => mp4TwinPath(webmOriginalPath(t)) === t))
check('…and 22 of those webm originals are still sitting there',
  twins.filter(t => CENSUS.includes(webmOriginalPath(t))).length === 22)

// ── 1. The RECOGNIZER did not move ──────────────────────────────────────────
// This is the assertion that licenses the whole fix: planReap's shape filter is
// the same regex it was, so no object anywhere becomes newly deletable.

const corpus = [...CENSUS]
const PID = '123e4567-e89b-42d3-a456-426614174000'
for (let n = 0; n <= VIZ_STAMP_MAX + 8; n++) {
  const stamp = 'a'.repeat(n)
  corpus.push(`${PID}/viz-${stamp}.webm`, `${PID}/viz-${stamp}.mp4`)
  corpus.push(`${PID}/viz-${stamp}${VIZ_TWIN_SUFFIX}.mp4`)
}
corpus.push(
  `${PID}/.emptyFolderPlaceholder`,
  `${PID}/viz-1.mov`,
  `${PID}/viz-1.MP4`,
  `${PID}/VIZ-1.mp4`,
  `${PID}/sub/viz-1.mp4`,
  `${PID}/../${PID}/viz-1.mp4`,
  `${PID}/viz-1.mp4\n`,
  `${PID}/viz-1.mp4 `,
  `${PID}/viz-.mp4`,
  `${PID}/viz-a b.mp4`,
  `${PID}/viz-a.b.mp4`,
  'viz-1.mp4',
  'not-a-uuid/viz-1.mp4',
  `${PID.toUpperCase()}/viz-1.mp4`,
  `${PID}x/viz-1.mp4`,
  `/${PID}/viz-1.mp4`,
  // The two shapes storeVisualizer could MINT but the recognizer refuses —
  // section 5 is about closing them at the write site. They live in the shared
  // corpus so the before/after classification comparison above also proves the
  // recognizer's answer for them is unchanged: still refused, still protected
  // from the sweep. Closing the leak must not make either newly deletable.
  `${PID}/viz-1786736865181.mov`,
  `${PID.toUpperCase()}/viz-1786736865181.mp4`,
  `${PID.toUpperCase()}/viz-1786736865181.mov`,
)

const classifyDelta = corpus.filter(k => OLD_VIZ_KEY_RE.test(k) !== VIZ_KEY_RE.test(k))
check('the recognizer classifies EVERY key in the corpus exactly as it did before',
  classifyDelta.length === 0, classifyDelta.slice(0, 3).join(' | '))
check('…over a corpus big enough for that to mean something',
  corpus.length >= 300 && corpus.some(k => VIZ_KEY_RE.test(k)) && corpus.some(k => !VIZ_KEY_RE.test(k)),
  `${corpus.length} keys`)
// Paired positive/negative, so "no delta" cannot be passing because the
// recognizer stopped matching anything at all.
check('…and the recognizer still accepts every real object in the bucket',
  CENSUS.every(k => VIZ_KEY_RE.test(k)))
check('…and still rejects the shapes it always rejected',
  !VIZ_KEY_RE.test(`${PID}/.emptyFolderPlaceholder`)
  && !VIZ_KEY_RE.test(`${PID}/viz-1.mov`)
  && !VIZ_KEY_RE.test(`${PID}/sub/viz-1.mp4`)
  && !VIZ_KEY_RE.test('viz-1.mp4'))
check('…including a stamp past the budget, which is what a widening would have changed',
  !VIZ_KEY_RE.test(`${PID}/viz-${'a'.repeat(VIZ_STAMP_MAX + 1)}.mp4`)
  && VIZ_KEY_RE.test(`${PID}/viz-${'a'.repeat(VIZ_STAMP_MAX)}.mp4`))

// The same statement in the sweep's own terms: run the REAL planner over the
// whole census under both regexes and compare the partition it produces.
const NOW = Date.parse('2026-08-17T12:00:00.000Z')
const AGED = new Date(NOW - 400 * 86_400_000).toISOString()
const censusObjects = CENSUS.map(key => ({ key, createdAt: AGED }))

// A mirror of planReap's decision, parameterized on the shape filter. Kept
// honest by asserting it reproduces the REAL planner's answer when handed the
// real regex — otherwise a "before" computed here would be fiction.
function planReapWith(shapeRe, objects, referenced, nowMs) {
  const plan = { reap: [], scanned: objects.length, keptReferenced: 0, keptRecent: 0, keptUnknownAge: 0, keptForeignShape: 0 }
  for (const o of objects) {
    if (!shapeRe.test(o.key)) { plan.keptForeignShape++; continue }
    if (referenced.has(o.key)) { plan.keptReferenced++; continue }
    const created = o.createdAt === null ? NaN : Date.parse(o.createdAt)
    if (!Number.isFinite(created)) { plan.keptUnknownAge++; continue }
    if (nowMs - created < REAP_MIN_AGE_MS) { plan.keptRecent++; continue }
    plan.reap.push(o.key)
  }
  return plan
}

{
  // Half the census referenced, so the comparison exercises more than one branch.
  const referenced = new Set(CENSUS.filter((_, i) => i % 2 === 0))
  const real = planReap(censusObjects, referenced, NOW)
  const mirrorNew = planReapWith(VIZ_KEY_RE, censusObjects, referenced, NOW)
  const mirrorOld = planReapWith(OLD_VIZ_KEY_RE, censusObjects, referenced, NOW)
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  check('the local mirror reproduces the REAL planner exactly, so "before" is not fiction',
    same(real, mirrorNew), JSON.stringify(real))
  check('BEFORE vs AFTER over all 83 real keys: identical plan, key for key',
    same(mirrorOld, real),
    `old reap ${mirrorOld.reap.length}, new reap ${real.reap.length}`)
  check('…and the plan is not trivially empty on both sides',
    real.reap.length === 41 && real.keptReferenced === 42 && real.keptForeignShape === 0
    && real.reap.length + real.keptReferenced === CENSUS.length,
    `reap ${real.reap.length}, referenced ${real.keptReferenced}, foreign ${real.keptForeignShape}`)
}

// ── 2. The GATE moved, by exactly one shape ─────────────────────────────────

// The old gate, reconstructed: regex + project prefix, with no stamp bound.
const oldParse = (projectId, path) => {
  if (typeof path !== 'string' || path.length > 200) return null
  const m = OLD_VIZ_KEY_RE.exec(path)
  if (!m || m[1] !== projectId) return null
  return { ext: m[2] }
}

{
  const refused = []
  for (let n = 1; n <= VIZ_STAMP_MAX; n++) {
    for (const ext of ['mp4', 'webm']) {
      const path = `${PID}/viz-${'a'.repeat(n)}.${ext}`
      const before = !!oldParse(PID, path)
      const after = !!parseVizStoragePath(PID, path)
      if (before !== after) refused.push(`${ext}:${n}`)
    }
  }
  check('the gate refuses exactly the webm stamps that leave no room for a twin',
    refused.join(',') === 'webm:60,webm:61,webm:62,webm:63,webm:64', refused.join(',') || 'nothing')
  check('…and nothing it refuses was ever accepted in the other direction',
    !refused.some(r => r.startsWith('mp4')))
}

check('an mp4 claim keeps the full budget — it derives no twin',
  !!parseVizStoragePath(PID, `${PID}/viz-${'a'.repeat(VIZ_STAMP_MAX)}.mp4`))
check('the longest webm claim still allowed is exactly VIZ_WEBM_STAMP_MAX',
  !!parseVizStoragePath(PID, `${PID}/viz-${'a'.repeat(VIZ_WEBM_STAMP_MAX)}.webm`)
  && !parseVizStoragePath(PID, `${PID}/viz-${'a'.repeat(VIZ_WEBM_STAMP_MAX + 1)}.webm`))
check('every object in the bucket today is still claimable under the tighter gate',
  CENSUS.every(k => !!parseVizStoragePath(k.slice(0, 36), k)),
  CENSUS.filter(k => !parseVizStoragePath(k.slice(0, 36), k)).slice(0, 2).join(' | '))
// The gate never rejects something the recognizer also rejects — i.e. tightening
// it cannot strand anything. An over-long webm signed under the old build and
// uploaded after this ships is refused at the claim AND still swept.
{
  const stranded = corpus.filter(k =>
    k.length === 36 + 1 + k.slice(37).length
    && !VIZ_KEY_RE.test(k)
    && !!parseVizStoragePath(k.slice(0, 36), k))
  check('nothing is claimable-but-unrecognized: the gate is a subset of the recognizer',
    stranded.length === 0, stranded.slice(0, 3).join(' | '))
  const overLong = `${PID}/viz-${'a'.repeat(62)}.webm`
  check('…so an over-long webm refused at the claim is still swept, not stranded',
    !parseVizStoragePath(PID, overLong) && VIZ_KEY_RE.test(overLong)
    && planReap([{ key: overLong, createdAt: AGED }], new Set(), NOW).reap.length === 1)
}

// ── 3. The invariant the bound exists to buy ────────────────────────────────
// For EVERY key the gate accepts as a webm claim, the twin the route will write
// must be a key the sweep recognizes. Exhaustive over the whole legal range —
// this is the property, not a spot check at the boundary.

{
  const broken = []
  for (let n = 1; n <= VIZ_STAMP_MAX + 8; n++) {
    const webm = `${PID}/viz-${'a'.repeat(n)}.webm`
    if (!parseVizStoragePath(PID, webm)) continue
    const twin = mp4TwinPath(webm)
    if (!VIZ_KEY_RE.test(twin) || !parseVizStoragePath(PID, twin)) broken.push(n)
  }
  check('every claimable webm key produces a twin the sweep can recognize and reap',
    broken.length === 0, `broken at stamp length(s) ${broken.join(',')}`)
  // …and the range actually swept something, so the loop cannot pass by testing
  // nothing at all.
  const claimable = Array.from({ length: VIZ_STAMP_MAX + 8 }, (_, i) => i + 1)
    .filter(n => !!parseVizStoragePath(PID, `${PID}/viz-${'a'.repeat(n)}.webm`))
  check('…checked over every legal stamp length, not just the boundary',
    claimable.length === VIZ_WEBM_STAMP_MAX, `${claimable.length} lengths`)
}

// The constants are DERIVED, not three independent numbers that can drift.
check('VIZ_TWIN_SUFFIX is what mp4TwinPath actually appends',
  mp4TwinPath(`${PID}/viz-stamp.webm`) === `${PID}/viz-stamp${VIZ_TWIN_SUFFIX}.mp4`,
  mp4TwinPath(`${PID}/viz-stamp.webm`))
check('the webm bound is the stamp budget minus that suffix, not a magic number',
  VIZ_WEBM_STAMP_MAX === VIZ_STAMP_MAX - VIZ_TWIN_SUFFIX.length,
  `${VIZ_WEBM_STAMP_MAX} = ${VIZ_STAMP_MAX} - ${VIZ_TWIN_SUFFIX.length}`)
check('the stamp budget is the one the recognizer actually grants',
  VIZ_KEY_RE.test(`${PID}/viz-${'a'.repeat(VIZ_STAMP_MAX)}.mp4`)
  && !VIZ_KEY_RE.test(`${PID}/viz-${'a'.repeat(VIZ_STAMP_MAX + 1)}.mp4`))

// Fail-first witness: the shipped gate, and the object it could mint.
{
  const overLong = `${PID}/viz-${'a'.repeat(62)}.webm`
  const twin = mp4TwinPath(overLong)
  check('witness: the unbounded gate accepted a 62-character webm stamp',
    !!oldParse(PID, overLong) && !parseVizStoragePath(PID, overLong))
  check('witness: …whose twin this app would WRITE and then not recognize',
    !VIZ_KEY_RE.test(twin) && !OLD_VIZ_KEY_RE.test(twin), twin)
  const plan = planReap([{ key: twin, createdAt: AGED }], new Set(), NOW)
  check('witness: …so the sweep files it as foreign and keeps it forever',
    plan.reap.length === 0 && plan.keptForeignShape === 1,
    'no other code path can name it either')
  // And the delete paths cannot reach it either, which is what makes it
  // permanent rather than merely wasteful: they all start from a row.
  check('witness: …and it is not even a twin the pair convention can walk back',
    webmOriginalPath(twin) === overLong && !parseVizStoragePath(PID, webmOriginalPath(twin)),
    'the inverse resolves to a key the gate now refuses')
}

// ── 4. Source contract: one recognizer, no private copies ───────────────────

const finalizeLib = stripComments(read('src/lib/visualizer-finalize.ts'))
const plan = stripComments(read('src/lib/video-orphan-plan.ts'))
const uploadUrl = stripComments(read('src/app/api/upload-url/route.ts'))
const route = stripComments(read('src/app/api/visualizer/finalize/route.ts'))

check('the sweep imports the shared recognizer rather than declaring its own',
  /import \{ VIZ_KEY_RE \} from '\.\/visualizer-finalize\.ts'/.test(plan)
  && !/VIZ_KEY_RE = /.test(plan))
check('…and applies it as the shape filter that keeps an object',
  /if \(!VIZ_KEY_RE\.test\(object\.key\)\) \{ plan\.keptForeignShape\+\+/.test(plan))
check('/api/upload-url signs against the same recognizer',
  /import \{ VIZ_KEY_RE \} from '@\/lib\/visualizer-finalize'/.test(uploadUrl)
  && /!VIZ_KEY_RE\.test\(safeFilename\)/.test(uploadUrl))

// Bounded by BOTH ends explicitly. functionBody() cannot be used here: this
// function's return type is itself a braced literal (`): { ext: … } | null {`),
// so the first balanced block after the marker is the annotation, not the body —
// a slice that would have made every "the body contains…" check below fail
// against perfectly correct code.
const iParse = finalizeLib.indexOf('export function parseVizStoragePath')
const iNextDecl = finalizeLib.indexOf('export function sanitizeSettings', iParse)
const parseFn = iParse !== -1 && iNextDecl > iParse ? finalizeLib.slice(iParse, iNextDecl) : ''
check('the claim gate was located, and the slice is bounded to it',
  parseFn.length > 0 && parseFn.length < 900 && parseFn.includes('VIZ_KEY_RE.exec'),
  `${parseFn.length} chars`)
check('the bound lives in the GATE, and applies only to the lane that derives a twin',
  /ext === 'webm' && m\[2\]\.length > VIZ_WEBM_STAMP_MAX/.test(parseFn))
check('…and refuses the claim rather than truncating or rewriting the key',
  /VIZ_WEBM_STAMP_MAX\) return null/.test(parseFn))
check('the recognizer itself still spells the budget it always did',
  /VIZ_KEY_RE = \/\^\(\[0-9a-f-\]\{36\}\)\\\/viz-\(\[A-Za-z0-9_-\]\{1,64\}\)\\\.\(mp4\|webm\)\$\//.test(finalizeLib))

check('the finalize route re-validates the twin key it is about to write',
  /if \(!parseVizStoragePath\(projectId, twinPath\)\)/.test(route))

// ── 5. The WRITE PATH cannot mint a key the recognizer refuses ──────────────
// Section 1 pins the recognizer. This pins the other half of the contract:
// storeVisualizer() (src/lib/visualizer-store.ts) is the ONLY site in the
// codebase that mints an mf-video key from scratch. Every other writer either
// derives one from an already-validated claim (mp4TwinPath, in the finalize
// lane and the boot heal) or is /api/upload-url, which refuses to sign anything
// VIZ_KEY_RE rejects. So if that one expression can produce a key outside the
// regex, the app writes objects it can never reap — and nothing downstream can
// rescue them, because every delete path starts from a row's video_url.
//
// TWO arms of it could:
//
//   * `contentType.includes('quicktime') ? 'mov'`. contentType is externally
//     influenced on both lanes that reach it — /api/visualizer/save takes it
//     from `file.type`, the multipart part header the CLIENT writes, and
//     /api/visualizer/runway forwards the Runway response's content-type
//     verbatim. mf-video's allowed_mime_types is
//     ['video/webm','video/mp4','video/quicktime'], so the storage layer accepts
//     the upload rather than rejecting it. This was reachable, not latent.
//
//   * the project segment was interpolated raw, while VIZ_KEY_RE spells it
//     `[0-9a-f-]{36}` — LOWERCASE hex. isUuid()'s regex carries /i and Postgres
//     compares uuid columns case-insensitively, so an UPPERCASE project id
//     cleared both the shape check and the ownership check and minted a key
//     nothing can ever name. Swift's UUID.uuidString is uppercase and the same
//     mistake already happened in mf-audio (115 of 389 objects are
//     `<UPPERCASE-UUID>-v<n>-<ts>.wav`).
//
// Neither is fixed by widening the regex. Both are fixed at the mint.

const store = stripComments(read('src/lib/visualizer-store.ts'))
const storeFn = functionBody(store, 'export async function storeVisualizer')

// The shipped key expression, transcribed — and the one it replaced. Same
// device as OLD_VIZ_KEY_RE above: a hand-written mirror is only evidence while
// the source-contract checks below prove the source still says exactly this.
const STAMP = 1786736865181
const mintKey = (projectId, contentType) => {
  const ext = contentType.includes('mp4') || contentType.includes('quicktime') ? 'mp4' : 'webm'
  return `${projectId.toLowerCase()}/viz-${STAMP}.${ext}`
}
const oldMintKey = (projectId, contentType) => {
  const ext = contentType.includes('mp4') ? 'mp4'
    : contentType.includes('quicktime') ? 'mov'
    : 'webm'
  return `${projectId}/viz-${STAMP}.${ext}`
}

// Every content-type that can actually arrive, plus what a sloppy or hostile
// client can assert. The three the bucket permits are the ones that become
// objects; the list is deliberately wider so the property is not tested only on
// the inputs someone remembered.
const CONTENT_TYPES = [
  'video/mp4',                       // free, finalize, video-jobs — hardcoded
  'video/webm',                      // save's default when file.type is empty
  'video/quicktime',                 // ← the leak, and the bucket allows it
  'video/mp4; codecs="avc1.42E01E"', // what a real File.type looks like
  'video/webm;codecs=vp9',
  'VIDEO/QUICKTIME',
  'application/octet-stream',
  'binary/octet-stream',
  'video/x-quicktime',
  'text/html',
  '',
]
const PID_CASINGS = [PID, PID.toUpperCase(), PID.slice(0, 18) + PID.slice(18).toUpperCase()]

{
  const minted = []
  for (const pid of PID_CASINGS) for (const ct of CONTENT_TYPES) minted.push(mintKey(pid, ct))

  const unrecognized = minted.filter(k => !VIZ_KEY_RE.test(k))
  check('every key the write path can mint is one the sweep RECOGNIZES',
    unrecognized.length === 0, unrecognized.slice(0, 3).join(' | '))
  // Recognized is necessary but not sufficient: the claim gate is the stricter
  // of the two, and the write path must stay inside BOTH or the finalize lane
  // could not re-derive anything from a key this function produced.
  const unclaimable = minted.filter(k => !parseVizStoragePath(k.slice(0, 36), k))
  check('…and one the shared claim gate ACCEPTS, not merely one the regex tolerates',
    unclaimable.length === 0, unclaimable.slice(0, 3).join(' | '))
  // Anti-vacuity, both directions: the corpus is the size it claims, it really
  // contains the two defect shapes, and the mint has not passed by collapsing
  // every input onto a single safe extension.
  //
  // The three membership assertions are named literals rather than a
  // `.some(…includes('quicktime'))` predicate on purpose. A self-referential
  // size check (`minted.length === CONTENT_TYPES.length * …`) proves the loops
  // ran but says NOTHING about what they ran over — deleting an entry keeps it
  // green, which is exactly how a corpus quietly shrinks to the one input
  // someone was thinking about. The literals below are the three content-types
  // mf-video's allowed_mime_types permits, i.e. the only ones that can become
  // objects at all, so none of them may leave this list.
  check('…over a corpus that actually exercises both defects',
    minted.length === CONTENT_TYPES.length * PID_CASINGS.length
    && CONTENT_TYPES.length >= 10
    && CONTENT_TYPES.includes('video/mp4')
    && CONTENT_TYPES.includes('video/webm')
    && CONTENT_TYPES.includes('video/quicktime')
    && PID_CASINGS.length >= 3
    && PID_CASINGS.some(p => p !== p.toLowerCase()),
    `${minted.length} minted keys from ${CONTENT_TYPES.length} content-types`)
  check('…and the mint still produces BOTH lanes, not one safe extension',
    new Set(minted.map(k => k.slice(k.lastIndexOf('.')))).size === 2,
    [...new Set(minted.map(k => k.slice(k.lastIndexOf('.'))))].join(','))

  // Fail-first witness: the SAME inputs through the expression that shipped.
  const oldMinted = []
  for (const pid of PID_CASINGS) for (const ct of CONTENT_TYPES) oldMinted.push(oldMintKey(pid, ct))
  const oldUnrecognized = [...new Set(oldMinted.filter(k => !VIZ_KEY_RE.test(k)))]
  check('witness: the old expression minted keys the sweep files as foreign',
    oldUnrecognized.length > 0, `${oldUnrecognized.length} distinct, of ${oldMinted.length} mints`)
  check('witness: …including a .mov, from a content-type the bucket accepts',
    oldUnrecognized.includes(`${PID}/viz-${STAMP}.mov`)
    && oldMintKey(PID, 'video/quicktime').endsWith('.mov'))
  check('witness: …and an UPPERCASE project segment, from an id every gate admits',
    oldUnrecognized.includes(`${PID.toUpperCase()}/viz-${STAMP}.mp4`)
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(PID.toUpperCase()))
  // Permanent rather than merely wasteful: the sweep is the last cleanup path
  // that does not start from a row, and it keeps every one of them forever.
  const foreignPlan = planReap(oldUnrecognized.map(key => ({ key, createdAt: AGED })), new Set(), NOW)
  check('witness: …none of which the sweep would EVER delete',
    foreignPlan.reap.length === 0 && foreignPlan.keptForeignShape === oldUnrecognized.length,
    `reap ${foreignPlan.reap.length}, foreign ${foreignPlan.keptForeignShape}`)
  // THE FIX IS THE BOUND, NOT A WIDER REGEX. Those keys are still unrecognized
  // after the fix, so no object already in the bucket became newly deletable —
  // the app simply stopped being able to create them.
  check('the fix did not teach the recognizer .mov or uppercase — it stopped writing them',
    oldUnrecognized.every(k => !VIZ_KEY_RE.test(k))
    && !VIZ_KEY_RE.test(`${PID}/viz-1.mov`)
    && !VIZ_KEY_RE.test(`${PID.toUpperCase()}/viz-1.mp4`)
    && !parseVizStoragePath(PID, `${PID}/viz-1.mov`)
    && !parseVizStoragePath(PID.toUpperCase(), `${PID.toUpperCase()}/viz-1.mp4`))
}

// ── Source contract: the mirror above is the code that ships ────────────────

check('the storeVisualizer body was located, and the slice is bounded to it',
  storeFn.length > 0 && storeFn.includes('.upload(filename, bytes')
  && storeFn.includes('insertVisualizerRow'),
  `${storeFn.length} chars`)
check('no .mov arm survives anywhere in the store',
  !/'mov'/.test(store) && !/\.mov/.test(store))
check('the extension is annotated with the recognizer\'s own union type',
  /const ext: VizKeyExt = contentType\.includes\('mp4'\) \|\| contentType\.includes\('quicktime'\)\s*\?\s*'mp4'\s*:\s*'webm'/
    .test(storeFn))
check('…imported from the module that owns VIZ_KEY_RE, never redeclared here',
  /import \{ parseVizStoragePath, type VizKeyExt \} from '@\/lib\/visualizer-finalize'/.test(store)
  && !/VIZ_KEY_RE\s*=/.test(store)
  && !/type VizKeyExt\s*=/.test(store))
check('the project segment is lowercased before it can become a key',
  /const keyProjectId = projectId\.toLowerCase\(\)/.test(storeFn)
  && /const filename = args\.path \?\? `\$\{keyProjectId\}\/viz-\$\{Date\.now\(\)\}\.\$\{ext\}`/.test(storeFn))
check('…and the raw projectId never reaches a key on its own',
  !/`\$\{projectId\}\/viz-/.test(store))

{
  const iGate = storeFn.indexOf('parseVizStoragePath(keyProjectId, filename)')
  const iUpload = storeFn.indexOf('.upload(filename, bytes')
  check('the minted key is re-checked against the shared claim gate',
    iGate !== -1, 'no gate found')
  check('…BEFORE the bytes are written, which is the only order that helps',
    iGate !== -1 && iUpload !== -1 && iGate < iUpload, `gate@${iGate} upload@${iUpload}`)
  check('…refusing the write outright rather than truncating or rewriting the key',
    /if \(!parseVizStoragePath\(keyProjectId, filename\)\) \{[\s\S]*?return null/.test(storeFn)
    && !/filename\s*=/.test(storeFn.slice(iGate, iUpload)))
}

console.log(failures === 0 ? '\nAll viz-key-shape tests passed' : `\n${failures} viz-key-shape test(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
