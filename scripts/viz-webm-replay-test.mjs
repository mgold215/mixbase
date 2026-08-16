// Replayed-webm-claim contract test — the ONE lane of /api/visualizer/finalize
// where the claimed object stops existing, so claim idempotency cannot be had
// from a lookup on the claimed key alone.
//
// Run: node scripts/viz-webm-replay-test.mjs
//
// WHY THIS EXISTS
// The mp4 lane is idempotent by construction: the object the claim names is the
// object the row points at, so a repeat claim finds the row (indexVisualizer's
// precheck, migration 033) and hands it back. The webm lane MOVES the video:
// it transcodes to an mp4 twin, indexes THAT, and deletes the webm original the
// claim names.
//
// So a replay — and fx/upload.ts re-POSTs the claim deliberately whenever the
// response is lost, because retrying a few hundred bytes of JSON beats
// re-uploading the video — arrives naming an object that is gone. Every probe
// on that lane then answers "unreachable", which is a 503; the client spends
// its three retries on it; and FreeStudio.saveRendered treats the resulting
// VizUploadError as "the signed path failed" and falls back to the legacy
// multipart save. That stores a SECOND COPY of the video and a SECOND row —
// precisely the outcome the retry loop and migration 033 exist to prevent,
// reached through the one lane whose key changes underneath the claim.
//
// THE FIX UNDER TEST is a derivable mapping rather than a recorded one: the
// twin is written at mp4TwinPath(claimedKey) — the WebM→MP4 boot heal's own
// convention, already understood by DELETE /api/visualizer/[id],
// /api/auth/delete-account and the orphan sweep via webmOriginalPath() — so a
// replay can recompute where the finished mp4 went and answer with the row the
// first claim already produced. No new column, no DDL, correct on the schema
// that is live today.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { stripComments } from './source-contract.mjs'
import { mp4TwinPath, webmOriginalPath } from '../src/lib/visualizer-encode.ts'
import { parseVizStoragePath } from '../src/lib/visualizer-finalize.ts'
import { claimAfterInsertFailure, claimPrecheck } from '../src/lib/visualizer-claim.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}


const PID = '123e4567-e89b-42d3-a456-426614174000'
const ME = 'user-1'
const WEBM = `${PID}/viz-1755300000000.webm`

// ── 1. The derivation itself ────────────────────────────────────────────────
// Everything below rests on the twin key being a pure function of the claimed
// key. A timestamped key is knowable only to the response that carried it —
// which is the response the replay case has, by definition, lost.

check('the twin key is derived from the claimed key, not stamped',
  mp4TwinPath(WEBM) === `${PID}/viz-1755300000000-h264.mp4`, mp4TwinPath(WEBM))
check('…deterministically: the same claim always names the same twin',
  mp4TwinPath(WEBM) === mp4TwinPath(WEBM))
check('the twin is a different object from the original', mp4TwinPath(WEBM) !== WEBM)
// The delete path, account deletion and the orphan sweep all walk the pair
// backwards with webmOriginalPath(). Using the heal's convention rather than a
// private one is what keeps those three honest about the webm original.
check('the twin round-trips through the delete path\'s own inverse',
  webmOriginalPath(mp4TwinPath(WEBM)) === WEBM)
// The twin is itself a storable viz key: the reaper's shape filter and the
// route's own validator both parse keys, and an exotic twin name would be
// treated as foreign by one of them.
check('the twin is still a valid viz key the rest of the app can parse',
  parseVizStoragePath(PID, mp4TwinPath(WEBM))?.ext === 'mp4')
check('…and stays under the project prefix the caller was proven to own',
  mp4TwinPath(WEBM).startsWith(`${PID}/`))

// ── 2. Behavioural model: the lane, the client, and the fallback ────────────
// The world is the pair that actually matters: objects in mf-video and rows in
// mb_visualizers. `unique` models migration 033's index on video_url.

const urlOf = (key) => `https://x.supabase.co/storage/v1/object/public/mf-video/${key}`

