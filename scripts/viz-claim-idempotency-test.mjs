// Repeated-visualizer-claim contract test — exercises the REAL decision rules
// (src/lib/visualizer-claim.ts via Node type stripping), plus a source contract
// over indexVisualizer() and migration 033.
//
// Run: node scripts/viz-claim-idempotency-test.mjs
//
// WHY THIS EXISTS
// The full-resolution save path PUTs the clip straight to mf-video via a signed
// URL and then POSTs a small JSON claim to /api/visualizer/finalize; only the
// claim writes the mb_visualizers row. fx/upload.ts retries that claim when its
// response is lost — deliberately, because retrying a few hundred bytes of JSON
// beats re-uploading the video, and beats the caller falling back to the legacy
// multipart save (which stores a second COPY of the bytes; see the comment in
// fx/upload.ts, which explicitly accepts "a duplicate row pointing at the SAME
// object" as the lesser evil).
//
// indexVisualizer() answered that retry with a plain INSERT, so the lesser evil
// actually happened: two rows over one object. The user sees a duplicate in
// Media, and deleting either row takes the shared bytes with it — DELETE
// /api/visualizer/[id] derives its storage key from video_url — leaving the
// survivor pointing at a 404.
//
// TWO REGIMES, BOTH TESTED. Migrations here are applied BY HAND while Railway
// deploys on merge, so the code must be correct before AND after
// supabase/migrations/033 adds the unique index:
//   * pre-033  — the select-then-insert collapses the common repeat (the first
//                row landed, only its response was lost); two claims that are
//                genuinely in flight together can still both insert.
//   * post-033 — the loser's insert is refused by the index, and the re-read
//                returns the winner's row, so a duplicate is impossible.
// The post-033 case is also where the OLD code becomes actively destructive:
// its unconditional cleanup would delete the object the WINNER's row points at.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { claimPrecheck, claimAfterInsertFailure } from '../src/lib/visualizer-claim.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

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

const ME = 'user-1'
const OTHER = 'user-2'
const ROW = { id: 'viz-row-1', user_id: ME }
const FOREIGN = { id: 'viz-row-9', user_id: OTHER }

// ── claimPrecheck: what to do BEFORE inserting ──────────────────────────────

check('an existing row of mine is reused, not duplicated', claimPrecheck(ROW, ME) === 'reuse')
check('no row means insert', claimPrecheck(null, ME) === 'insert')
check("someone else's row over my key is refused, never overwritten",
  claimPrecheck(FOREIGN, ME) === 'foreign')
// An unanswered lookup must NOT be read as "a row exists" (that would fail a
// legitimate first save on a transient blip) — the insert is the authority, and
// post-033 the index refuses a real duplicate.
check('an unanswered lookup falls through to the insert', claimPrecheck(undefined, ME) === 'insert')

// ── claimAfterInsertFailure: what to do once the insert failed ──────────────
// The only outcome that deletes bytes is a DEFINITIVE "no row exists".

check('the winner\'s row is the answer for the loser of a concurrent claim',
  claimAfterInsertFailure(ROW, ME) === 'reuse')
check('a genuinely failed insert with no row lets the bytes go',
  claimAfterInsertFailure(null, ME) === 'remove-bytes')
check('an UNANSWERED lookup never deletes bytes',
  claimAfterInsertFailure(undefined, ME) === 'keep-bytes')
check("a foreign row's bytes are never deleted",
  claimAfterInsertFailure(FOREIGN, ME) === 'keep-bytes')

// Exhaustive: exactly one input may ever authorize a delete.
{
  const inputs = [ROW, FOREIGN, null, undefined]
  const deleting = inputs.filter(i => claimAfterInsertFailure(i, ME) === 'remove-bytes')
  check('exactly one of the four lookup outcomes authorizes deleting the object',
    deleting.length === 1 && deleting[0] === null)
}

// ── Behavioural model: old claim handler vs new, same scenarios ─────────────
// The model's two implementations are the shipped shapes; the source contract
// at the bottom is what keeps the NEW one honest against the real file.

function makeTable({ unique }) {
  const rows = []
  return {
    rows,
    // maybeSingle(): the row, or null when there isn't one.
    select(videoUrl) {
      const r = rows.find(x => x.video_url === videoUrl)
      return r ? { id: r.id, user_id: r.user_id } : null
    },
    // Returns null on failure, exactly like insertVisualizerRow().
    insert({ user_id, video_url }) {
      if (unique && rows.some(x => x.video_url === video_url)) return null // 23505
      const created = { id: `row-${rows.length + 1}`, user_id, video_url }
      rows.push(created)
      return { id: created.id }
    },
  }
}

const makeStorage = () => ({ removed: [], remove(key) { this.removed.push(key) } })

