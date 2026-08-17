// mf-video orphan sweep contract test — exercises the REAL planner
// (src/lib/video-orphan-plan.ts via Node type stripping) plus a source contract
// over the Supabase half it cannot load.
//
// Run: node scripts/video-orphan-reaper-test.mjs
//
// WHY THIS EXISTS
// The full-resolution save path signs a key, the browser PUTs the bytes DIRECTLY
// into the PUBLIC mf-video bucket, and a separate JSON claim to
// /api/visualizer/finalize is the only thing that writes the mb_visualizers row.
// /api/visualizer/finalize closes every SERVER-side way that can leave bytes
// behind, but it cannot close the case where the claim never arrives — the tab
// is closed, the browser dies, the network drops. Those bytes are then
// unreachable forever: invisible in Media, unnameable by
// DELETE /api/visualizer/[id] (it derives its key from a row's video_url), and
// missed by /api/auth/delete-account (it starts from rows). That last one makes
// it a data-deletion problem, not a quota one.
//
// A sweeper that deletes the wrong object destroys a render the user believes is
// saved, so the tests below are weighted accordingly: most of them assert on the
// things that must be KEPT.
//
// The planner is a real import. The Supabase half (src/lib/video-orphan-reaper.ts)
// reaches for the '@/' alias and a live client, so its properties are asserted
// over SOURCE — with comments stripped first, so a guard that survives only
// inside a comment cannot pass.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  REAP_MIN_AGE_MS,
  REAP_MAX_PAGES,
  REAP_PAGE_SIZE,
  listVideoObjects,
  planReap,
} from '../src/lib/video-orphan-plan.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// Strip comments while respecting string/template literals, so a `//` inside
// 'https://...' doesn't swallow the rest of a real line of code.
function stripComments(src) {
  let out = ''
  let i = 0
  let quote = null
  while (i < src.length) {
    const c = src[i]
    const next = src[i + 1]
    if (quote) {
      if (c === '\\') { out += c + (next ?? ''); i += 2; continue }
      if (c === quote) quote = null
      out += c; i++; continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue }
    if (c === '/' && next === '/') { while (i < src.length && src[i] !== '\n') i++; continue }
    if (c === '/' && next === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue }
    out += c; i++
  }
  return out
}

const PID = '123e4567-e89b-42d3-a456-426614174000'
const PID2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const NOW = Date.parse('2026-08-15T12:00:00.000Z')
const iso = (msAgo) => new Date(NOW - msAgo).toISOString()

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

// ── The threshold itself ────────────────────────────────────────────────────
// Justification lives next to the constant; these lock the number against a
// well-meaning "let's reclaim storage faster" edit.

check('threshold is 24 hours', REAP_MIN_AGE_MS === DAY, `${REAP_MIN_AGE_MS} ms`)
// A Supabase signed upload URL is valid for 2 h, so no PUT can even start after
// that; a 200 MB export (MAX_FINALIZE_BYTES) on a 1 Mbps uplink is ~27 min, and
// fx/upload.ts allows one full re-PUT, so ~55 min of transfer; the claim's own
// retry loop adds ~1 min. Call the honest worst case 2 h and demand real
// headroom on top of it — the case that argues for more is a suspended mobile
// tab firing its claim the next morning.
check('threshold clears the upload+claim worst case many times over',
  REAP_MIN_AGE_MS >= 10 * (2 * HOUR), `${REAP_MIN_AGE_MS / HOUR}h vs 2h worst case`)
check('threshold covers an overnight suspended tab', REAP_MIN_AGE_MS >= 12 * HOUR)

// ── planReap: the keep/delete decision ──────────────────────────────────────

const key = (pid, stamp, ext = 'mp4') => `${pid}/viz-${stamp}.${ext}`
const OLD_ORPHAN = key(PID, '1000')
const oldOrphan = { key: OLD_ORPHAN, createdAt: iso(3 * DAY) }

{
  const plan = planReap([oldOrphan], new Set(), NOW)
  check('reaps an old, unreferenced, viz-shaped object',
    plan.reap.length === 1 && plan.reap[0] === OLD_ORPHAN)
  check('counts what it scanned', plan.scanned === 1)
}