function makeWorld({ unique = true } = {}) {
  return {
    unique,
    storage: new Map(),
    rows: [],
    nextRow: 1,
    stamp: 5000,
    uploads: 0,
    transcodes: 0,
    // Every object this world ever deleted. A replay must not add to it.
    removals: [],
  }
}

function removeObject(world, key) {
  if (!world.storage.has(key)) return
  world.storage.delete(key)
  world.removals.push(key)
}

const rowAt = (world, key) => world.rows.find(r => r.video_url === urlOf(key)) ?? null

// indexedVisualizerAt(): the row that already indexes this key for this user.
function indexedAt(world, key, userId) {
  const found = rowAt(world, key)
  return claimPrecheck(found, userId) === 'reuse' ? { id: found.id, video_url: found.video_url } : null
}

// insertVisualizerRow(): null when the row cannot land (post-033 that includes
// the unique-index refusal of a second row over one object).
function insertRow(world, userId, key) {
  if (world.unique && rowAt(world, key)) return null
  const row = { id: `row-${world.nextRow++}`, user_id: userId, video_url: urlOf(key) }
  world.rows.push(row)
  return row
}

// storeVisualizer(): upload then index. `path` is the caller-supplied
// deterministic key (uploaded with upsert, so a re-run converges); without it a
// fresh stamp is minted and upsert is off.
function storeVisualizer(world, userId, { path, destructiveLoser = false, noUpsert = false, noReconcile = false } = {}) {
  const key = path ?? `${PID}/viz-${world.stamp++}.mp4`
  const upsert = !!path && !noUpsert
  if (world.storage.has(key) && !upsert) return null
  world.storage.set(key, 'mp4')
  world.uploads++
  const row = insertRow(world, userId, key)
  if (!row) {
    if (destructiveLoser) { removeObject(world, key); return null } // the pre-fix shape
    if (path) {
      const raced = rowAt(world, key)
      const decision = claimAfterInsertFailure(raced, userId)
      if (decision === 'reuse') return { id: raced.id, video_url: raced.video_url }
      if (decision !== 'remove-bytes') return null
    }
    removeObject(world, key)
    return null
  }
  // reconcileDuplicateClaim(): pre-033 there is no unique index, so BOTH
  // concurrent inserts land — two rows over ONE derived object. Collapse to the
  // earliest by a deterministic total order. Deletes the ROW only; the object is
  // exactly what the survivor points at.
  if (path && !noReconcile) {
    const same = world.rows.filter(r => r.video_url === urlOf(key))
    if (same.length > 1) {
      const winner = same[0]
      if (winner.id !== row.id) {
        world.rows = world.rows.filter(r => r.id !== row.id)
        return { id: winner.id, video_url: winner.video_url }
      }
    }
  }
  return { id: row.id, video_url: row.video_url }
}

// The shipped pre-fix webm lane: probe, transcode, store on a FRESH key, delete
// the original.
function legacyWebmClaim(world, userId, key, { transcodeFails = false } = {}) {
  if (!world.storage.has(key)) return { status: 503 } // nothing to measure
  if (transcodeFails) {
    const row = insertRow(world, userId, key)
    return row ? { status: 200, id: row.id, transcoded: false } : { status: 500 }
  }
  world.transcodes++
  const stored = storeVisualizer(world, userId, {})
  if (!stored) return { status: 500 }
  removeObject(world, key) // safeRemove: the original is no longer referenced
  return { status: 200, id: stored.id, video_url: stored.video_url, transcoded: true }
}

