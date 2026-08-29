// DELETE /api/projects/[id] storage-cleanup contract test.
//
// Run: node scripts/project-delete-assets-test.mjs
//
// THE BUG THIS EXISTS FOR
// DELETE /api/projects/[id] deleted the mb_projects row and nothing else.
// mb_versions and mb_visualizers both CASCADE on project_id, so in the same
// statement every URL that named the project's audio, artwork and video was
// destroyed — after which NOTHING could find those bytes again. Not a later
// project delete, not /api/auth/delete-account (which starts from rows too).
// Only mf-video has a sweeper, so mf-audio and mf-artwork leaked forever, in
// PUBLIC buckets.
//
// Two enumerations are needed and NEITHER is sufficient alone. Production:
//   * mf-audio: 115 of 389 objects (29.6%) sit at the BUCKET ROOT — iOS writes
//     `<UPPERCASE-UUID>-v<n>-<ts>.wav` there. No `<projectId>/` listing sees
//     them, so only the column URLs can.
//   * mf-artwork: 202 superseded `finalized-<ts>.jpg` / `ai-<ts>.jpg` renders
//     that no column points at (every Finalize click writes a new one and
//     repoints the row). Only a prefix listing can see those.
// The layer that keeps this honest is the union, so it is tested directly.
//
// The other half of correctness is NOT deleting too much: a storage object can
// legitimately back two projects (PATCH accepts any Supabase storage URL as
// artwork_url), and two mf-artwork objects are shared that way in production
// right now. Deleting a shared object destroys a LIVE project's media, which is
// strictly worse than the orphan this change exists to prevent.
//
// Layers:
//   A) The real derivation (src/lib/project-assets.ts) under Node type
//      stripping — dedupe, the mixed root/prefixed audio batch, the WebM twin.
//   B) The real prefix walker driven by a fake ListPage, including the guard
//      that an empty/short/non-UUID prefix can NEVER reach a listing — an empty
//      prefix would sweep a 23 GB bucket.
//   C) Source contracts over the route for the things a pure test cannot see:
//      the ORDER of enumerate → delete row → remove bytes, the ownership guard,
//      verified removal, and fail-safe behaviour when the survivor scan breaks.
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
  ASSET_PAGE_SIZE,
  ROW_PAGE_SIZE,
  ROW_MAX_PAGES,
  collectAllRows,
  storagePathFromUrl,
  collectAssetKeys,
  collectAssetUrls,
  subtractKeys,
  unionKeys,
  totalKeyCount,
  listProjectPrefix,
} from '../src/lib/project-assets.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// stripComments / functionBody / bracketedBlock come from scripts/source-contract.mjs
// so every suite strips and slices the same way. See that file for why source
// contracts are anchored to syntactic regions rather than character windows.

const SB = 'https://mdefkqaawrusoaojstpq.supabase.co'
const PROJECT = 'b0642fc1-e7ab-4171-83d7-85b6f11a8742'
const audioUrl = (k) => `${SB}/storage/v1/object/public/mf-audio/${k}`
const artUrl = (k) => `${SB}/storage/v1/object/public/mf-artwork/${k}`
const vidUrl = (k) => `${SB}/storage/v1/object/public/mf-video/${k}`

// ── A) The real derivation ──────────────────────────────────────────────────
console.log('\n— derivation —')

check('bucket names are the three real buckets',
  AUDIO_BUCKET === 'mf-audio' && ARTWORK_BUCKET === 'mf-artwork' && VIDEO_BUCKET === 'mf-video')

check('a public URL yields the key after the bucket segment',
  storagePathFromUrl(artUrl(`${PROJECT}/cover.jpg`), 'mf-artwork') === `${PROJECT}/cover.jpg`)
check('a URL for a DIFFERENT bucket yields null',
  storagePathFromUrl(audioUrl('x.wav'), 'mf-artwork') === null)
check('a transient non-Supabase URL yields null',
  storagePathFromUrl('https://replicate.delivery/pbxt/abc.jpg', 'mf-artwork') === null)
check('null/empty yields null',
  storagePathFromUrl(null, 'mf-artwork') === null && storagePathFromUrl('', 'mf-artwork') === null)