{
  // The single most important test in this file.
  const plan = planReap([oldOrphan], new Set([OLD_ORPHAN]), NOW)
  check('KEEPS an object a row references', plan.reap.length === 0 && plan.keptReferenced === 1)
}

for (const age of [0, 1000, HOUR, 6 * HOUR, DAY - 1]) {
  const fresh = { key: key(PID, `f${age}`), createdAt: iso(age) }
  const plan = planReap([fresh], new Set(), NOW)
  check(`KEEPS an unreferenced object only ${(age / HOUR).toFixed(2)}h old`,
    plan.reap.length === 0 && plan.keptRecent === 1)
}

{
  const exact = { key: key(PID, 'exact'), createdAt: iso(DAY) }
  const plan = planReap([exact], new Set(), NOW)
  check('an object exactly at the threshold is reapable', plan.reap.length === 1)
}

for (const badDate of [null, '', 'not-a-date', 'yesterday']) {
  const undated = { key: key(PID, 'undated'), createdAt: badDate }
  const plan = planReap([undated], new Set(), NOW)
  check(`KEEPS an object whose age is unknown (${JSON.stringify(badDate)})`,
    plan.reap.length === 0 && plan.keptUnknownAge === 1)
}

for (const foreign of [
  `${PID}/.emptyFolderPlaceholder`,
  `${PID}/audio-1.mp4`,
  `${PID}/sub/viz-1.mp4`,
  `${PID}/viz-1.mov`,
  'viz-1.mp4',
  `not-a-uuid/viz-1.mp4`,
]) {
  const plan = planReap([{ key: foreign, createdAt: iso(30 * DAY) }], new Set(), NOW)
  check(`KEEPS a non-viz key: ${foreign}`, plan.reap.length === 0 && plan.keptForeignShape === 1)
}

{
  // The webm original the WebM→MP4 boot heal deliberately leaves behind as a
  // rollback path is NOT an orphan: DELETE /api/visualizer/[id] and
  // /api/auth/delete-account both name it via webmOriginalPath(), so the sweep
  // must too — which it does by folding it into the referenced set.
  const twin = key(PID, '2000-h264')
  const original = key(PID, '2000', 'webm')
  const plan = planReap(
    [{ key: twin, createdAt: iso(9 * DAY) }, { key: original, createdAt: iso(9 * DAY) }],
    new Set([twin, original]),
    NOW,
  )
  check('KEEPS the pre-conversion webm the heal left as a rollback path',
    plan.reap.length === 0 && plan.keptReferenced === 2)
}

{
  const mixed = [
    oldOrphan,
    { key: key(PID2, '3000'), createdAt: iso(5 * DAY) },
    { key: key(PID, '4000'), createdAt: iso(5 * DAY) },
    { key: key(PID, '5000'), createdAt: iso(1000) },
  ]
  const plan = planReap(mixed, new Set([key(PID, '4000')]), NOW)
  check('a mixed bucket reaps exactly the abandoned ones',
    plan.reap.join('|') === [OLD_ORPHAN, key(PID2, '3000')].join('|'), plan.reap.join('|'))
  check('and accounts for every object it kept',
    plan.keptReferenced === 1 && plan.keptRecent === 1
    && plan.reap.length + plan.keptReferenced + plan.keptRecent === plan.scanned)
}

// Fail-first witness: the naive sweep — "anything no row points at" — is the
// shape this planner exists to NOT be. It deletes a render the user is at that
// moment still uploading, and the placeholder object Supabase creates for an
// empty folder.
{
  const naive = (objects, referenced) => objects.filter(o => !referenced.has(o.key)).map(o => o.key)
  const inFlight = { key: key(PID, '6000'), createdAt: iso(90 * 1000) }
  const placeholder = { key: `${PID}/.emptyFolderPlaceholder`, createdAt: iso(30 * DAY) }
  check('witness: the naive "no row points at it" sweep deletes an in-flight upload',
    naive([inFlight], new Set()).length === 1)
  check('witness: …and Supabase\'s own folder placeholder',
    naive([placeholder], new Set()).length === 1)
  check('planReap deletes neither',
    planReap([inFlight, placeholder], new Set(), NOW).reap.length === 0)
}