// The fixed lane.
//   inFlight       — this caller is ALREADY past the short-circuit and the
//                    reachability probe with its mp4 bytes in hand, which is
//                    what a second claim racing the first actually looks like.
//   noRaceRecheck  — the pre-fix shape of the store-failure exit: report 500
//                    and let the client fall back.
function newWebmClaim(world, userId, key, {
  transcodeFails = false, inFlight = false, noRaceRecheck = false, noUpsert = false,
  noReconcile = false,
} = {}) {
  const twin = mp4TwinPath(key)
  if (!inFlight) {
    const onTwin = indexedAt(world, twin, userId)
    if (onTwin) return { status: 200, id: onTwin.id, video_url: onTwin.video_url, transcoded: true, replay: true }
    const onOriginal = indexedAt(world, key, userId)
    if (onOriginal) return { status: 200, id: onOriginal.id, video_url: onOriginal.video_url, transcoded: false, replay: true }
    if (!world.storage.has(key)) return { status: 503 }
  }
  if (transcodeFails) {
    const row = insertRow(world, userId, key)
    return row ? { status: 200, id: row.id, transcoded: false } : { status: 500 }
  }
  world.transcodes++
  const stored = storeVisualizer(world, userId, { path: twin, noUpsert, noReconcile })
  if (!stored) {
    const won = noRaceRecheck ? null : indexedAt(world, twin, userId)
    if (won) {
      removeObject(world, key)
      return { status: 200, id: won.id, video_url: won.video_url, transcoded: true }
    }
    return { status: 500 }
  }
  removeObject(world, key)
  return { status: 200, id: stored.id, video_url: stored.video_url, transcoded: true }
}

// FreeStudio.saveRendered's safety net: a VizUploadError on a small webm falls
// back to the legacy multipart save, which pushes the bytes through Railway a
// second time and writes a second row.
function legacyMultipartSave(world, userId) {
  const key = `${PID}/viz-${world.stamp++}.mp4`
  world.storage.set(key, 'mp4')
  world.uploads++
  world.transcodes++
  const row = insertRow(world, userId, key)
  return { status: 200, id: row?.id, fallback: true }
}

// fx/upload.ts: three attempts on a 503, then throw — and FreeStudio catches.
function clientSave(world, userId, key, lane, opts) {
  let attempts = 0
  for (let attempt = 0; ; attempt++) {
    attempts++
    const res = lane(world, userId, key, opts)
    if (res.status === 503 && attempt < 2) continue
    if (res.status !== 200) return { ...legacyMultipartSave(world, userId), attempts }
    return { ...res, attempts }
  }
}

// Scenario 1 — the carried bug, end to end. The first claim succeeds and its
// response is lost; the client re-POSTs the identical claim.
for (const unique of [false, true]) {
  const label = unique ? 'post-033' : 'pre-033'

  const old = makeWorld({ unique })
  old.storage.set(WEBM, 'webm')
  legacyWebmClaim(old, ME, WEBM)
  const oldReplay = clientSave(old, ME, WEBM, legacyWebmClaim)
  check(`witness (${label}): the replayed claim 503s three times and lands in the legacy fallback`,
    oldReplay.fallback === true && oldReplay.attempts === 3, `attempts ${oldReplay.attempts}`)
  check(`witness (${label}): …leaving TWO rows over TWO copies of one video`,
    old.rows.length === 2 && old.uploads === 2 && old.transcodes === 2,
    `${old.rows.length} rows, ${old.uploads} objects`)

  const fixed = makeWorld({ unique })
  fixed.storage.set(WEBM, 'webm')
  const first = newWebmClaim(fixed, ME, WEBM)
  const replay = clientSave(fixed, ME, WEBM, newWebmClaim)
  check(`${label}: the replay is answered from the derived twin, not re-transcoded`,
    replay.status === 200 && replay.replay === true && fixed.transcodes === 1,
    `${fixed.transcodes} transcode(s)`)
  check(`${label}: …with the SAME row id the lost response carried`,
    replay.id === first.id, `${first.id} vs ${replay.id}`)
  check(`${label}: …exactly one row and one object survive`,
    fixed.rows.length === 1 && fixed.storage.size === 1 && fixed.uploads === 1,
    `${fixed.rows.length} rows, ${fixed.storage.size} objects`)
  check(`${label}: …and the client never reaches the duplicating fallback`,
    replay.fallback === undefined && replay.attempts === 1)
  check(`${label}: the row still points at an object that exists`,
    fixed.storage.has(mp4TwinPath(WEBM))
    && fixed.rows[0].video_url === urlOf(mp4TwinPath(WEBM)))
  // The replay exit must not route through the discard path. Post-033 that is
  // the actively destructive direction: the object it would take down is the
  // one the winner's row points at.
  check(`${label}: the replay deletes NOTHING — only the first claim removed the original`,
    fixed.removals.length === 1 && fixed.removals[0] === WEBM,
    fixed.removals.join('|') || 'none')
}

