// POST /api/auth/delete-account storage-scoping contract test.
//
// Run: node scripts/delete-account-scope-test.mjs
//
// THE BUG THIS EXISTS FOR
// Account deletion collected every storage URL its own rows named and removed
// those objects with NO reference check of any kind. Storage objects are not
// privately owned by the row that names them: isSupabaseStorageUrl() — the only
// guard on PATCH /api/projects/[id]'s artwork_url and POST
// /api/visualizer/finalize's sourceImageUrl — validates the protocol and
// hostname and nothing else. So a crafted request can make account A's row point
// at account B's LIVE cover, and deleting A then destroyed B's artwork, leaving
// a 404 on B's live project. (Latent, not a live incident: production has
// multiply-referenced mf-artwork objects but every one is same-user today.)
//
// TWO FILTERS, COVERING DIFFERENT HALVES — neither is sufficient alone.
//   1. filterToOwnedPrefixes: a key whose FIRST PATH SEGMENT is a project id
//      must be a project this user owns. Pure, cannot fail. This is the only
//      thing that catches an UNREFERENCED object under a stranger's prefix
//      (a superseded `finalized-<ts>.jpg` of theirs), which a reference check
//      cannot see because nothing points at it.
//   2. The survivor scan: after the user's rows are gone, anything still naming
//      a candidate object is a different, live owner. This is the only thing
//      that can judge keys with no project id in them at all.
//
// WHY FILTER 1 CANNOT BE THE ONLY FILTER (the mf-audio root-key split)
// Measured against production: 116 of 390 mf-audio objects sit at the BUCKET
// ROOT. Only 5 are the iOS `<UUID>-v<n>-<ts>.wav` shape — the other 111 are
// plain human filenames (`HALFWAY - MIX 1.wav`) that name no project at all.
// A filter demanding a project-id prefix would refuse to delete a user's OWN
// root uploads, leaving their audio in a PUBLIC bucket after a GDPR erasure, in
// the one bucket with no sweeper. So unattributable keys pass filter 1 untouched
// and are judged by the scan alone. That regression is asserted directly below.
//
// Layers:
//   A) The real pure functions (src/lib/project-assets.ts) under Node type
//      stripping — key attribution, the owned-prefix filter, the survivor scan
//      driven by a fake select, and the composed pipeline against a crafted
//      cross-account attack.
//   B) Source contracts over the route for what a pure test cannot see: that
//      bytes are removed only AFTER the rows are gone and AFTER the partial-
//      delete abort gate, that both filters are wired in, that the scan is NOT
//      owner-scoped, and that a failed scan removes nothing.
//
// Pure — no DB, no network.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { stripComments, functionBody, bracketedBlock } from './source-contract.mjs'
import {
  AUDIO_BUCKET,
  ARTWORK_BUCKET,
  VIDEO_BUCKET,
  ASSET_URL_CHUNK,
  ASSET_URL_COLUMNS,
  collectAssetKeys,
  collectAssetUrls,
  keyProjectId,
  filterToOwnedPrefixes,
  scanSurvivingKeys,
  keysSafeToDelete,
} from '../src/lib/project-assets.ts'
// The bound the account path now shares with DELETE /api/projects/[id].
import { SCAN_CONCURRENCY } from '../src/lib/survivor-scan-plan.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const SB = 'https://mdefkqaawrusoaojstpq.supabase.co'
// PA — a project the deleting account owns. PB — a victim's project.
const PA = 'b0642fc1-e7ab-4171-83d7-85b6f11a8742'
const PB = '727255a7-fd23-42f9-aa7c-63acf9898093'
const audioUrl = (k) => `${SB}/storage/v1/object/public/mf-audio/${k}`
const artUrl = (k) => `${SB}/storage/v1/object/public/mf-artwork/${k}`
const vidUrl = (k) => `${SB}/storage/v1/object/public/mf-video/${k}`

const EMPTY = { 'mf-audio': [], 'mf-artwork': [], 'mf-video': [] }
const keys = (o) => ({ ...EMPTY, ...o })

// The three real bucket-root shapes measured in production mf-audio.
const LEGACY_ROOT = 'HALFWAY - MIX 1.wav'                                  // 111 of 116
const IOS_ROOT = 'A9241D7E-A296-49CE-8D92-5C76533BAB0F-v19-1786837847.wav' //   5 of 116