// ── listVideoObjects: the two-level walk, its paging, and its failure mode ──

// A fake storage listing. `tree` maps a prefix to its rows; '' is the bucket
// root, where sub-prefixes appear as rows with id === null.
function fakeLister(tree, opts = {}) {
  const calls = []
  const listPage = async (prefix, offset, limit) => {
    calls.push({ prefix, offset, limit })
    if (opts.failOn && opts.failOn(prefix, offset)) return null
    const rows = tree[prefix] ?? []
    // A broken pager that ignores `offset` — the shape that would spin forever.
    if (opts.ignoreOffset) return rows.slice(0, limit)
    return rows.slice(offset, offset + limit)
  }
  return { listPage, calls }
}

const folder = (name) => ({ name, id: null, created_at: null })
const object = (name, createdAt) => ({ name, id: `id-${name}`, created_at: createdAt })

{
  const { listPage } = fakeLister({
    '': [folder(PID), folder(PID2)],
    [PID]: [object('viz-1.mp4', iso(3 * DAY)), object('viz-2.webm', iso(1000))],
    [PID2]: [object('viz-3.mp4', iso(9 * DAY))],
  })
  const found = await listVideoObjects(listPage)
  check('walks root folders and joins prefix + name into full keys',
    found !== null && found.map(f => f.key).join('|') ===
      [`${PID}/viz-1.mp4`, `${PID}/viz-2.webm`, `${PID2}/viz-3.mp4`].join('|'),
    found === null ? 'null' : found.map(f => f.key).join('|'))
  check('carries each object\'s timestamp through',
    found !== null && found[0].createdAt === iso(3 * DAY) && found[1].createdAt === iso(1000))
}

{
  // Nested folders are not viz keys; the walk must not descend into them and
  // must not emit them as objects.
  const { listPage } = fakeLister({
    '': [folder(PID)],
    [PID]: [folder('nested'), object('viz-1.mp4', iso(3 * DAY))],
  })
  const found = await listVideoObjects(listPage)
  check('skips nested folders instead of emitting them as objects',
    found !== null && found.length === 1 && found[0].key === `${PID}/viz-1.mp4`)
}

{
  // An object sitting at the bucket ROOT has no project prefix, so it can never
  // be a viz key. It must not be emitted (and certainly not descended into).
  const { listPage } = fakeLister({ '': [object('stray.mp4', iso(30 * DAY))] })
  const found = await listVideoObjects(listPage)
  check('ignores a stray object at the bucket root', found !== null && found.length === 0)
}

{
  // Paging. This is where an under-reap hides: a folder with more objects than
  // one page must be walked to the end.
  const many = Array.from({ length: REAP_PAGE_SIZE + 7 }, (_, i) => object(`viz-${i}.mp4`, iso(3 * DAY)))
  const { listPage, calls } = fakeLister({ '': [folder(PID)], [PID]: many })
  const found = await listVideoObjects(listPage)
  check('paginates past the first page instead of silently under-reaping',
    found !== null && found.length === REAP_PAGE_SIZE + 7, `${found?.length}`)
  check('advances the offset by a full page each time',
    calls.filter(c => c.prefix === PID).map(c => c.offset).join(',') === `0,${REAP_PAGE_SIZE}`)
}

{
  // The root itself can also exceed one page.
  const folders = Array.from({ length: REAP_PAGE_SIZE + 1 }, (_, i) => folder(`p${i}`))
  const tree = { '': folders }
  for (const f of folders) tree[f.name] = [object('viz-1.mp4', iso(3 * DAY))]
  const { listPage } = fakeLister(tree)
  const found = await listVideoObjects(listPage)
  check('paginates the bucket root too', found !== null && found.length === REAP_PAGE_SIZE + 1)
}