// The mixed batch that made echo-matching hazardous: iOS writes a BUCKET-ROOT
// key, the web writes a `<projectId>/` key, and both are live in mf-audio.
const iosKey = 'A9241D7E-A296-49CE-8D92-5C76533BAB0F-v19-1786837847.wav'
const webKey = `${PROJECT}/1786795143590.wav`
const mixed = collectAssetKeys({
  versions: [{ audio_url: audioUrl(iosKey) }, { audio_url: audioUrl(webKey) }],
})
check('a mixed iOS-root + web-prefixed audio batch keeps BOTH shapes',
  mixed[AUDIO_BUCKET].length === 2
  && mixed[AUDIO_BUCKET].includes(iosKey)
  && mixed[AUDIO_BUCKET].includes(webKey),
  JSON.stringify(mixed[AUDIO_BUCKET]))

check('the iOS root key keeps no leading slash (it is a bucket-root key)',
  !mixed[AUDIO_BUCKET].find(k => k.startsWith('/')))

// Source artwork and the finalized render are two DIFFERENT objects.
const both = collectAssetKeys({
  projects: [{
    artwork_url: artUrl(`${PROJECT}/ai-1.jpg`),
    finalized_artwork_url: artUrl(`${PROJECT}/finalized-2.jpg`),
  }],
})
check('source artwork AND the finalized render are both collected',
  both[ARTWORK_BUCKET].length === 2
  && both[ARTWORK_BUCKET].includes(`${PROJECT}/ai-1.jpg`)
  && both[ARTWORK_BUCKET].includes(`${PROJECT}/finalized-2.jpg`),
  JSON.stringify(both[ARTWORK_BUCKET]))

// The WebM→MP4 heal repoints the row at the twin and leaves the original.
const twin = collectAssetKeys({
  visualizers: [{ video_url: vidUrl(`${PROJECT}/viz-9-h264.mp4`) }],
})
check('an MP4 twin also yields its pre-conversion WebM original',
  twin[VIDEO_BUCKET].includes(`${PROJECT}/viz-9-h264.mp4`)
  && twin[VIDEO_BUCKET].includes(`${PROJECT}/viz-9.webm`),
  JSON.stringify(twin[VIDEO_BUCKET]))
check('a non-twin video yields exactly one key',
  collectAssetKeys({ visualizers: [{ video_url: vidUrl(`${PROJECT}/viz-9.mp4`) }] })[VIDEO_BUCKET].length === 1)

// source_image_url is the still an AI visualizer was generated FROM; it lives
// in mf-artwork and delete-account used to miss it entirely.
check('a visualizer source_image_url is collected as ARTWORK',
  collectAssetKeys({ visualizers: [{ source_image_url: artUrl(`${PROJECT}/ai-src.jpg`) }] })[ARTWORK_BUCKET]
    .includes(`${PROJECT}/ai-src.jpg`))

// Dedupe: in production every single pin is the same object as a viz row.
const pinned = collectAssetKeys({
  projects: [{ visualizer_url: vidUrl(`${PROJECT}/viz-1.mp4`) }],
  visualizers: [{ video_url: vidUrl(`${PROJECT}/viz-1.mp4`) }],
})
check('a pin that duplicates an mb_visualizers row yields ONE key, not two',
  pinned[VIDEO_BUCKET].length === 1, JSON.stringify(pinned[VIDEO_BUCKET]))

const sameArt = collectAssetKeys({
  projects: [{ artwork_url: artUrl(`${PROJECT}/a.jpg`) }],
  visualizers: [{ source_image_url: artUrl(`${PROJECT}/a.jpg`) }],
})
check('artwork shared between the project and a visualizer source dedupes',
  sameArt[ARTWORK_BUCKET].length === 1)

check('the wide pin is collected too',
  collectAssetKeys({ projects: [{ visualizer_wide_url: vidUrl(`${PROJECT}/w.mp4`) }] })[VIDEO_BUCKET].length === 1)

// A pre-015/020 schema simply has no pin columns; that must not throw.
check('absent pin columns are treated as no pins, not an error',
  collectAssetKeys({ projects: [{ artwork_url: artUrl('a/b.jpg') }] })[VIDEO_BUCKET].length === 0)