// ── A1) Key attribution ─────────────────────────────────────────────────────
console.log('\n— key attribution —')

check('a `<projectId>/name` key attributes itself to that project',
  keyProjectId(`${PA}/cover.jpg`) === PA, String(keyProjectId(`${PA}/cover.jpg`)))

// THE mf-audio regression guard, at its source. If these ever start returning a
// project id, filterToOwnedPrefixes begins refusing a user's own root uploads.
check('a legacy bucket-root filename attributes itself to NOBODY',
  keyProjectId(LEGACY_ROOT) === null, String(keyProjectId(LEGACY_ROOT)))
check('an iOS bucket-root `<UUID>-v<n>-<ts>.wav` attributes itself to NOBODY (no separator)',
  keyProjectId(IOS_ROOT) === null, String(keyProjectId(IOS_ROOT)))

// Real non-UUID first segments in production: `covers/` (1 mf-artwork object)
// and `test-probe/` (1 mf-audio object). Neither names a project.
check('a non-UUID first segment attributes itself to nobody',
  keyProjectId(`covers/${PA}/ai-1.jpg`) === null
  && keyProjectId('test-probe/1775417642024.bin') === null)

check('a partial/truncated UUID segment is not accepted as a project id',
  keyProjectId('b0642fc1/cover.jpg') === null
  && keyProjectId(`${PA}x/cover.jpg`) === null)

// iOS spells UUIDs uppercase; Postgres spells project ids lowercase.
check('an uppercase project prefix is normalised to lowercase',
  keyProjectId(`${PA.toUpperCase()}/cover.jpg`) === PA)

// ── A2) The owned-prefix filter ─────────────────────────────────────────────
console.log('\n— owned-prefix filter —')

{
  const candidates = keys({
    'mf-artwork': [`${PA}/mine.jpg`, `${PB}/victim-cover.jpg`],
    'mf-video': [`${PA}/viz.mp4`, `${PB}/viz.mp4`],
  })
  const kept = filterToOwnedPrefixes(candidates, [PA])
  check('a key under the deleting user\'s OWN project prefix is kept',
    kept[ARTWORK_BUCKET].includes(`${PA}/mine.jpg`) && kept[VIDEO_BUCKET].includes(`${PA}/viz.mp4`),
    JSON.stringify(kept[ARTWORK_BUCKET]))
  check('a key under ANOTHER user\'s project prefix is dropped',
    !kept[ARTWORK_BUCKET].includes(`${PB}/victim-cover.jpg`)
    && !kept[VIDEO_BUCKET].includes(`${PB}/viz.mp4`),
    JSON.stringify(kept))
}

// The regression the brief warned about: an owner-scope filter that assumed a
// project-id first segment would refuse to delete ALL of a user's own iOS and
// legacy uploads — 116 of 390 mf-audio objects — leaving them public forever.
{
  const candidates = keys({ 'mf-audio': [LEGACY_ROOT, IOS_ROOT, 'test-probe/1775417642024.bin'] })
  const kept = filterToOwnedPrefixes(candidates, [PA])
  check('unattributable keys (bucket-root + non-UUID prefix) are NOT dropped by this filter',
    kept[AUDIO_BUCKET].length === 3
    && kept[AUDIO_BUCKET].includes(LEGACY_ROOT)
    && kept[AUDIO_BUCKET].includes(IOS_ROOT),
    JSON.stringify(kept[AUDIO_BUCKET]))
  // …and they stay unattributable even when the user owns NO projects at all,
  // which is the state of an account whose projects row select came back empty.
  check('unattributable keys survive the filter even with an empty owned set',
    filterToOwnedPrefixes(candidates, [])[AUDIO_BUCKET].length === 3)
}

check('an owned id spelled uppercase still matches a lowercase key prefix',
  filterToOwnedPrefixes(keys({ 'mf-artwork': [`${PA}/c.jpg`] }), [PA.toUpperCase()])[ARTWORK_BUCKET].length === 1)

check('the filter is per-bucket, not global',
  filterToOwnedPrefixes(
    keys({ 'mf-audio': [`${PB}/a.wav`], 'mf-artwork': [`${PA}/a.jpg`] }), [PA],
  )[AUDIO_BUCKET].length === 0)