// The shipped pre-fix indexVisualizer, verbatim in shape: insert, and on
// failure delete the object unconditionally.
function legacyIndex(table, storage, userId, videoUrl) {
  const row = table.insert({ user_id: userId, video_url: videoUrl })
  if (!row) {
    storage.remove(videoUrl)
    return null
  }
  return { id: row.id }
}

// The new one, routed through the REAL decision functions imported above.
function newIndex(table, storage, userId, videoUrl, { lookupFails = false } = {}) {
  const existing = lookupFails ? undefined : table.select(videoUrl)
  const pre = claimPrecheck(existing, userId)
  if (pre === 'reuse') return { id: existing.id }
  if (pre === 'foreign') return null

  const row = table.insert({ user_id: userId, video_url: videoUrl })
  if (!row) {
    const raced = lookupFails ? undefined : table.select(videoUrl)
    const decision = claimAfterInsertFailure(raced, userId)
    if (decision === 'reuse') return { id: raced.id }
    if (decision === 'remove-bytes') storage.remove(videoUrl)
    return null
  }
  return { id: row.id }
}

const URL_A = 'https://x.supabase.co/storage/v1/object/public/mf-video/p1/viz-1.mp4'

// Scenario 1 — the real-world case. The first claim commits its row; its
// response is lost in flight; fx/upload.ts re-POSTs the identical claim.
for (const unique of [false, true]) {
  const label = unique ? 'post-033' : 'pre-033'

  const legacyTable = makeTable({ unique })
  const legacyStorage = makeStorage()
  legacyIndex(legacyTable, legacyStorage, ME, URL_A)
  const legacySecond = legacyIndex(legacyTable, legacyStorage, ME, URL_A)

  const newTable = makeTable({ unique })
  const newStorage = makeStorage()
  const first = newIndex(newTable, newStorage, ME, URL_A)
  const second = newIndex(newTable, newStorage, ME, URL_A)

  if (!unique) {
    check(`witness (${label}): the old plain INSERT wrote a SECOND row over one object`,
      legacyTable.rows.length === 2)
  } else {
    check(`witness (${label}): the old handler failed the retry outright`, legacySecond === null)
    check(`witness (${label}): …and DELETED the object the surviving row points at`,
      legacyStorage.removed.length === 1 && legacyTable.rows.length === 1,
      'a live, already-saved video destroyed by a harmless retry')
  }

  check(`${label}: a repeated claim leaves exactly one row`, newTable.rows.length === 1)
  check(`${label}: …and the retry gets the SAME id back, not an error`,
    second !== null && second.id === first.id, `${first?.id} vs ${second?.id}`)
  check(`${label}: …and never touches the bytes`, newStorage.removed.length === 0)
}

// Scenario 2 — two retries genuinely in flight at once: both read "no row",
// then both insert. This is the case only the DB constraint can settle.
{
  const preTable = makeTable({ unique: false })
  const preStorage = makeStorage()
  const aPre = preTable.select(URL_A) // both callers look first…
  const bPre = preTable.select(URL_A)
  check('pre-033: both concurrent claims see no row', aPre === null && bPre === null)
  preTable.insert({ user_id: ME, video_url: URL_A })
  const loserPre = preTable.insert({ user_id: ME, video_url: URL_A })
  check('pre-033: without the index the second insert still succeeds — a duplicate survives',
    loserPre !== null && preTable.rows.length === 2,
    'documented limitation until migration 033 is applied')
  check('pre-033: the duplicate at least points at the same object, so no bytes leak',
    preStorage.removed.length === 0)

  const postTable = makeTable({ unique: true })
  const postStorage = makeStorage()
  postTable.select(URL_A)
  postTable.select(URL_A)
  const winner = postTable.insert({ user_id: ME, video_url: URL_A })
  // The loser reaches the post-failure branch with the winner's row now visible.
  const loserRow = postTable.insert({ user_id: ME, video_url: URL_A })
  check('post-033: the loser\'s insert is refused by the unique index', loserRow === null)
  const raced = postTable.select(URL_A)
  const decision = claimAfterInsertFailure(raced, ME)
  if (decision === 'remove-bytes') postStorage.remove(URL_A)
  check('post-033: the loser reuses the winner\'s row instead of erroring',
    decision === 'reuse' && raced.id === winner.id)
  check('post-033: exactly one row, and the bytes are untouched',
    postTable.rows.length === 1 && postStorage.removed.length === 0)
}

// Scenario 3 — the lookup itself fails (PostgREST blip) on a claim for an
// object that really is fresh. The save must still land.
{
  const table = makeTable({ unique: true })
  const storage = makeStorage()
  const out = newIndex(table, storage, ME, URL_A, { lookupFails: true })
  check('a failed lookup does not block a legitimate first save',
    out !== null && table.rows.length === 1)
}