check('collectAssetUrls returns the raw URLs for the survivor scan',
  collectAssetUrls({ versions: [{ audio_url: audioUrl(iosKey) }] })[0] === audioUrl(iosKey))

// ── Union: neither enumeration is sufficient alone ─────────────────────────
console.log('\n— union of prefix listing and column URLs —')

const columnOnly = collectAssetKeys({ versions: [{ audio_url: audioUrl(iosKey) }] })
const prefixOnly = {
  'mf-audio': [webKey],
  'mf-artwork': [`${PROJECT}/finalized-superseded.jpg`],
  'mf-video': [],
}
const united = unionKeys(columnOnly, prefixOnly)
check('the union keeps the iOS root key that NO prefix listing can see',
  united[AUDIO_BUCKET].includes(iosKey))
check('the union keeps the superseded render that NO column names',
  united[ARTWORK_BUCKET].includes(`${PROJECT}/finalized-superseded.jpg`))
check('the union dedupes a key both halves found',
  unionKeys({ 'mf-audio': [webKey], 'mf-artwork': [], 'mf-video': [] }, prefixOnly)[AUDIO_BUCKET].length === 1)
check('totalKeyCount counts every bucket',
  totalKeyCount(united) === 3, String(totalKeyCount(united)))

// ── Survivor subtraction: never delete a live project's media ──────────────
console.log('\n— survivor subtraction —')

const shared = `${PROJECT}/cover.jpg`
const candidates = { 'mf-audio': [], 'mf-artwork': [shared, `${PROJECT}/solo.jpg`], 'mf-video': [] }
const survivors = { 'mf-audio': [], 'mf-artwork': [shared], 'mf-video': [] }
const doomed = subtractKeys(candidates, survivors)
check('an object another project still references is NOT deleted',
  !doomed[ARTWORK_BUCKET].includes(shared), JSON.stringify(doomed[ARTWORK_BUCKET]))
check('an exclusively-owned object IS deleted',
  doomed[ARTWORK_BUCKET].includes(`${PROJECT}/solo.jpg`))
check('subtraction is per-bucket, not global',
  subtractKeys(
    { 'mf-audio': ['k'], 'mf-artwork': ['k'], 'mf-video': [] },
    { 'mf-audio': ['k'], 'mf-artwork': [], 'mf-video': [] },
  )['mf-artwork'].length === 1)

// ── B) The real prefix walker ──────────────────────────────────────────────
console.log('\n— prefix listing guard —')

// A ListPage that RECORDS what it was asked for. If the guard ever lets a bad
// prefix through, `asked` proves it reached the listing.
function recorder(pages = {}) {
  const asked = []
  const listPage = async (prefix, offset, limit) => {
    asked.push({ prefix, offset, limit })
    const rows = pages[prefix] ?? []
    return rows.slice(offset, offset + limit)
  }
  return { asked, listPage }
}

// THE critical guard: an empty prefix lists the WHOLE bucket (23 GB of audio).
for (const bad of ['', null, undefined, 'b0642fc1', '../', '/', 'not-a-uuid',
                   `${PROJECT}/`, ` ${PROJECT}`, `${PROJECT}x`]) {
  const { asked, listPage } = recorder()
  const out = await listProjectPrefix(listPage, bad)
  check(`a non-UUID prefix (${JSON.stringify(bad)}) is refused and never listed`,
    out === null && asked.length === 0, `asked=${JSON.stringify(asked)}`)
}

// A valid id lists exactly `<uuid>/` — with the separator, so it cannot
// prefix-match a sibling folder whose name merely starts with the id.
{
  const { asked, listPage } = recorder({
    [`${PROJECT}/`]: [
      { name: 'cover.jpg', id: 'o1', created_at: null },
      { name: 'finalized-2.jpg', id: 'o2', created_at: null },
    ],
  })
  const out = await listProjectPrefix(listPage, PROJECT)
  check('a valid project id lists exactly `<uuid>/`',
    asked.length >= 1 && asked[0].prefix === `${PROJECT}/`, JSON.stringify(asked[0]))
  check('listed entries become FULL keys including the prefix',
    out.length === 2 && out.includes(`${PROJECT}/cover.jpg`) && out.includes(`${PROJECT}/finalized-2.jpg`),
    JSON.stringify(out))
}