// ── A3) The survivor scan ───────────────────────────────────────────────────
console.log('\n— survivor scan —')

// A select that RECORDS what it was asked, and answers from a per-column table.
function recordingSelect(rowsByColumn = {}, failOn = null) {
  const asked = []
  const select = async (table, column, urls) => {
    asked.push({ table, column, urls: [...urls] })
    if (failOn && failOn.table === table && failOn.column === column) return null
    return (rowsByColumn[column] ?? []).filter(r => urls.includes(r[column]))
  }
  return { asked, select }
}

{
  const survivorUrl = artUrl(`${PB}/victim-cover.jpg`)
  const { asked, select } = recordingSelect({ artwork_url: [{ artwork_url: survivorUrl }] })
  const scan = await scanSurvivingKeys(select, [survivorUrl, audioUrl(LEGACY_ROOT)])

  check('a URL a surviving row still names comes back as a protected key',
    scan !== null && scan.survivors[ARTWORK_BUCKET].includes(`${PB}/victim-cover.jpg`),
    JSON.stringify(scan))
  check('a URL NOTHING still names is not protected',
    scan !== null && scan.survivors[AUDIO_BUCKET].length === 0,
    JSON.stringify(scan?.survivors?.[AUDIO_BUCKET]))

  // This path asks only the URL-scoped question, so it has no prefix pass to
  // lose and must never hand back a downgraded scan. If it ever grows one, the
  // bucket-root argument has to be re-derived for it rather than inherited.
  check('the account path always reports FULL coverage',
    scan !== null && scan.coverage === 'all', String(scan?.coverage))

  // Every (table, column) pair in the shared list must actually be queried — a
  // pair that is declared but never asked protects nothing.
  const askedPairs = new Set(asked.map(a => `${a.table}.${a.column}`))
  check('every declared (table, column) pair is actually queried',
    ASSET_URL_COLUMNS.every(([t, c]) => askedPairs.has(`${t}.${c}`)),
    ASSET_URL_COLUMNS.filter(([t, c]) => !askedPairs.has(`${t}.${c}`)).join(' ') || 'all queried')
}

// Rows must be routed to the row-TYPE their table implies, or the derivation
// reads the wrong column off them and the survivor silently vanishes.
{
  const { select } = recordingSelect({ audio_url: [{ audio_url: audioUrl(LEGACY_ROOT) }] })
  const scan = await scanSurvivingKeys(select, [audioUrl(LEGACY_ROOT)])
  check('an mb_versions hit is derived as an AUDIO key',
    scan !== null && scan.survivors[AUDIO_BUCKET].includes(LEGACY_ROOT),
    JSON.stringify(scan))
}
{
  const { select } = recordingSelect({ source_image_url: [{ source_image_url: artUrl(`${PB}/s.jpg`) }] })
  const scan = await scanSurvivingKeys(select, [artUrl(`${PB}/s.jpg`)])
  check('an mb_visualizers hit is derived as an ARTWORK key',
    scan !== null && scan.survivors[ARTWORK_BUCKET].includes(`${PB}/s.jpg`),
    JSON.stringify(scan))
}

// A surviving MP4 must also protect the WebM twin the transcode heal left
// behind, because that twin is exactly how the candidate set names it too.
{
  const mp4 = vidUrl(`${PB}/viz-9-h264.mp4`)
  const { select } = recordingSelect({ video_url: [{ video_url: mp4 }] })
  const scan = await scanSurvivingKeys(select, [mp4])
  check('a surviving MP4 also protects its pre-conversion WebM twin',
    scan !== null
    && scan.survivors[VIDEO_BUCKET].includes(`${PB}/viz-9-h264.mp4`)
    && scan.survivors[VIDEO_BUCKET].includes(`${PB}/viz-9.webm`),
    JSON.stringify(scan?.survivors?.[VIDEO_BUCKET]))
}