// Scenario 1b — the other half of the same question, and the one that must NOT
// become a success: bytes that never landed. "The claimed object is missing" is
// not evidence of anything on its own; only a ROW is. A lane that inferred
// "already saved" from a missing object would report success for an upload that
// never happened — the same class of lie as a delete that reports removing
// bytes it never touched.
{
  const never = makeWorld({ unique: true })
  const out = newWebmClaim(never, ME, WEBM)
  check('a claim for bytes that never landed is not answered with a success',
    out.status === 503 && never.rows.length === 0, `status ${out.status}`)

  // Sharper: the twin object is sitting in the bucket, but nothing indexes it.
  // Storage existence is not a claim record — the DB is the authority.
  const unindexed = makeWorld({ unique: true })
  unindexed.storage.set(mp4TwinPath(WEBM), 'mp4')
  const out2 = newWebmClaim(unindexed, ME, WEBM)
  check('…nor is an UNINDEXED twin object treated as proof of an earlier claim',
    out2.status === 503 && unindexed.rows.length === 0, `status ${out2.status}`)

  // And a row belonging to someone else over the derived key is not my success.
  const foreign = makeWorld({ unique: true })
  foreign.rows.push({ id: 'theirs', user_id: 'user-2', video_url: urlOf(mp4TwinPath(WEBM)) })
  const out3 = newWebmClaim(foreign, ME, WEBM)
  check('…nor is another user\'s row over the derived key',
    out3.status !== 200 || out3.id !== 'theirs', `${out3.status} ${out3.id ?? ''}`)
}

// Scenario 2 — the OTHER outcome a first claim can have: ffmpeg failed, so the
// row points at the webm itself. A replay must reuse that row too. Re-running
// the transcode here (it may well succeed the second time) writes a second row
// beside the first, over a second object — the same duplicate by another route.
{
  const old = makeWorld()
  old.storage.set(WEBM, 'webm')
  legacyWebmClaim(old, ME, WEBM, { transcodeFails: true })
  legacyWebmClaim(old, ME, WEBM) // the retry's transcode succeeds
  check('witness: a replay after a failed transcode wrote a second row over a second object',
    old.rows.length === 2 && old.storage.size === 1,
    `${old.rows.length} rows, ${old.storage.size} objects`)
  check('witness: …and the first row now points at an object that was deleted',
    !old.storage.has(WEBM) && old.rows[0].video_url === urlOf(WEBM),
    'the "web plays it, the heal will convert it" promise, broken')

  const fixed = makeWorld()
  fixed.storage.set(WEBM, 'webm')
  const first = newWebmClaim(fixed, ME, WEBM, { transcodeFails: true })
  const replay = newWebmClaim(fixed, ME, WEBM)
  check('a replay after a failed transcode reuses the webm row',
    replay.status === 200 && replay.id === first.id && fixed.rows.length === 1)
  check('…and reports transcoded:false honestly rather than claiming an mp4',
    replay.transcoded === false)
  check('…and leaves the object that row points at in place',
    fixed.storage.has(WEBM))
}