// An uppercase UUID is still a UUID (iOS spells them uppercase).
{
  const upper = PROJECT.toUpperCase()
  const { asked, listPage } = recorder({ [`${upper}/`]: [] })
  check('an uppercase project id is accepted',
    (await listProjectPrefix(listPage, upper)) !== null && asked[0].prefix === `${upper}/`)
}

// A listing that fails must not read as "this project owned nothing".
{
  const listPage = async () => null
  check('a failed listing returns null, NOT an empty key list',
    (await listProjectPrefix(listPage, PROJECT)) === null)
}

// Folder entries (id === null) are recursed into, not emitted as keys.
{
  const { listPage } = recorder({
    [`${PROJECT}/`]: [
      { name: 'sub', id: null, created_at: null },
      { name: 'flat.jpg', id: 'o1', created_at: null },
    ],
    [`${PROJECT}/sub/`]: [{ name: 'deep.jpg', id: 'o2', created_at: null }],
  })
  const out = await listProjectPrefix(listPage, PROJECT)
  check('a nested key is collected, and the folder marker is not emitted as a key',
    out.includes(`${PROJECT}/flat.jpg`)
    && out.includes(`${PROJECT}/sub/deep.jpg`)
    && !out.includes(`${PROJECT}/sub`),
    JSON.stringify(out))
}

// Pagination: a full page must be followed by another request.
{
  const many = Array.from({ length: ASSET_PAGE_SIZE + 5 },
    (_, i) => ({ name: `f${i}.jpg`, id: `o${i}`, created_at: null }))
  const { asked, listPage } = recorder({ [`${PROJECT}/`]: many })
  const out = await listProjectPrefix(listPage, PROJECT)
  check('a full page is followed by a second request (no truncation at the page size)',
    out.length === ASSET_PAGE_SIZE + 5 && asked.length === 2,
    `keys=${out.length} pages=${asked.length}`)
  check('the second page is requested at the right offset',
    asked[1].offset === ASSET_PAGE_SIZE)
}

// A server ignoring `offset` must fail the listing, not spin forever.
{
  let calls = 0
  const listPage = async () => {
    calls++
    return Array.from({ length: ASSET_PAGE_SIZE }, (_, i) => ({ name: `f${i}.jpg`, id: 'o', created_at: null }))
  }
  const out = await listProjectPrefix(listPage, PROJECT)
  check('a pager that never advances fails the listing instead of looping forever',
    out === null && calls < 500, `calls=${calls}`)
}

// ── B2) The row paginator ──────────────────────────────────────────────────
console.log('\n— row enumeration paging —')

// The enumeration that feeds every candidate key used to be `.limit(1000)`:
// row 1001 onward was dropped with no error and no warning, and those rows
// CASCADE away with the project moments later, after which nothing can ever
// name their bytes again. Unreachable at today's sizes (largest project = 20
// versions) — but the account path ran the SAME enumeration with no cap written
// at all, which silently inherits PostgREST's server-side `max-rows`, and its
// largest account is at 271 versions. Silent truncation is the defect; the
// number is incidental.

// A pager that RECORDS the ranges it was asked for, so "did it actually page?"
// is measured rather than assumed.
function pager(rows, { failOnPage = -1, serverCap = Infinity } = {}) {
  const asked = []
  const fetchPage = async (offset, limit) => {
    asked.push({ offset, limit })
    if (asked.length - 1 === failOnPage) return null
    // A server may hand back FEWER rows than asked for — PostgREST's own
    // `max-rows` does exactly this. That is the case a "short page ⇒ last page"
    // paginator gets silently wrong.
    return rows.slice(offset, offset + Math.min(limit, serverCap))
  }
  return { asked, fetchPage }
}

{
  const rows = Array.from({ length: 25 }, (_, i) => ({ id: i }))
  const { asked, fetchPage } = pager(rows)
  const out = await collectAllRows(fetchPage, 10, 50)
  check('paging concatenates every row, in order',
    out !== null && out.length === 25 && out.every((r, i) => r.id === i), `got=${out?.length}`)
  // Four requests, not three: the fourth is the empty page that PROVES the
  // third was the last one. Inferring it from the third being short is the
  // truncation this helper exists to refuse.
  check('paging advances the offset by the rows already gathered, and confirms the end',
    asked.length === 4 && JSON.stringify(asked.map(a => a.offset)) === '[0,10,20,25]',
    JSON.stringify(asked.map(a => a.offset)))
}