// Fail-safe, per chunk. A lookup that could not be answered cannot tell a shared
// object from an exclusively owned one — so the URLs it was asking about are
// PROTECTED (folded in as assumed survivors), rather than discarding the whole
// scan. This is the same degradation DELETE /api/projects/[id] performs; the two
// paths deliberately share one implementation. The safety property under test is
// not "returns null" — it is "the object nobody could vouch for is not deleted".
for (const failOn of [
  { table: 'mb_versions', column: 'audio_url' },
  { table: 'mb_projects', column: 'artwork_url' },
  { table: 'mb_visualizers', column: 'source_image_url' },
]) {
  const { select } = recordingSelect({}, failOn)
  const key = `${PA}/a.jpg`
  const out = await scanSurvivingKeys(select, [artUrl(key)])
  check(`a failed lookup on ${failOn.table}.${failOn.column} PROTECTS the unanswered object`,
    out !== null && out.survivors[ARTWORK_BUCKET].includes(key), JSON.stringify(out))
}

// ...but learning NOTHING is an outage, not a partial answer. If every lookup
// fails, an empty survivor set would read as "no row references any of these"
// and authorise deleting every candidate — so that case must still be null.
{
  const failEverything = async () => null
  const out = await scanSurvivingKeys(failEverything, [artUrl(`${PA}/a.jpg`), audioUrl(`${PA}/m.wav`)])
  check('a scan where EVERY lookup fails returns null, never an empty survivor set',
    out === null, JSON.stringify(out))
}

// Chunking: candidate URLs travel in the PostgREST query string, and one
// over-long request line would fail the whole scan — i.e. delete nothing.
{
  const urls = Array.from({ length: ASSET_URL_CHUNK * 2 + 7 }, (_, i) => audioUrl(`${PA}/m${i}.wav`))
  const { asked, select } = recordingSelect()
  await scanSurvivingKeys(select, urls)
  const maxChunk = Math.max(...asked.map(a => a.urls.length))
  check('no lookup is sent more URLs than the chunk size',
    maxChunk <= ASSET_URL_CHUNK, `max=${maxChunk} limit=${ASSET_URL_CHUNK}`)
  const seen = new Set(asked.filter(a => a.column === 'audio_url').flatMap(a => a.urls))
  check('chunking loses no URL: every candidate is asked about, per column',
    seen.size === urls.length && urls.every(u => seen.has(u)), `${seen.size}/${urls.length}`)
}

// Bounded fan-out — measured, not asserted from source text.
//
// This is the heavier of the two survivor-scan callers: DELETE /api/projects/[id]
// fans out over ONE project's versions, account deletion over EVERY project the
// user owns. The old form was Promise.all over columns × chunks with no limit
// (7 columns × 3 chunks = 21 simultaneous PostgREST GETs here, and ~150 for a
// real large account), and its failure mode was the bad one: the scan gives up,
// storage cleanup is skipped entirely, and a GDPR deletion silently leaves every
// byte in a public bucket while reporting success.
{
  const urls = Array.from({ length: ASSET_URL_CHUNK * 3 }, (_, i) => audioUrl(`${PA}/c${i}.wav`))
  let inFlight = 0
  let peak = 0
  const select = async () => {
    inFlight++
    peak = Math.max(peak, inFlight)
    // Yield twice so every task that COULD start concurrently has actually been
    // given the chance to — otherwise a serial implementation and a bounded one
    // are indistinguishable and this check passes vacuously.
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))
    inFlight--
    return []
  }
  await scanSurvivingKeys(select, urls)
  check('survivor-scan fan-out is bounded to SCAN_CONCURRENCY',
    peak > 0 && peak <= SCAN_CONCURRENCY, `peak=${peak} limit=${SCAN_CONCURRENCY}`)
  // Guards the guard: with 21 tasks available, a peak of 1 would mean the scan
  // went fully serial and the bound above would pass for the wrong reason.
  check('...and it is genuinely concurrent, not accidentally serialised',
    peak > 1, `peak=${peak}`)
}

{
  let asked = false
  const out = await scanSurvivingKeys(async () => { asked = true; return [] }, [])
  check('an empty candidate list asks nothing and protects nothing',
    !asked && out !== null && JSON.stringify(out.survivors) === JSON.stringify(EMPTY),
    `asked=${asked} out=${JSON.stringify(out)}`)
}

// ── A4) The composed pipeline, against a crafted cross-account attack ────────
console.log('\n— composed pipeline: crafted cross-account references —')