// Scenario 3 — two retries genuinely in flight together. Both pass the
// short-circuit, both transcode, and one wins the twin key. A deterministic key
// is what makes that collision possible at all, so the loser's behaviour is the
// property this fix has to buy back.
{
  const twin = mp4TwinPath(WEBM)

  const world = makeWorld({ unique: true })
  world.storage.set(WEBM, 'webm')
  const winner = newWebmClaim(world, ME, WEBM)
  // B passed the short-circuit before A's row existed and is now arriving at
  // the store with its own copy of the transcoded bytes.
  const loser = newWebmClaim(world, ME, WEBM, { inFlight: true })
  check('the loser is answered with the winner\'s row, not an error',
    loser.status === 200 && loser.id === winner.id, `${winner.id} vs ${loser.id}`)
  check('the unique index — not the upload — is what refuses the second row',
    world.rows.length === 1)
  check('the winner\'s object is still there — a concurrent retry destroyed nothing',
    world.storage.has(twin))
  // What the loser re-uploaded is a twin re-derived from the SAME source webm,
  // so an overwrite cannot substitute a different video for the winner's row.
  check('the object the surviving row points at is the twin of the claimed webm',
    world.rows[0].video_url === urlOf(mp4TwinPath(WEBM)))

  // TWO nets catch this loser — storeVisualizer's own post-insert re-check and
  // the route's. Removing either alone leaves it caught, so the witness has to
  // strip both to show what the pre-fix shape did: report a failure the client
  // answers by uploading the whole video a second time.
  const old = makeWorld({ unique: true })
  old.storage.set(WEBM, 'webm')
  newWebmClaim(old, ME, WEBM)
  const oldLoser = clientSave(old, ME, WEBM, newWebmClaim,
    { inFlight: true, noRaceRecheck: true, noUpsert: true })
  check('witness: with neither re-check the loser 500s and the client duplicates the video',
    oldLoser.fallback === true && old.rows.length === 2 && old.uploads === 2,
    `${old.rows.length} rows, ${old.uploads} objects`)
}

// Scenario 3b — the SAME race in the world that is actually live: migration 033
// is NOT applied, so nothing refuses the loser's insert.
//
// This is the case a derived key newly makes possible, and it is the one that
// matters most, because it is the only world production has ever run in. With a
// stamped key the two claims produced two independent (row, object) pairs —
// redundant but harmless. With a derived key they collide on ONE object, and
// two rows over one object is not a duplicate video: DELETE /api/visualizer/[id]
// removes bytes with no cross-row check, so deleting either row leaves the other
// pointing at a 404. reconcileDuplicateClaim() collapses them.
{
  const twin = mp4TwinPath(WEBM)

  const world = makeWorld({ unique: false })
  world.storage.set(WEBM, 'webm')
  const winner = newWebmClaim(world, ME, WEBM)
  const loser = newWebmClaim(world, ME, WEBM, { inFlight: true })

  check('pre-033: exactly ONE row survives over the one derived object',
    world.rows.length === 1, `${world.rows.length} rows`)
  check('pre-033: the loser is answered with the surviving row, not a dangling id',
    loser.status === 200 && world.rows.some(r => r.id === loser.id),
    `${loser.id} vs [${world.rows.map(r => r.id).join(',')}]`)
  check('pre-033: winner and loser agree on which row indexes the object',
    winner.id === loser.id, `${winner.id} vs ${loser.id}`)
  check('pre-033: the object is still there — reconciling drops a ROW, never bytes',
    world.storage.has(twin) && !world.removals.includes(twin))

  // Fail-first witness: without reconciliation this is the regression the
  // derived key would have introduced.
  const unreconciled = makeWorld({ unique: false })
  unreconciled.storage.set(WEBM, 'webm')
  newWebmClaim(unreconciled, ME, WEBM, { noReconcile: true })
  newWebmClaim(unreconciled, ME, WEBM, { inFlight: true, noReconcile: true })
  const urls = new Set(unreconciled.rows.map(r => r.video_url))
  check('witness: without reconciliation pre-033 leaves TWO rows over ONE object',
    unreconciled.rows.length === 2 && urls.size === 1,
    `${unreconciled.rows.length} rows, ${urls.size} distinct url(s)`)
}