{
  const exact = Array.from({ length: REAP_PAGE_SIZE }, (_, i) => object(`viz-${i}.mp4`, iso(3 * DAY)))
  const { listPage, calls } = fakeLister({ '': [folder(PID)], [PID]: exact })
  const found = await listVideoObjects(listPage)
  check('handles a folder that is exactly one page long',
    found !== null && found.length === REAP_PAGE_SIZE)
  check('…by asking for the page after it rather than assuming',
    calls.filter(c => c.prefix === PID).length === 2)
}

// Fail-closed. Each of these must produce null — "abort, delete nothing" —
// because a partial listing cannot distinguish an absent object from an
// unlisted one.
{
  const tree = {
    '': [folder(PID), folder(PID2)],
    [PID]: [object('viz-1.mp4', iso(3 * DAY))],
    [PID2]: [object('viz-2.mp4', iso(3 * DAY))],
  }
  const rootFails = fakeLister(tree, { failOn: (prefix) => prefix === '' })
  check('a failed ROOT page aborts the whole walk', await listVideoObjects(rootFails.listPage) === null)

  const firstFolderFails = fakeLister(tree, { failOn: (prefix) => prefix === PID })
  check('a failed FOLDER page aborts the whole walk',
    await listVideoObjects(firstFolderFails.listPage) === null)

  const secondFolderFails = fakeLister(tree, { failOn: (prefix) => prefix === PID2 })
  check('a failure on the LAST folder aborts too — not "keep what we got"',
    await listVideoObjects(secondFolderFails.listPage) === null)
}

{
  // The subtle one: ONE page fails and the rest succeed. Skipping it and
  // carrying on returns a listing that looks complete and is not — every object
  // on the lost page silently drops out of the referenced-vs-present comparison.
  // (This is the case a `continue` instead of a `return null` would let through:
  // a prefix whose pages ALL fail still ends up null via the page cap, so only a
  // partial failure distinguishes the two.)
  const many = Array.from({ length: REAP_PAGE_SIZE + 5 }, (_, i) => object(`viz-${i}.mp4`, iso(3 * DAY)))
  const { listPage } = fakeLister(
    { '': [folder(PID)], [PID]: many },
    { failOn: (prefix, offset) => prefix === PID && offset === REAP_PAGE_SIZE },
  )
  check('a single failed page in the middle of a folder aborts the whole walk',
    await listVideoObjects(listPage) === null)
}

{
  // The infinite-pager guard. A lister that ignores `offset` returns a full page
  // forever; the walk must stop at REAP_MAX_PAGES and report failure rather than
  // spin or, worse, return a plausible-looking partial list.
  const many = Array.from({ length: REAP_PAGE_SIZE }, (_, i) => object(`viz-${i}.mp4`, iso(3 * DAY)))
  const { listPage, calls } = fakeLister({ '': [folder(PID)], [PID]: many }, { ignoreOffset: true })
  const started = Date.now()
  const found = await listVideoObjects(listPage)
  check('a pager that never advances fails the sweep instead of looping forever',
    found === null, `${Date.now() - started}ms`)
  check('…and is bounded by the page cap',
    calls.filter(c => c.prefix === PID).length === REAP_MAX_PAGES)
  // The check above compares the observed call count to the very constant that
  // produced it, so it stays green no matter how large REAP_MAX_PAGES becomes —
  // raising it to 100_000 kept it passing while the sweep made 100k list calls
  // per prefix per boot. Pin the VALUE, in both directions, or the only thing
  // bounding that work is a number nothing asserts on.
  check('the page cap covers a realistic bucket',
    REAP_MAX_PAGES * REAP_PAGE_SIZE >= 100_000,
    `${REAP_MAX_PAGES} * ${REAP_PAGE_SIZE}`)
  check('…without licensing an unbounded number of list calls',
    REAP_MAX_PAGES <= 500, `${REAP_MAX_PAGES}`)
}

// ── Source contract: src/lib/video-orphan-reaper.ts ─────────────────────────

const reaper = stripComments(read('src/lib/video-orphan-reaper.ts'))
const deleteRoute = stripComments(read('src/app/api/visualizer/[id]/route.ts'))