{
  // Account A owns exactly one project, PA. Two of its rows have been pointed at
  // victim B's objects under PB — the thing isSupabaseStorageUrl cannot prevent.
  const victimLive = `${PB}/victim-cover.jpg`        // B's LIVE cover — B's row names it
  const victimOrphan = `${PB}/finalized-old.jpg`     // B's superseded render — NOTHING names it
  // A bucket-root key carries NO owner, so filter 1 cannot judge it and the
  // reference check is the only thing standing between this object and a
  // deletion that breaks B's live mix. This is the case that makes the scan
  // load-bearing rather than belt-and-braces.
  const sharedRoot = 'SHARED - MIX 1.wav'
  const attackerRows = {
    projects: [{
      artwork_url: artUrl(victimLive),               // crafted
      finalized_artwork_url: artUrl(`${PA}/finalized-1.jpg`),
    }],
    versions: [
      { audio_url: audioUrl(LEGACY_ROOT) },          // A's own legacy root upload
      { audio_url: audioUrl(`${PA}/mix.wav`) },      // A's own web upload
      { audio_url: audioUrl(sharedRoot) },           // root key B's row ALSO names
    ],
    visualizers: [{ source_image_url: artUrl(victimOrphan) }], // crafted
  }

  // Exactly what the route does, using only the real functions.
  const collected = collectAssetKeys(attackerRows)
  const candidateUrls = collectAssetUrls(attackerRows)
  const candidates = filterToOwnedPrefixes(collected, [PA])
  const { select } = recordingSelect({
    artwork_url: [{ artwork_url: artUrl(victimLive) }],
    audio_url: [{ audio_url: audioUrl(sharedRoot) }],
  })
  const scan = await scanSurvivingKeys(select, candidateUrls)
  const survivors = scan.survivors
  const doomed = keysSafeToDelete(candidates, scan)
  const doomedArt = doomed[ARTWORK_BUCKET]
  const doomedAudio = doomed[AUDIO_BUCKET]

  check('the victim\'s LIVE cover is NOT deleted',
    !doomedArt.includes(victimLive), JSON.stringify(doomedArt))

  // The reference check earning its keep: nothing in this key names a project,
  // so no amount of prefix reasoning could have saved it.
  check('a bucket-root object another account still names is NOT deleted (only the scan sees this)',
    !doomedAudio.includes(sharedRoot) && survivors[AUDIO_BUCKET].includes(sharedRoot),
    `doomed=${JSON.stringify(doomedAudio)}`)

  // The load-bearing case for filter 1: no surviving row names this object, so
  // the reference check alone would happily delete a stranger's bytes.
  check('the victim\'s UNREFERENCED superseded render is NOT deleted (scan alone would miss it)',
    !doomedArt.includes(victimOrphan)
    && !survivors[ARTWORK_BUCKET].includes(victimOrphan),
    `doomed=${JSON.stringify(doomedArt)} survivors=${JSON.stringify(survivors[ARTWORK_BUCKET])}`)

  check('the deleting user\'s OWN artwork IS still deleted',
    doomedArt.includes(`${PA}/finalized-1.jpg`), JSON.stringify(doomedArt))

  // The GDPR half: the root key carries no owner, so only the scan can clear it.
  check('the deleting user\'s OWN bucket-root audio IS still deleted (GDPR erasure holds)',
    doomedAudio.includes(LEGACY_ROOT), JSON.stringify(doomedAudio))
  check('the deleting user\'s OWN prefixed audio IS still deleted',
    doomedAudio.includes(`${PA}/mix.wav`), JSON.stringify(doomedAudio))
}

// ── A5) The scan's column list must cover the derivation ────────────────────
console.log('\n— column coverage —')

const assetsSrc = stripComments(read('src/lib/project-assets.ts'))
const collectUrlsFn = functionBody(assetsSrc, 'export function collectAssetUrls')
const derivedColumns = [...new Set([...collectUrlsFn.matchAll(/\.(\w+_url)\b/g)].map(m => m[1]))]

// `>= 7`, not `=== 7`: adding a URL column to the derivation must fail the
// COVERAGE check below (the scan needs it too), not this locator.
check('the URL columns the derivation reads were located',
  derivedColumns.length >= 7, derivedColumns.join(', '))

const scanned = ASSET_URL_COLUMNS.map(([t, c]) => `${t}.${c}`)
check('every URL column the derivation reads is covered by the scan\'s column list',
  derivedColumns.length > 0 && derivedColumns.every(c => scanned.some(p => p.endsWith(`.${c}`))),
  derivedColumns.filter(c => !scanned.some(p => p.endsWith(`.${c}`))).join(', ') || 'all covered')