// Scenario 3b — a DANGLING row over the derived key: the row is there, the
// object is not (a delete that half-happened). Re-uploading the twin restores
// exactly the object that row describes, so an unconditional "the insert failed,
// take the bytes down" leaves the row pointing at a 404 forever — the same
// destructive shape migration 033 exposed in indexVisualizer, reached through
// storeVisualizer instead.
{
  const twin = mp4TwinPath(WEBM)
  const world = makeWorld({ unique: true })
  world.rows.push({ id: 'orphan-row', user_id: ME, video_url: urlOf(twin) })
  const out = storeVisualizer(world, ME, { path: twin })
  check('a re-upload over a dangling row keeps the restored object',
    world.storage.has(twin), 'the row would otherwise point at a 404 forever')
  check('…and answers with the row that already describes it',
    out !== null && out.id === 'orphan-row')

  const old = makeWorld({ unique: true })
  old.rows.push({ id: 'orphan-row', user_id: ME, video_url: urlOf(twin) })
  const oldOut = storeVisualizer(old, ME, { path: twin, destructiveLoser: true })
  check('witness: the unconditional cleanup deletes the object the surviving row points at',
    oldOut === null && !old.storage.has(twin) && old.rows.length === 1)
}

// Scenario 3c — the price of a key that never changes: an object left on it by
// a claim that died between upload and insert (a Railway deploy mid-request is
// enough) would refuse every later attempt at that clip FOREVER, because the
// derived key never rotates the way a fresh stamp does. Uploading the twin with
// upsert — the same choice the heal made for the same key — makes the retry
// converge instead.
{
  const twin = mp4TwinPath(WEBM)

  const world = makeWorld({ unique: true })
  world.storage.set(WEBM, 'webm')
  world.storage.set(twin, 'mp4-from-a-claim-that-died') // no row: invisible in Media
  const out = newWebmClaim(world, ME, WEBM)
  check('a twin object left by a dead claim does not wedge the clip forever',
    out.status === 200 && world.rows.length === 1)
  check('…and the row that lands points at the object that is actually there',
    world.storage.has(twin) && world.rows[0].video_url === urlOf(twin))

  const wedged = makeWorld({ unique: true })
  wedged.storage.set(WEBM, 'webm')
  wedged.storage.set(twin, 'mp4-from-a-claim-that-died')
  const stuck = clientSave(wedged, ME, WEBM, newWebmClaim, { noUpsert: true })
  check('witness: without upsert the same clip can never be saved on this key again',
    stuck.fallback === true, 'every retry collides with the leftover object')
}

// Scenario 4 — a FRESH-key store must keep its unconditional cleanup. The
// reference-checked path above is licensed by the caller supplying a key that
// someone else could hold; a key minted this instant cannot be anyone else's,
// and leaving those bytes behind is a real leak (the orphan sweep is opt-in and
// dry-runs by default).
{
  const world = makeWorld({ unique: true })
  // Pre-seed a row over the key the mint will produce, so the insert fails.
  const minted = `${PID}/viz-5000.mp4`
  world.rows.push({ id: 'squatter', user_id: 'someone-else', video_url: urlOf(minted) })
  const out = storeVisualizer(world, ME, {})
  check('a fresh-key store whose row cannot land still deletes its own bytes',
    out === null && !world.storage.has(minted))
}

// Scenario 5 — an unanswered lookup must not fabricate a success. Reporting
// "already saved" from a failed query would tell the user a save landed that
// never did; the claim has to fall through and do the real work.
check('an unanswered existence lookup falls through to doing the work',
  claimPrecheck(undefined, ME) === 'insert')
check('…and still never licenses deleting the bytes',
  claimAfterInsertFailure(undefined, ME) === 'keep-bytes')

// ── 3. Source contract: the finalize route ──────────────────────────────────

const route = stripComments(read('src/app/api/visualizer/finalize/route.ts'))
const webmLane = route.slice(route.indexOf('const twinPath'))