// Scenario 4 — the lookup fails AND the insert fails. Nothing is known, so
// nothing may be deleted; the orphan sweep collects the bytes 24 h later if
// they really were abandoned.
{
  const table = { rows: [], select: () => null, insert: () => null }
  const storage = makeStorage()
  const out = newIndex(table, storage, ME, URL_A, { lookupFails: true })
  check('an all-unknown failure keeps the bytes rather than guessing', out === null && storage.removed.length === 0)

  const legacyStorage = makeStorage()
  legacyIndex(table, legacyStorage, ME, URL_A)
  check('witness: the old handler deleted them on exactly the same unknown',
    legacyStorage.removed.length === 1)
}

// Scenario 5 — a genuine insert failure with a confirmed-absent row still
// cleans up, or the route's "no orphaned bytes" guarantee would be hollow.
{
  const table = { rows: [], select: () => null, insert: () => null }
  const storage = makeStorage()
  newIndex(table, storage, ME, URL_A)
  check('a confirmed-failed save still deletes its bytes', storage.removed.length === 1)
}

// ── Source contract: src/lib/visualizer-store.ts ────────────────────────────

const store = stripComments(read('src/lib/visualizer-store.ts'))

check('indexVisualizer looks the object up before inserting',
  /const existing = await visualizerByVideoUrl\(videoUrl\)/.test(store))
check('…using the REAL precheck rule rather than an inline condition',
  /claimPrecheck\(existing, args\.userId\)/.test(store))
check('a repeat claim returns the existing row id — a success the client can act on',
  /precheck === 'reuse'[\s\S]{0,120}?return \{ id: existing!\.id, video_url: videoUrl \}/.test(store))
check('a failed insert is re-checked for the concurrent-retry winner',
  /const raced = await visualizerByVideoUrl\(videoUrl\)/.test(store))
check('…through the REAL post-failure rule', /claimAfterInsertFailure\(raced, args\.userId\)/.test(store))
check('the object is deleted ONLY on the remove-bytes decision',
  /decision === 'remove-bytes'[\s\S]{0,200}?removeStorageObjectsLogged/.test(store))
check('the lookup distinguishes "no row" from "the query failed"',
  /if \(error\)[\s\S]{0,120}?return undefined/.test(store))
check('…and says so in its return type',
  /Promise<\{ id: string; user_id: string \} \| null \| undefined>/.test(store))

// The unconditional cleanup is exactly what scenario 1 (post-033) showed
// destroying a live video. It must not come back — in indexVisualizer, which is
// the function a retried claim reaches. (storeVisualizer keeps its
// unconditional cleanup on purpose: it uploads a FRESH key every call, so a row
// that fails to land there leaves bytes nothing will ever reference.)
const indexFn = store.slice(store.indexOf('export async function indexVisualizer'))
check('indexVisualizer is where the contract is checked', indexFn.length > 0)
check('no unconditional delete survives on indexVisualizer\'s failed-insert path',
  !/if \(!row\) \{\s*await (supabaseAdmin\.storage|removeStorageObjects)/.test(indexFn))

// ── Source contract: migration 033 ──────────────────────────────────────────

const migration = read('supabase/migrations/033_visualizer_video_url_unique.sql')
// The apply/verify/rollback runbook lives in `--` comments, and it quotes the
// very statements asserted on below — so ordering has to be checked against the
// executable half only.
const sql = migration.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

check('033 creates the unique index idempotently',
  /create unique index if not exists mb_visualizers_video_url_uidx/.test(sql))
check('033 indexes video_url', /on mb_visualizers \(video_url\)/.test(sql))
// `create unique index` fails outright if duplicates already exist, so a
// migration that only creates the index cannot be applied to a production that
// has been writing duplicates.
check('033 de-duplicates BEFORE creating the index',
  sql.indexOf('delete from mb_visualizers') !== -1
  && sql.indexOf('delete from mb_visualizers') < sql.indexOf('create unique index'))
check('033 keeps the earliest row per url', /order by created_at asc nulls last, id asc/.test(sql))
check('033 nudges the PostgREST schema cache', /notify pgrst, 'reload schema'/.test(sql))
for (const section of ['APPLY', 'VERIFY', 'ROLLBACK', 'SMOKE TEST']) {
  check(`033 documents its ${section} step`, migration.includes(`${section}:`) || migration.includes(`${section}`))
}
check('033 is marked as not yet applied', /NOT APPLIED/.test(migration))

console.log(failures === 0 ? '\nAll viz-claim-idempotency tests passed' : `\n${failures} viz-claim-idempotency test(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