for (const pair of [
  'mb_versions.audio_url',
  'mb_projects.artwork_url',
  'mb_projects.finalized_artwork_url',
  'mb_projects.visualizer_url',
  'mb_projects.visualizer_wide_url',
  'mb_projects.instrumental_url',
  'mb_visualizers.video_url',
  'mb_visualizers.source_image_url',
]) {
  check(`the scan's column list includes ${pair}`, scanned.includes(pair))
}

// ── B) Source contracts over the route ──────────────────────────────────────
console.log('\n— route contract —')

const routeRaw = read('src/app/api/auth/delete-account/route.ts')
const routeSrc = stripComments(routeRaw)
const postBody = functionBody(routeSrc, 'export async function POST')

// Positive locator FIRST: an extraction that silently returned '' would make
// every "does NOT contain" and index assertion below vacuous.
check('the POST body was located, with its enumeration and its row deletes',
  postBody.length > 0
  && postBody.includes('collectAssetKeys(')
  && postBody.includes("'mb_projects')"),
  `${postBody.length} chars`)

check('the deleting user comes from the X-User-Id header, never the body',
  /headers\.get\('X-User-Id'\)/.test(postBody) && !/body\.userId/.test(postBody))

// The owned set is the AUTHORITATIVE one: project ids straight from mb_projects
// scoped by user_id. Deriving it from anything the user can influence
// (mb_visualizers.project_id, say) would let a crafted row widen the set and
// re-open the hole this filter closes.
//
// ASSERTS THE SCOPING, NOT THE COLUMN LIST. This used to pin the literal
// 'id, artwork_url, finalized_artwork_url', which made a correct widening of the
// projection look like a security regression while the actual defect — that the
// list was too NARROW — was invisible to it. A test that breaks when the code is
// fixed and stays green when it is broken is worse than no test; the property
// worth guarding is `.eq('user_id', userId)`, and the projection's completeness
// is checked separately against ProjectAssetRow below.
check('the owned project ids come from mb_projects scoped by user_id',
  /from\('mb_projects'\)\s*\.select\(projection\)\s*\.eq\('user_id', userId\)/.test(postBody)
  && /const projectIds = \(projects \?\? \[\]\)\.map\(p => p\.id\)/.test(postBody))

check('the candidate keys are passed through the owned-prefix filter',
  /filterToOwnedPrefixes\(\s*collected\s*,\s*projectIds\s*\)/.test(postBody))

check('the candidate URLs for the survivor scan are collected from the same rows',
  /collectAssetKeys\(assetRows\)/.test(postBody) && /collectAssetUrls\(assetRows\)/.test(postBody))

// ── The asset enumerations must not truncate ────────────────────────────────
// These two carried no `.limit()` at all, which is NOT "no ceiling" — it hands
// the decision to PostgREST's server-side `max-rows`, invisibly. This is also
// the REACHABLE half of that bug: DELETE /api/projects/[id] enumerates one
// project (max 20 versions), this enumerates every project an account owns (271
// versions for the largest account today). Rows past the cut keep their audio in
// a PUBLIC bucket after a GDPR erasure, in the one bucket with no sweeper.
check('no asset enumeration in the account path carries a truncating .limit()',
  !/\.limit\(\d+\)/.test(postBody), (postBody.match(/\.limit\(\d+\)/g) ?? []).join(' ') || 'none')

check('all four enumerations page through collectAllRows',
  (postBody.match(/collectAllRows</g) ?? []).length === 4,
  `${(postBody.match(/collectAllRows</g) ?? []).length} call(s)`)

// Offset paging over an UNORDERED PostgREST result can repeat one row and skip
// another; a skipped version is audio nothing will ever name again.
check('every paged enumeration orders by the primary key, so offsets are stable',
  (postBody.match(/\.order\('id', \{ ascending: true \}\)\.range\(offset, offset \+ limit - 1\)/g) ?? []).length === 4,
  `${(postBody.match(/\.order\('id'/g) ?? []).length} ordered`)