// THE assertion this helper exists for. With a server cap below the page size
// every page is short, so a paginator that stopped on a short page would return
// the first 4 rows of 25 and call it complete — silently, exactly like the
// `.limit(1000)` it replaced.
{
  const rows = Array.from({ length: 25 }, (_, i) => ({ id: i }))
  const { asked, fetchPage } = pager(rows, { serverCap: 4 })
  const out = await collectAllRows(fetchPage, 10, 50)
  check('a SHORT page does not end the enumeration (a server-side row cap cannot truncate us)',
    out !== null && out.length === 25 && out.every((r, i) => r.id === i), `got=${out?.length} of 25`)
  // The other half of the same hazard: resuming at offset+pageSize after a
  // shortened page would step straight over the rows the server withheld.
  check('...and the offsets follow what was RECEIVED, so nothing is stepped over',
    JSON.stringify(asked.map(a => a.offset)) === '[0,4,8,12,16,20,24,25]',
    JSON.stringify(asked.map(a => a.offset)))
}

// An exact multiple must not stop one page early, and must not lose the tail.
{
  const rows = Array.from({ length: 20 }, (_, i) => ({ id: i }))
  const { asked, fetchPage } = pager(rows)
  const out = await collectAllRows(fetchPage, 10, 50)
  check('a full final page is followed by the empty page that ends it',
    out !== null && out.length === 20 && asked.length === 3, `rows=${out?.length} pages=${asked.length}`)
  check('the confirming request starts exactly past the last row',
    asked[2].offset === 20, String(asked[2].offset))
}

check('an enumeration with no rows at all is an empty list, NOT a failure',
  JSON.stringify(await collectAllRows(pager([]).fetchPage, 10, 50)) === '[]')

// A partial read must never be handed back as complete — that is the orphan.
{
  const rows = Array.from({ length: 25 }, (_, i) => ({ id: i }))
  const { fetchPage } = pager(rows, { failOnPage: 1 })
  check('a failed page returns null, NOT the rows gathered so far',
    (await collectAllRows(fetchPage, 10, 50)) === null)
}
{
  const { fetchPage } = pager([{ id: 0 }], { failOnPage: 0 })
  check('a failure on the FIRST page returns null, not an empty list',
    (await collectAllRows(fetchPage, 10, 50)) === null)
}

// A server ignoring the range header must terminate, and must terminate as a
// FAILURE — a truncated list here would be indistinguishable from a real one.
{
  let calls = 0
  const fetchPage = async () => { calls++; return [{ id: 0 }] }
  const out = await collectAllRows(fetchPage, 10, 7)
  check('a pager that never advances fails instead of looping forever',
    out === null && calls === 7, `out=${out === null ? 'null' : out.length} calls=${calls}`)
}

check('the shared page size and ceiling are sane bounds',
  ROW_PAGE_SIZE > 0 && ROW_MAX_PAGES > 1, `pageSize=${ROW_PAGE_SIZE} maxPages=${ROW_MAX_PAGES}`)

// ── C) Source contracts over the route ─────────────────────────────────────
console.log('\n— route contract —')

const routeSrc = stripComments(read('src/app/api/projects/[id]/route.ts'))
const deleteSrc = routeSrc.slice(routeSrc.indexOf('export async function DELETE'))

check('DELETE reads the user from the X-User-Id header, never the body',
  /headers\.get\('X-User-Id'\)/.test(deleteSrc) && !/body\.userId/.test(deleteSrc))

// Anchored to the SELECT's own chain. A loose `from('mb_projects') … user_id`
// regex passes on the row DELETE's guard a few lines below and would stay green
// with the select's guard removed — i.e. while a non-owner enumerates freely.
check('the project lookup is gated on ownership',
  /\.select\('\*'\)\s*\.eq\('id', id\)\s*\.eq\('user_id', userId\)\s*\.maybeSingle\(\)/.test(deleteSrc))