check('the route derives the twin with the shared helper, not a private string edit',
  /import \{[^}]*mp4TwinPath[^}]*\} from '@\/lib\/visualizer-encode'/.test(route)
  && /const twinPath = mp4TwinPath\(storagePath\)/.test(route))
check('the twin the lane WRITES is the twin it looks up',
  /path: twinPath/.test(route) && /indexedVisualizerAt\(twinPath, userId\)/.test(route))
// The whole point is to answer before the probes that 503 on a missing object.
const iTwin = route.indexOf('const twinPath')
const iSizeProbe = route.indexOf('totalBytesFromHeaders(res.headers)', iTwin)
const iDownload = route.indexOf('.download(storagePath)')
const iTranscode = route.indexOf('webmToMp4(')
check('the replay check runs BEFORE the size probe that would 503 on a gone object',
  iTwin !== -1 && iSizeProbe !== -1 && iTwin < iSizeProbe, `twin@${iTwin} probe@${iSizeProbe}`)
check('…and before the download and transcode it makes unnecessary',
  iTwin < iDownload && iTwin < iTranscode)
check('both outcomes of a first claim are addressed — the twin AND the original',
  /indexedVisualizerAt\(twinPath, userId\)/.test(route)
  && /indexedVisualizerAt\(storagePath, userId\)/.test(route))
check('a twin hit is reported as transcoded, an original hit as not',
  /storedTwin[\s\S]{0,200}?transcoded: true/.test(route)
  && /storedOriginal[\s\S]{0,200}?transcoded: false/.test(route))
check('a replay returns the row the first claim produced, not a fresh id',
  /id: storedTwin\.id, video_url: storedTwin\.video_url/.test(route)
  && /id: storedOriginal\.id, video_url: storedOriginal\.video_url/.test(route))