// The DIRECTION an incomplete enumeration must fail in. Every dependent of
// mb_versions that carries user data cascades, and the row deletes are keyed by
// project/user rather than by these lists — so an unreadable list costs bytes,
// not PII. Blocking the erasure over that would trap the user in an undeletable
// account, which this route explicitly must never do.
{
  const enumFailBlock = bracketedBlock(postBody, 'if (rows === null)')
  check('the incomplete-enumeration branch was located',
    enumFailBlock.length > 0 && /console\.error/.test(enumFailBlock), `${enumFailBlock.length} chars`)
  check('an incomplete enumeration is logged and the deletion CONTINUES, never blocked',
    !/return NextResponse/.test(enumFailBlock) && /Sentry\.captureMessage\(/.test(enumFailBlock))
}

// A page fetcher that turned an error into `[]` would end the enumeration at the
// first blip and pass the truncated result off as complete.
{
  const pageFn = functionBody(routeSrc, 'async function fetchRowPage')
  check('the page fetcher was located',
    pageFn.length > 0 && /await query/.test(pageFn), `${pageFn.length} chars`)
  check('a page error becomes null, never an empty page',
    /if \(error\) \{[\s\S]*?return null/.test(pageFn) && !/return \[\]/.test(pageFn))
}

// ORDER: rows first, bytes second. The scan can only tell a stranger's row from
// this user's own once this user's rows are gone.
// Anchored to the `.delete()` chains specifically. `'mb_projects')` alone also
// matches the ENUMERATION select at the top of POST, which sits before the
// removal either way — so that anchor stayed green with the removal moved back
// ahead of every row delete, i.e. while measuring nothing at all.
const iFirstRowDelete = postBody.indexOf("from('mb_feedback').delete()")
const iProjectsDelete = postBody.indexOf("from('mb_projects').delete()")
const iRemove = postBody.indexOf('removeAccountAssets(')
check('the row-delete statements were located',
  iFirstRowDelete !== -1 && iProjectsDelete !== -1 && iRemove !== -1,
  `feedback=${iFirstRowDelete} projects=${iProjectsDelete} remove=${iRemove}`)
check('bytes are removed AFTER the DB rows are deleted',
  iFirstRowDelete < iRemove && iProjectsDelete < iRemove,
  `feedbackDelete=${iFirstRowDelete} projectsDelete=${iProjectsDelete} remove=${iRemove}`)

// The partial-delete abort returns "no changes were finalized". That was a lie
// while bytes went first: the account survived with every mix and cover 404ing.
const abortBlock = bracketedBlock(postBody, 'if (dbErrors.length > 0)')
check('the partial-delete abort branch was located',
  abortBlock.length > 0 && /status: 500/.test(abortBlock), `${abortBlock.length} chars`)
check('bytes are removed only AFTER the partial-delete abort gate',
  iRemove > postBody.indexOf(abortBlock) + abortBlock.length,
  `abortEnd=${postBody.indexOf(abortBlock) + abortBlock.length} remove=${iRemove}`)
check('the abort branch itself touches no bytes',
  !/removeAccountAssets|removeStorageObjects/.test(abortBlock))

// Nothing may delete bytes inline in POST any more — it all goes through the
// helper that runs the scan first.
check('POST never calls the storage remover directly',
  !/removeStorageObjects\(/.test(postBody))

// ── The removal helper, sliced as a function rather than guessed at ─────────
const removeFn = functionBody(routeSrc, 'async function removeAccountAssets')

check('the removal helper was located, with its scan and its subtraction',
  removeFn.length > 0
  && /scanSurvivingKeys\(select, candidateUrls\)/.test(removeFn)
  && /keysSafeToDelete\(candidates, scan\)/.test(removeFn),
  `${removeFn.length} chars`)

// The whole point: the scan must see OTHER accounts' rows. Scoping it to the
// deleting user would look straight past the row that proves the object is live.
check('the survivor scan is NOT scoped to the deleting user',
  !/\.eq\(\s*['"]user_id['"]/.test(removeFn) && !/\.neq\(\s*['"]user_id['"]/.test(removeFn))

// The keys actually handed to storage are the SUBTRACTED set, not the raw
// candidates — passing `candidates` here would make the scan decorative.
check('the removal loop iterates the subtracted set, not the raw candidates',
  /const doomed = keysSafeToDelete\(candidates, scan\)/.test(removeFn)
  && /const paths = doomed\[bucket\]/.test(removeFn)
  && !/const paths = candidates\[bucket\]/.test(removeFn))

// The coverage rule must be APPLIED, not merely available. A bare
// subtractKeys(candidates, scan.survivors) here would spend a downgraded scan as
// though it were a complete one — the exact confusion SurvivorScan encodes
// against — so the raw subtraction is banned from this function outright.
check('the removal helper does not subtract around the coverage rule',
  !/subtractKeys\(/.test(removeFn))

const scanFailBlock = bracketedBlock(removeFn, 'if (!scan)')
check('the failed-scan branch was located',
  scanFailBlock.length > 0 && /console\.error/.test(scanFailBlock), `${scanFailBlock.length} chars`)
check('a failed survivor scan removes NOTHING (fail towards leaking, not deleting)',
  /\breturn\b/.test(scanFailBlock) && !/removeStorageObjects\(/.test(scanFailBlock))

check('removal goes through the VERIFYING helper, not a raw .remove()',
  /removeStorageObjects\(/.test(removeFn) && !/storage\.from\([^)]*\)\.remove\(/.test(routeSrc))

check('an unconfirmed removal is reported per bucket rather than assumed to have worked',
  /if \(outcome\.ok\) continue/.test(removeFn) && /Sentry\.captureMessage\(/.test(removeFn))

check('the client-visible success shape is unchanged ({ ok: true })',
  /NextResponse\.json\(\{ ok: true \}\)/.test(postBody))

// ── The enumeration projection must cover every column the consumer reads ────
//
// This route has NO prefix sweep. filterToOwnedPrefixes BOUNDS keys that were
// already nominated; it never discovers one. So a storage column missing from
// the mb_projects projection is a byte that survives a GDPR erasure with no
// later pass able to name it — and mf-audio and mf-artwork have no sweeper.
//
// It shipped that way: migration 035 added acapella_url, registered it in
// ASSET_URL_COLUMNS, taught collectAssetKeys to read it, and asserted in its own
// header that "both delete paths see the reference." The survivor scan did. This
// enumeration selected only `id, artwork_url, finalized_artwork_url`, so the read
// saw undefined on every row. Both visualizer pins had the same hole.
//
// Asserting the two ends against each other is the only check that catches it:
// the consumer looks correct in isolation, and so does the producer.
const projectRowType = assetsSrc.match(/export type ProjectAssetRow = \{([\s\S]*?)\}/)
check('ProjectAssetRow type was located in project-assets.ts', !!projectRowType)
const consumedColumns = projectRowType
  ? [...projectRowType[1].matchAll(/(\w+)\??\s*:/g)].map(m => m[1])
  : []
check('ProjectAssetRow declares the asset columns it reads', consumedColumns.length >= 5,
  `parsed: ${consumedColumns.join(', ')}`)

const projectionList = routeSrc.match(/const PROJECT_ASSET_COLUMNS = \[([\s\S]*?)\]/)
check('the route declares PROJECT_ASSET_COLUMNS', !!projectionList)
const selectedColumns = projectionList
  ? [...projectionList[1].matchAll(/'([^']+)'/g)].map(m => m[1])
  : []

for (const column of consumedColumns) {
  check(`projection selects mb_projects.${column} (collectAssetKeys reads it)`,
    selectedColumns.includes(column),
    'a column read off the row but never selected is silently undefined — the bytes leak forever')
}

check('the paged enumeration uses the resolved projection, not a literal',
  /\.from\('mb_projects'\)\.select\(projection\)/.test(routeSrc)
  && !/\.from\('mb_projects'\)\.select\('id, artwork_url, finalized_artwork_url'\)/.test(routeSrc))

// Degrading is only ever allowed for columns the codebase has DECLARED optional.
// Excusing a missing required column would convert a broken enumeration into a
// confident, empty delete list — the same "confidently wrong beats admittedly
// ignorant" failure the survivor scan is built to refuse.
const resolverFn = functionBody(routeSrc, 'async function resolveProjectProjection')
check('the projection resolver was located', resolverFn.length > 0)
check('only OPTIONAL_ASSET_URL_COLUMNS may be dropped from the projection',
  /OPTIONAL_ASSET_URL_COLUMNS\.has\(/.test(resolverFn))
check('a non-column failure is handed back rather than swallowed by the probe',
  /if \(!missing\) return projection/.test(resolverFn))

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