check('the row delete is still gated on ownership',
  /\.delete\(\)[\s\S]{0,120}?\.eq\('id', id\)[\s\S]{0,120}?\.eq\('user_id', userId\)/.test(deleteSrc))

// Single-statement anchors. Allowing [\s\S] to roam let the mb_versions half be
// satisfied by the mb_visualizers line on the NEXT row, so dropping the version
// scope — which would enumerate every user's audio — stayed green.
check('version and visualizer lookups are scoped to the owned project id',
  /from\('mb_versions'\)\.select\('audio_url'\)\.eq\('project_id', id\)/.test(deleteSrc)
  && /from\('mb_visualizers'\)\.select\('video_url, source_image_url'\)\.eq\('project_id', id\)/.test(deleteSrc))

// The truncating cap is gone, and gone in favour of paging rather than a bigger
// magic number. Both enumerations, both routes — the account path ran the same
// query with no cap written at all, which is the same bug wearing a disguise.
check('no enumeration in the delete path carries a truncating .limit()',
  !/\.limit\(1000\)/.test(deleteSrc) && !/\.limit\(\d+\)/.test(deleteSrc),
  (deleteSrc.match(/\.limit\(\d+\)/g) ?? []).join(' ') || 'none')

check('both project enumerations page through collectAllRows',
  (deleteSrc.match(/collectAllRows</g) ?? []).length === 2,
  `${(deleteSrc.match(/collectAllRows</g) ?? []).length} call(s)`)

// Offset paging over an UNORDERED PostgREST result can repeat one row and skip
// another — and a skipped version is an audio file nothing will ever name again,
// which is the same orphan arrived at from a different direction.
check('every paged enumeration orders by the primary key, so offsets are stable',
  (deleteSrc.match(/\.order\('id', \{ ascending: true \}\)\.range\(offset, offset \+ limit - 1\)/g) ?? []).length === 2,
  `${(deleteSrc.match(/\.order\('id'/g) ?? []).length} ordered`)