// Neither replay exit may route through discardAndFail: it deletes the claimed
// object, and on a replay the row that survives is the one describing the video
// the user already has. (removeIfUnreferenced would refuse — but the exit must
// not be asking in the first place.)
{
  const iTwinCheck = route.indexOf('const storedTwin')
  const iAfterOriginal = route.indexOf('let webmTotalBytes')
  const replayBlock = route.slice(iTwinCheck, iAfterOriginal)
  check('the replay exits carry no discard, no removal and no failure status',
    replayBlock.length > 0
    && !/discardAndFail/.test(replayBlock)
    && !/removeStorageObjects|safeRemove/.test(replayBlock)
    && !/status: [45]\d\d/.test(replayBlock))
  check('…and report a success the client can act on',
    [...replayBlock.matchAll(/saved: true/g)].length === 2)
}
// The transcoded twin must not go back to a stamped key, or every property
// above becomes unreachable while the route still looks correct.
check('the transcode result is stored at the derived key',
  /storeVisualizer\(\{[\s\S]{0,240}?path: twinPath/.test(route))
check('the lane no longer lets a stored twin land on a key only the response knows',
  !/viz-\$\{Date\.now\(\)\}/.test(webmLane))
// The concurrent loser: 200 with the winner's row, and no bare delete.
check('the loser of a concurrent claim answers with the winner\'s row',
  /const won = await indexedVisualizerAt\(twinPath, userId\)[\s\S]{0,300}?id: won\.id/.test(route))
check('…and clears the original only through the reference-checked helper',
  /if \(won\) \{[\s\S]{0,120}?await safeRemove\(\)/.test(route))
check('…and no new failure exit deletes bytes on an unknown',
  !/if \(won\)[\s\S]{0,200}?removeStorageObjects/.test(route))

// ── 4. Source contract: visualizer-store ────────────────────────────────────

const store = stripComments(read('src/lib/visualizer-store.ts'))

check('storeVisualizer honours a caller-supplied key',
  /const filename = args\.path \?\? `\$\{projectId\}\/viz-\$\{Date\.now\(\)\}\.\$\{ext\}`/.test(store))
// A derived key never rotates, so a leftover object on it must be overwritable
// or the clip is wedged forever; a minted key must NOT be, since anything
// already sitting on it belongs to someone else.
check('a derived key is written with upsert, a minted one without',
  /upsert: !!args\.path/.test(store))
check('indexedVisualizerAt decides through the SHARED precheck rule',
  /export async function indexedVisualizerAt/.test(store)
  && /claimPrecheck\(existing, userId\)/.test(store))
check('…and only ever returns a row this user owns',
  /precheck === 'reuse' \?/.test(store))
check('…reusing the one lookup that separates "no row" from "query failed"',
  /const existing = await visualizerByVideoUrl\(videoUrl\)/.test(store))

const storeFn = store.slice(
  store.indexOf('export async function storeVisualizer'),
  store.indexOf('export async function indexedVisualizerAt'),
)
check('storeVisualizer is where the cleanup contract is checked', storeFn.length > 0)
check('a caller-supplied key re-checks before deleting anything',
  /if \(args\.path\) \{[\s\S]{0,400}?claimAfterInsertFailure\(raced, userId\)/.test(storeFn))
check('…returns the winner\'s row rather than a failure',
  /decision === 'reuse'[\s\S]{0,120}?return \{ id: raced!\.id/.test(storeFn))

// The scenarios above prove the MODEL collapses a pre-033 duplicate. These
// four are what tie that model to the shipped code — without them the source
// could drop reconciliation entirely and every scenario would stay green,
// which is precisely the vacuity that has bitten this repo three times.
check('a derived key reconciles duplicate rows after a SUCCESSFUL insert',
  /const effectiveId = args\.path \? await reconcileDuplicateClaim\(videoUrl, row\.id\) : row\.id/.test(storeFn))
check('…and the caller is handed the surviving row id, not the one just deleted',
  /return \{ id: effectiveId, video_url: videoUrl \}/.test(storeFn))

// Bounded to the function itself. Slicing to end-of-file swallowed
// indexVisualizer, whose legitimate storage cleanup made the "touches no
// storage" check below fail against correct code — an over-broad slice is how
// these assertions end up either vacuous or crying wolf.
const reconcileFn = store.slice(
  store.indexOf('async function reconcileDuplicateClaim'),
  store.indexOf('async function visualizerByVideoUrl'),
)
check('the reconcile slice is bounded to that one function', reconcileFn.length > 0 && reconcileFn.length < 1600)
check('reconcile orders by a deterministic TOTAL order, so exactly one row is the minimum',
  /\.order\('created_at', \{ ascending: true \}\)[\s\S]{0,80}?\.order\('id', \{ ascending: true \}\)/.test(reconcileFn))
check('reconcile deletes only its OWN row, and only when it is not the winner',
  /if \(winner\.id === ownRowId\) return ownRowId/.test(reconcileFn)
  && /\.from\('mb_visualizers'\)[\s\S]{0,60}?\.delete\(\)[\s\S]{0,40}?\.eq\('id', ownRowId\)/.test(reconcileFn))
check('reconcile never touches storage — the object is what the survivor points at',
  !/removeStorageObjects|storage[\s\S]{0,40}?\.remove\(/.test(reconcileFn))
check('…and deletes ONLY on a definitive "no row exists"',
  /decision !== 'remove-bytes'[\s\S]{0,60}?return null/.test(storeFn))
// The fresh-key path must NOT be talked into the same caution: nobody else can
// hold a key minted a millisecond ago, and the orphan sweep is opt-in.
check('a fresh-key store still cleans up unconditionally',
  /removeStorageObjectsLogged\(VIDEO_BUCKET, \[uploadData\.path\]/.test(storeFn))
check('…on the path a caller-supplied key does not reach',
  storeFn.indexOf('if (args.path)') < storeFn.indexOf('removeStorageObjectsLogged'))

console.log(failures === 0 ? '\nAll viz-webm-replay tests passed' : `\n${failures} viz-webm-replay test(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