// 1. ONE derivation. If the reaper parsed video_url its own way, the two could
//    drift — and a reaper whose idea of "referenced" differs from the delete
//    path's deletes live videos.
check('reaper derives storage keys with videoStoragePath()', /videoStoragePath\(/.test(reaper))
check('…and includes the heal\'s pre-conversion webm via webmOriginalPath()',
  /webmOriginalPath\(/.test(reaper))
check('the delete path uses exactly the same pair',
  /videoStoragePath\(/.test(deleteRoute) && /webmOriginalPath\(/.test(deleteRoute))
check('reaper does NOT hand-roll a second URL parser',
  !reaper.includes('/storage/v1/object/public/'))

// 2. Fail-closed on incomplete knowledge.
check('an incomplete listing returns before anything is deleted',
  /objects === null[\s\S]{0,200}?return/.test(reaper))
check('an incomplete reference scan returns before anything is deleted',
  /referenced === null[\s\S]{0,200}?return/.test(reaper))
check('the reference scan returns null on a query error rather than an empty set',
  /library scan failed[\s\S]{0,80}?return null/.test(reaper))
check('the reference scan is paginated, not a single bounded page',
  /\.range\(from, from \+ REF_PAGE_SIZE - 1\)/.test(reaper))
check('the reference pager has a cap that aborts rather than spins',
  /REF_MAX_PAGES[\s\S]{0,600}?return null/.test(reaper))

// 3. The per-key re-check immediately before deleting.
check('each candidate is re-confirmed unreferenced just before deletion',
  /confirmUnreferenced\(key\)/.test(reaper))
check('the re-check treats a failed query as "referenced" (keep the object)',
  /return !error && !data/.test(reaper))

// 4. Verified removal. A remove refused by storage RLS is NOT an error: the
//    policy matches no rows, storage-api answers 200 with `[]`, and supabase-js
//    hands back `{ data: [], error: null }`. That is how ~259 objects leaked
//    across three buckets while every delete path in the app logged success.
//    Counting `batch.length` on a non-error would make this sweeper the same
//    kind of lie, so the whole point is to count only what storage CONFIRMED.
check('the sweep deletes only through the shared verified helper',
  /removeStorageObjects\(VIDEO_BUCKET, batch\)/.test(reaper))
check('no bare storage remove() anywhere in the reaper',
  !/storage[\s\S]{0,80}?\.remove\(/.test(reaper))
check('removals are counted from CONFIRMED keys, not from the batch',
  /removed \+= outcome\.removed\.length/.test(reaper) && !/removed \+= batch\.length/.test(reaper))
check('keys storage would not confirm are reported, not counted as removed',
  /unconfirmed \+= outcome\.unconfirmed\.length/.test(reaper))
// Anchored on the SUMMARY line specifically. Matching a bare /confirmed removed/
// anywhere in the file was satisfied by the per-key error log ("NOT confirmed
// removed: <key>"), so the summary could go back to reporting the batch size and
// this check would not have noticed — the exact defect it is named for.
check('the summary line says "confirmed", so a no-op sweep cannot read as success',
  /done — \$\{removed\} confirmed removed/.test(reaper))
check('a batch that confirmed nothing at all aborts the sweep loudly',
  /outcome\.removed\.length === 0[\s\S]{0,300}?break/.test(reaper))

// The shared helper (src/lib/storage-remove.ts) is what makes that possible;
// lock the property the reaper depends on rather than re-testing the helper.
const removeHelper = stripComments(read('src/lib/storage-remove.ts'))
// Anchored on the behaviour, not on an identifier: both outputs must be derived
// from the REQUESTED keys via one shared predicate, and that predicate must
// consult the set storage echoed back. An earlier version of this check matched
// the variable name `removedSet`, which went red on a rename that changed
// nothing about the property — a test that fails on refactors but not on
// regressions is worse than no test.
check('the shared helper decides from the set storage echoed back',
  /returnedSet\.has\(/.test(removeHelper))
check('…and derives BOTH removed and unconfirmed from the requested keys',
  /const removed = requested\.filter\(/.test(removeHelper) &&
  /const unconfirmed = requested\.filter\(/.test(removeHelper))
check('…and never reports ok when a key went unconfirmed',
  /ok: unconfirmed\.length === 0/.test(removeHelper))

// Fail-first witness: the accounting that hid the bug for months.
{
  const supabaseSaysOk = { data: [], error: null } // verbatim shape prod returned
  const legacyRemoved = supabaseSaysOk.error ? 0 : 3 // "3 keys, no error, so 3 gone"
  const confirmedRemoved = (supabaseSaysOk.data ?? []).length
  check('witness: counting the batch on a non-error reports 3 deletions that never happened',
    legacyRemoved === 3)
  check('counting the confirmed keys reports the truth', confirmedRemoved === 0)
}

// 5. The two cleanup paths in this agent's own files go through the same helper
//    — they are the other places that believed they were deleting bytes.
const finalize = stripComments(read('src/app/api/visualizer/finalize/route.ts'))
check('finalize\'s reference-checked delete is verified too',
  /removeStorageObjectsLogged\(VIDEO_BUCKET, \[key\]/.test(finalize))
check('…and finalize no longer calls storage.remove() bare',
  !/storage[\s\S]{0,80}?\.remove\(/.test(finalize))

const store = stripComments(read('src/lib/visualizer-store.ts'))
check('storeVisualizer\'s un-indexed-upload cleanup is verified',
  /removeStorageObjectsLogged\(VIDEO_BUCKET, \[uploadData\.path\]/.test(store))
check('indexVisualizer\'s discard path is verified',
  /removeStorageObjectsLogged\(VIDEO_BUCKET, \[args\.storagePath\]/.test(store))
check('…and neither calls storage.remove() bare any more',
  !/storage[\s\S]{0,80}?\.remove\(/.test(store))

// 6. Boot wiring, following the healWebmVisualizers precedent: fire-and-forget,
//    never awaited, every failure swallowed.
const instrumentation = stripComments(read('instrumentation.ts'))
check('the sweep is wired into boot', /video-orphan-reaper/.test(instrumentation))
check('it runs AFTER the WebM heal settles, not racing it',
  instrumentation.indexOf('visualizer-transcode') < instrumentation.indexOf('video-orphan-reaper')
  && /healWebmVisualizers\(\)[\s\S]{0,200}?video-orphan-reaper/.test(instrumentation))
check('a failing sweep cannot take down boot',
  /video-orphan-reaper[\s\S]{0,200}?\.catch\(\(\) => \{\}\)/.test(instrumentation))
// The reaper is reached through `.then()` off the transcode heal, so it is never
// spelled `await import('./src/lib/video-orphan-reaper')` and this check cannot
// fail for the defect it names. The realistic regression is awaiting the HEAD of
// that chain, which blocks boot on the whole sweep — and that stays green here.
check('boot does not await it', !/await import\('\.\/src\/lib\/video-orphan-reaper'\)/.test(instrumentation))
check('…nor awaits the chain the sweep hangs off, which would block boot on it',
  !/await\s+import\('\.\/src\/lib\/visualizer-transcode'/.test(instrumentation))

// 7. Guards on the sweep itself.
check('the sweep no-ops without a service-role key',
  /SUPABASE_SERVICE_ROLE_KEY[\s\S]{0,40}?return/.test(reaper))
check('concurrent sweeps are excluded', /reapRunning/.test(reaper))
check('there is a kill switch that skips the sweep entirely',
  /mode === 'off'/.test(stripComments(reaper)))
// The property that actually protects production: DELETION IS OPT-IN. Railway
// boots the new build the instant the PR merges, so a live-by-default sweep
// would make this code's first-ever run an unattended destructive one. Asserted
// on the predicate, not on the presence of the string 'dry-run' — the check
// above passes on a mere comment, which is exactly the vacuous kind of green
// this suite exists to prevent.
check('deletion is OPT-IN — an unset VIDEO_ORPHAN_REAPER must dry-run, not delete',
  /const dryRun = mode !== 'on'/.test(stripComments(reaper)))
check('dry run returns before any removal',
  /if \(dryRun\)[\s\S]{0,300}?return/.test(reaper))
check('one boot cannot delete unboundedly', /REAP_MAX_DELETES/.test(reaper))

console.log(failures === 0 ? '\nAll video-orphan-reaper tests passed' : `\n${failures} video-orphan-reaper test(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