// A page fetcher that turned an error into `[]` would end the enumeration at
// the first blip and report the truncated result as complete.
{
  const pageFn = functionBody(routeSrc, 'async function fetchRowPage')
  check('the page fetcher was located',
    pageFn.length > 0 && /await query/.test(pageFn), `${pageFn.length} chars`)
  check('a page error becomes null, never an empty page',
    /if \(error\) \{[\s\S]*?return null/.test(pageFn) && !/if \(error\)[\s\S]{0,80}?return \[\]/.test(pageFn))
}

// ORDER: enumerate → delete row → remove bytes. Swapping the last two destroys
// live media whenever the row delete fails.
const iCollect = deleteSrc.indexOf('collectAssetKeys')
const iDelete = deleteSrc.indexOf(".delete()")
const iRemove = deleteSrc.indexOf('removeProjectAssets')
check('keys are enumerated BEFORE the row is deleted',
  iCollect !== -1 && iDelete !== -1 && iCollect < iDelete, `collect=${iCollect} delete=${iDelete}`)
check('bytes are removed AFTER the row is deleted',
  iRemove !== -1 && iDelete < iRemove, `delete=${iDelete} remove=${iRemove}`)

check('the prefix listing is unioned with the column-derived keys',
  /unionKeys\(\s*candidates\s*,\s*await listProjectPrefixes\(id\)\s*\)/.test(deleteSrc))

check('a row-delete error is reported as a failure, not papered over',
  /if \(error\) return NextResponse\.json\([\s\S]{0,80}?status: 500/.test(deleteSrc))

check('the client-visible success shape is unchanged ({ ok: true })',
  /NextResponse\.json\(\{ ok: true \}\)/.test(deleteSrc))

check('no bytes are touched when the delete matched no row',
  /deleted\.length === 0\) return NextResponse\.json\(\{ ok: true \}\)/.test(deleteSrc))

check('removal goes through the VERIFYING helper, not a raw .remove()',
  /removeStorageObjectsLogged\(/.test(routeSrc) && !/storage\.from\([^)]*\)\.remove\(/.test(routeSrc))

// Sliced as the real block rather than the `[\s\S]{0,400}` window this used to
// be — see source-contract.mjs on why character windows rot. The window was
// also measuring the WHOLE file, so it would have matched an `if (!survivors)`
// anywhere in it.
{
  const removeFn = functionBody(routeSrc, 'async function removeProjectAssets')
  const nullBlock = bracketedBlock(removeFn, 'if (!scan)')
  check('the removal helper and its null-scan branch were located',
    removeFn.length > 0 && nullBlock.length > 0 && /console\.error/.test(nullBlock),
    `remove=${removeFn.length} nullBranch=${nullBlock.length} chars`)
  check('a survivor scan that learned NOTHING removes NOTHING (fail towards leaking, not deleting)',
    /\breturn\b/.test(nullBlock) && !/keysSafeToDelete|removeStorageObjectsLogged/.test(nullBlock))
}

check('unconfirmed removal is logged loudly as orphaned bytes',
  /ORPHANED BYTES/.test(read('src/app/api/projects/[id]/route.ts')))

check('an incomplete cleanup still returns success to the client',
  routeSrc.indexOf('removeProjectAssets(id') < routeSrc.lastIndexOf('NextResponse.json({ ok: true })'))

// ── The survivor scan, sliced as a function rather than guessed at ─────────
// Both checks below used to be written against the WHOLE route file:
//
//   !/survivingAssetKeys[\s\S]{0,1400}?eq\('user_id'/    (owner scoping)
//   ['audio_url', …].every(c => new RegExp(`'${c}'`).test(routeSrc))
//
// Neither could see the code it claimed to police. The 1400-character window
// ended ~1450 characters short of BOTH query builders, so owner-scoping either
// one stayed green; and five of the seven column names also occur elsewhere in
// the file (the enumeration select, PATCH's `allowed` list, PATCH's pin
// lookup), so deleting them from the scan stayed green too. Anchor to the real
// function body and the real array literal instead — then distance and
// coincidental occurrences both stop mattering.
const survivorFn = functionBody(routeSrc, 'async function survivingAssetKeys')

// Positive locator FIRST: an extraction that silently returned '' would make
// every "does NOT contain" assertion below vacuously true.
check('the survivor scan body was located, with both of its query passes',
  survivorFn.length > 0
  && /\.select\(column\)\.in\(column, chunk\)/.test(survivorFn)
  && /\.select\(column\)\.like\(column, `%\/\$\{id\}\/%`\)/.test(survivorFn),
  `${survivorFn.length} chars`)

// The route's own comment: PATCH accepts any Supabase storage URL as
// artwork_url, so one account can point a project at another account's object.
// Scoping the scan by owner would let that pin delete a stranger's artwork.
check('the survivor scan is NOT scoped to the deleting user',
  !/\.eq\(\s*['"]user_id['"]/.test(survivorFn))

check('the survivor scan also matches references INTO the project prefix',
  /\.like\(column, `%\/\$\{id\}\/%`\)/.test(survivorFn))

// The (table, column) pairs the scan actually queries.
//
// Until 2026-08-21 this was a `const columns = [...]` literal INSIDE the route,
// and this test parsed it there. That literal was a hand-maintained second copy
// of ASSET_URL_COLUMNS, and the two had already drifted — neither carried
// mb_collections, so a project delete could destroy a live album cover. The
// route now consumes the shared constant, which makes the coverage property
// below true by construction rather than by vigilance.
//
// So the pairs are read from the shared list, and the route is separately
// asserted to USE it. Both halves are needed: reading the shared list alone
// would pass even if the route quietly reintroduced its own literal.
const assetsSrcForColumns = stripComments(read('src/lib/project-assets.ts'))
const columnsBlock = bracketedBlock(assetsSrcForColumns, 'export const ASSET_URL_COLUMNS = [', '[', ']')
const scanned = [...columnsBlock.matchAll(/\[\s*'([^']+)'\s*,\s*'([^']+)'\s*\]/g)].map(m => `${m[1]}.${m[2]}`)

check('ASSET_URL_COLUMNS was located as an array literal',
  columnsBlock.length > 0 && scanned.length > 0, `${scanned.length} pair(s): ${scanned.join(' ')}`)

check('the survivor scan consumes ASSET_URL_COLUMNS rather than its own literal',
  /const columns = ASSET_URL_COLUMNS\b/.test(survivorFn)
  && !/const columns = \[/.test(survivorFn),
  'a second literal is how this drifted out of step and lost mb_collections')

// Each of these is a way for a LIVE project to still name a doomed object.
// Dropping mb_projects.artwork_url is the shared-artwork case: production has
// one cover object referenced by two different projects, and without that pair
// deleting one project destroys the other project's live cover.
for (const pair of [
  'mb_versions.audio_url',
  'mb_projects.artwork_url',
  'mb_projects.finalized_artwork_url',
  'mb_projects.visualizer_url',
  'mb_projects.visualizer_wide_url',
  // The instrumental slot (migration 035) — the one mf-audio object a project row
  // names directly; without this pair account delete can't see the bytes.
  'mb_projects.instrumental_url',
  'mb_visualizers.video_url',
  'mb_visualizers.source_image_url',
  // Added 2026-08-21. A collection cover is not confined to a collection-shaped
  // key: production collection "TYPE II" covers itself with an object inside
  // project "TRENCH"'s prefix, and mb_collections does NOT cascade on project
  // delete. Without these two pairs, deleting TRENCH deletes TYPE II's cover.
  'mb_collections.cover_url',
  'mb_collections.artwork_url',
]) {
  check(`the survivor scan queries ${pair}`, scanned.includes(pair))
}

// …and the same question asked from the other end, so a URL column ADDED to the
// derivation later cannot be forgotten here: every `*_url` field collectAssetUrls
// feeds into the scan must be a column the scan asks about.
const assetsSrc = stripComments(read('src/lib/project-assets.ts'))
const collectUrlsFn = functionBody(assetsSrc, 'export function collectAssetUrls')
const derivedColumns = [...new Set([...collectUrlsFn.matchAll(/\.(\w+_url)\b/g)].map(m => m[1]))]
// `>= 7`, not `=== 7`: adding a URL column to the derivation must fail the
// COVERAGE check below (the scan needs it too), not this locator.
check('the URL columns the derivation reads were located',
  derivedColumns.length >= 7, derivedColumns.join(', '))
check('every URL column the derivation reads is covered by the survivor scan',
  derivedColumns.length > 0 && derivedColumns.every(c => scanned.some(p => p.endsWith(`.${c}`))),
  derivedColumns.filter(c => !scanned.some(p => p.endsWith(`.${c}`))).join(', ') || 'all covered')

// ── delete-account must not keep a divergent second copy ───────────────────
console.log('\n— shared derivation, no second copy —')

const accountSrc = stripComments(read('src/app/api/auth/delete-account/route.ts'))
check('delete-account uses the shared collector',
  /collectAssetKeys\(/.test(accountSrc) && /@\/lib\/project-assets/.test(accountSrc))
check('delete-account no longer hand-rolls a storage-path parser',
  !/function storagePathFromUrl/.test(accountSrc)
  && !/storage\/v1\/object\/public/.test(accountSrc))
check('delete-account now selects source_image_url (it used to miss those bytes)',
  /select\('id, video_url, source_image_url'\)/.test(accountSrc))
// Anchored to the SELECT chain: a loose regex is satisfied by the row-delete
// statement further down, so narrowing the select to a project scope — which
// would miss every visualizer whose project_id is null — stayed green.
check('delete-account still selects visualizers by user_id, not by project',
  /from\('mb_visualizers'\)\s*\.select\('id, video_url, source_image_url'\)\s*\.eq\('user_id', userId\)/.test(accountSrc))

// ── storage-remove hardening must stay (mixed-batch echo matching) ─────────
console.log('\n— storage-remove echo matching —')

const removeSrc = read('src/lib/storage-remove.ts')
check('confirmation compares echoed keys against requested keys',
  /const removed = requested\.filter\(isRemoved\)/.test(removeSrc))
check('a full-key echo is detected once from the response, not guessed per key',
  /fullKeyEcho = returned\.some\(n => n\.includes\('\/'\)\)/.test(removeSrc))
check('a basename echo is only trusted when it is the UNIQUE claimant in the batch',
  /claims\.get\(basename\(p\)\) \?\? 0\) === 1/.test(removeSrc))
check('ok is false unless every requested key was confirmed',
  /ok: unconfirmed\.length === 0/.test(removeSrc))

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
