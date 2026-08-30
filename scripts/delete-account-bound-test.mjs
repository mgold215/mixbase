// POST /api/auth/delete-account enumeration + request-line contract test.
//
// Run: node scripts/delete-account-bound-test.mjs
//
// THE BUGS THIS EXISTS FOR
// delete-account-scope-test.mjs already pins WHICH objects this route may
// delete. This one pins whether the route can ASK its questions at all — three
// separate ways it could not:
//
//   1. THE PROJECTS SELECT WAS UNPAGED. `.select(…).eq('user_id', userId)` with
//      no range does not mean "no ceiling"; it inherits PostgREST's server-side
//      `max-rows` invisibly. Latent today (the largest account holds 46
//      projects) but it is the root enumeration — every other list on this path
//      is derived from it.
//
//   2. ITS ERROR WAS DISCARDED. `const { data: projects } = await …` throws the
//      error object away, so a failed read is indistinguishable from "this user
//      owns no projects". Every downstream consequence is silent: no versions
//      enumeration, no candidate keys, an empty owned set for
//      filterToOwnedPrefixes — and a `{ ok: true }` reporting a GDPR erasure
//      that cleaned up nothing.
//
//   3. THE `.in()` LISTS WERE UNBOUNDED — and this one is NOT latent. An
//      `.in()` list is serialized into the query string, so it is part of the
//      HTTP request line, capped by the usual 8,192-byte nginx/Kong
//      `large_client_header_buffers`. A canonical UUID costs 39 encoded
//      characters there (36 + the `%2C` separator; postgrest-js appends through
//      url.searchParams, so commas are percent-encoded too). Against live row
//      counts: projectIds at 46 = 1,794 characters, fine — but versionIds at
//      271 = 10,569, which is ~2.4 KB PAST the ceiling. So
//      `mb_feedback.delete().in('version_id', versionIds)` 414s before it
//      reaches PostgREST, lands in dbErrors and trips the abort gate: the
//      largest production account could not be erased at all, and the failure
//      grows with the account rather than resolving.
//
// THE DIRECTION EACH FAILURE MUST FAIL IN — the property most at risk of being
// "fixed" backwards, so it is asserted explicitly:
//   * an incomplete READ is logged, reported and CONTINUES. It costs bytes, not
//     PII: mb_projects is deleted by owner and every child of it is ON DELETE
//     CASCADE, so the account still empties. Blocking a GDPR erasure over a
//     storage leak would trap the user in an undeletable account.
//   * a failed row DELETE still ABORTS before auth.admin.deleteUser. That one
//     really is retained PII, and the account must stay intact and retryable.
//   Those two are opposites on purpose; a test that only checked one would let
//   the other be inverted.
//
// WHAT IS TESTED HERE, AND HOW
// Layer A drives the REAL planner (src/lib/survivor-scan-plan.ts — pure and
// dependency-free) with real UUID lists at real production counts, so the
// numbers above are measured rather than asserted from a comment.
// Layer B is the part a pure test cannot see: that the route actually uses the
// planner and the paginator, that no `.in()` on the path is handed a whole list
// again, and that the two failure directions above still point the right way.
//
// Pure — no DB, no network.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { stripComments, functionBody, bracketedBlock } from './source-contract.mjs'
import {
  CHUNK_ENCODED_BUDGET,
  CHUNK_MAX_VALUES,
  encodedFilterCost,
  chunkByEncodedLength,
} from '../src/lib/survivor-scan-plan.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// The nginx / Kong `large_client_header_buffers` default that bounds the whole
// request line. Same constant survivor-scan-bound-test.mjs measures against —
// duplicated rather than exported, because it is a property of the deployment
// in front of PostgREST, not of our code.
const REQUEST_LINE_CEILING = 8192

// Live production counts for the largest account (2026-08-19): 46 projects,
// 271 versions across them, 4 collections. These are the inputs that decide
// whether each `.in()` is latent or already firing.
const PROD_PROJECTS = 46
const PROD_VERSIONS = 271
const PROD_COLLECTIONS = 4

// Distinct canonical UUIDs — distinct because postgrest-js dedupes an `.in()`
// list through a Set, so repeating one id would shrink the request line and
// quietly understate the cost being measured.
const uuids = (n) => Array.from({ length: n }, (_, i) => {
  const h = i.toString(16).padStart(12, '0')
  return `b0642fc1-e7ab-4171-83d7-${h}`
})
const lineCost = (ids) => ids.reduce((t, id) => t + encodedFilterCost(id), 0)

// ── A1) The request-line arithmetic, from the real cost model ───────────────
console.log('\n— request-line cost of an .in() id list —')

const UUID_COST = encodedFilterCost(uuids(1)[0])
check('a canonical UUID costs 39 encoded characters in an .in() list (36 + `%2C`)',
  UUID_COST === 39, `cost=${UUID_COST}`)

// The defect as briefed: projectIds. Real, but not yet reachable.
check(`projectIds at the production count (${PROD_PROJECTS}) is still UNDER the request-line ceiling`,
  lineCost(uuids(PROD_PROJECTS)) < REQUEST_LINE_CEILING,
  `${lineCost(uuids(PROD_PROJECTS))} < ${REQUEST_LINE_CEILING} — latent, not firing`)

// The defect as MEASURED: versionIds. Already over, on the same account.
check(`versionIds at the production count (${PROD_VERSIONS}) is OVER the ceiling — a live 414`,
  lineCost(uuids(PROD_VERSIONS)) > REQUEST_LINE_CEILING,
  `${lineCost(uuids(PROD_VERSIONS))} > ${REQUEST_LINE_CEILING}`)

// Guards the guard: if this ever stops being true the check above passes for
// the wrong reason (an unbounded list that merely happens to be short).
check('...and that overflow is the UNCHUNKED list, i.e. the bug is the missing chunker',
  lineCost(uuids(PROD_VERSIONS)) > lineCost(uuids(PROD_PROJECTS)) * 2,
  `versions=${lineCost(uuids(PROD_VERSIONS))} projects=${lineCost(uuids(PROD_PROJECTS))}`)

check('the chunk budget leaves better than 2x headroom under the ceiling',
  CHUNK_ENCODED_BUDGET * 2 <= REQUEST_LINE_CEILING,
  `budget=${CHUNK_ENCODED_BUDGET} ceiling=${REQUEST_LINE_CEILING}`)

// ── A2) The shared chunker, applied to id lists ────────────────────────────
console.log('\n— chunking id lists with the SHARED planner —')

for (const [label, n] of [['versionIds', PROD_VERSIONS], ['projectIds', PROD_PROJECTS],
  ['collectionIds', PROD_COLLECTIONS], ['a 10x-growth account', PROD_VERSIONS * 10]]) {
  const ids = uuids(n)
  const chunks = chunkByEncodedLength(ids)
  const worst = Math.max(...chunks.map(lineCost))

  check(`${label} (${n}): every chunk fits the request line`,
    worst < REQUEST_LINE_CEILING, `worst=${worst} ceiling=${REQUEST_LINE_CEILING}`)
  check(`${label} (${n}): every chunk is within the shared budget and value cap`,
    chunks.every(c => lineCost(c) <= CHUNK_ENCODED_BUDGET && c.length <= CHUNK_MAX_VALUES),
    `worst=${worst} budget=${CHUNK_ENCODED_BUDGET} maxLen=${Math.max(...chunks.map(c => c.length))}`)

  // A dropped id is not a cheaper statement: for a SELECT it is a version whose
  // audio is never enumerated, and for a DELETE it is a row that survives a
  // GDPR erasure. A duplicated id would double-delete harmlessly but signals
  // the walk is wrong.
  const flat = chunks.flat()
  check(`${label} (${n}): chunking loses no id and repeats none`,
    flat.length === n && new Set(flat).size === n && ids.every(id => flat.includes(id)),
    `${flat.length}/${n} unique=${new Set(flat).size}`)
}

// The `length > 0` guards the route used to carry were dropped when the deletes
// became loops. That is only safe because an empty list yields ZERO chunks — if
// it yielded one empty chunk the route would fire `.in('project_id', [])` and
// delete on an always-false filter (harmless) or, worse, a missing filter.
check('an empty id list yields zero chunks, so a chunk loop is its own emptiness guard',
  chunkByEncodedLength([]).length === 0, JSON.stringify(chunkByEncodedLength([])))

check('a single id still yields exactly one chunk',
  chunkByEncodedLength(uuids(1)).length === 1)

// ── B) Source contracts over the route ─────────────────────────────────────
console.log('\n— route contract —')

const routeRaw = read('src/app/api/auth/delete-account/route.ts')
const routeSrc = stripComments(routeRaw)
const postBody = functionBody(routeSrc, 'export async function POST')

// Positive locator FIRST: an extraction that silently returned '' would make
// every "does NOT contain" assertion below vacuously true.
check('the POST body was located, with its enumerations and its row deletes',
  postBody.length > 0
  && postBody.includes('collectAllRows<')
  && postBody.includes("from('mb_feedback').delete()"),
  `${postBody.length} chars`)

// ── B1) Defect 3: no `.in()` may be handed a whole list ────────────────────
// The precise regression: `.in('version_id', versionIds)`. Rather than banning
// three names, every `.in()` on the path is required to take a chunk — so a
// FOURTH unbounded list added later fails this too.
const inCalls = [...postBody.matchAll(/\.in\(\s*'(\w+)'\s*,\s*([A-Za-z_][\w.]*)\s*\)/g)]
  .map(m => ({ column: m[1], arg: m[2] }))

check('the .in() call sites were located',
  inCalls.length >= 5, inCalls.map(c => `${c.column}=${c.arg}`).join(' ') || 'none')

check('every .in() on the delete path is given a CHUNK, never a whole id list',
  inCalls.length > 0 && inCalls.every(c => c.arg === 'chunk'),
  inCalls.filter(c => c.arg !== 'chunk').map(c => `.in('${c.column}', ${c.arg})`).join(' ') || 'all chunked')

// Each of the three id lists must actually reach the chunker — an `.in()` that
// took `chunk` from a loop over something else would pass the check above.
const chunked = new Set([...postBody.matchAll(/chunkByEncodedLength\(\s*([A-Za-z_][\w]*)\s*\)/g)].map(m => m[1]))
for (const list of ['projectIds', 'versionIds', 'collectionIds']) {
  check(`${list} is split by the shared chunker before it is used as a filter`,
    chunked.has(list), [...chunked].join(', ') || 'nothing chunked')
}

// Reused, not reinvented. A second chunker here could drift from the one the
// survivor scan uses — the bug class survivor-scan-plan.ts exists to prevent.
check('the chunker is IMPORTED from the shared planner, not redefined locally',
  /import \{[^}]*\bchunkByEncodedLength\b[^}]*\} from '@\/lib\/survivor-scan-plan'/.test(stripComments(routeRaw))
  && !/function chunkByEncodedLength/.test(routeSrc))

// A count-only cap would not have fixed the survivor scan (see ASSET_URL_CHUNK)
// and must not be smuggled in here as a substitute.
check('no hand-rolled slice/count chunking was added alongside it',
  !/\.slice\(\s*i\s*,\s*i\s*\+/.test(postBody) && !/for \(let i = 0; i < (project|version|collection)Ids\.length/.test(postBody))

// ── B2) Defects 1 + 2: the projects read is paged AND its error is read ────
// PROJECTION-AGNOSTIC ON PURPOSE. This used to pin the literal column list
// 'id, artwork_url, finalized_artwork_url', which coupled a PAGING assertion to
// a completely unrelated decision — so widening the projection to stop leaking
// instrumental and visualizer bytes read as a paging regression, while the actual
// defect (a projection too narrow to name those bytes) was invisible here. The
// property this check owns is that the read is paged; delete-account-scope-test
// owns whether the projection is complete.
const projectsSelect = /collectAllRows<[^>]*>\(\s*\(offset, limit\) => fetchRowPage\(\s*supabaseAdmin\.from\('mb_projects'\)\.select\(projection\)\.eq\('user_id', userId\)/
check('the projects select is PAGED through collectAllRows + fetchRowPage',
  projectsSelect.test(postBody),
  projectsSelect.test(postBody) ? 'paged' : 'still a bare select')

// The exact discarding shape that made a failed read look like an empty account.
check('the projects select no longer discards its error via `const { data: projects }`',
  !/const \{ data: projects \}/.test(postBody) && !/const \{ data: collections \}/.test(postBody))

// All four enumerations on this path — projects, versions, visualizers,
// collections. Counted, so dropping paging from any ONE of them fails here.
const paged = (postBody.match(/collectAllRows</g) ?? []).length
check('all four row enumerations page through collectAllRows',
  paged === 4, `${paged} call(s), expected 4`)

// Offset paging over an UNORDERED PostgREST result can repeat one row and skip
// another. Stopping on a SHORT page, or advancing by page SIZE, reintroduces the
// truncation one layer down — both live in collectAllRows; the ordering is the
// caller's half of that contract.
const ordered = (postBody.match(/\.order\('id', \{ ascending: true \}\)\.range\(offset, offset \+ limit - 1\)/g) ?? []).length
check('every paged enumeration orders by the primary key, so offsets are stable',
  ordered === 4, `${ordered} ordered, expected 4`)

check('no enumeration on the path carries a truncating .limit()',
  !/\.limit\(\d+\)/.test(postBody), (postBody.match(/\.limit\(\d+\)/g) ?? []).join(' ') || 'none')

// ── B3) The two failure directions, which are opposites ────────────────────
console.log('\n— failure directions —')

// READ failure → log, report, CONTINUE. Asserted for the projects branch (new)
// and the versions branch (pinned by yesterday's run — must not regress).
{
  const projectsFail = bracketedBlock(postBody, 'if (projects === null)')
  check('the incomplete-projects branch was located',
    projectsFail.length > 0 && /console\.error/.test(projectsFail), `${projectsFail.length} chars`)
  check('an incomplete PROJECTS read is logged + reported and the erasure CONTINUES',
    projectsFail.length > 0
    && !/return NextResponse/.test(projectsFail)
    && /Sentry\.captureMessage\(/.test(projectsFail))

  const versionsFail = bracketedBlock(postBody, 'if (rows === null)')
  check('the incomplete-versions branch was located',
    versionsFail.length > 0 && /console\.error/.test(versionsFail), `${versionsFail.length} chars`)
  check('an incomplete VERSIONS read still continues too (pinned; not regressed)',
    versionsFail.length > 0
    && !/return NextResponse/.test(versionsFail)
    && /Sentry\.captureMessage\(/.test(versionsFail))
}

// DELETE failure → ABORT. The opposite direction, and the one that keeps the
// "no changes were finalized" message honest.
{
  const abort = bracketedBlock(postBody, 'if (dbErrors.length > 0)')
  check('the partial-delete abort branch was located',
    abort.length > 0 && /status: 500/.test(abort), `${abort.length} chars`)
  check('a failed row DELETE still aborts before auth.admin.deleteUser',
    abort.length > 0 && /return NextResponse/.test(abort))
  // Chunked deletes must still funnel every chunk's error into that gate,
  // or a 414 on chunk 3 of 6 would now pass silently.
  check('every chunked delete records its error through the shared `del` helper',
    !/await supabaseAdmin\.from\('\w+'\)\.delete\(\)/.test(postBody),
    'no un-recorded delete')
}

// ── B4) The FK trap the chunking work uncovered ────────────────────────────
// mb_activity.user_id references auth.users with NO ACTION, and the by-project
// delete cannot reach a row whose project_id is NULL — nor can the mb_projects
// CASCADE, since there is no parent row to cascade from. One such row makes
// auth.admin.deleteUser fail on a foreign-key violation and the account becomes
// permanently undeletable. Production holds one today.
check('mb_activity is ALSO deleted by owner, not only by project',
  /from\('mb_activity'\)\.delete\(\)\.eq\('user_id', userId\)/.test(postBody),
  'guards the NO ACTION FK on auth.users')

// The same trap, already known for Submitbase — kept asserted so a future
// tidy-up cannot drop one of the pair.
for (const table of ['sb_submissions', 'sb_curators']) {
  check(`${table} is deleted by owner before the auth user (documented FK trap)`,
    new RegExp(`from\\('${table}'\\)\\.delete\\(\\)\\.eq\\('user_id', userId\\)`).test(postBody))
}

// Ordering: everything that holds a blocking FK on auth.users must be gone
// BEFORE the auth user is deleted, or the erasure 500s at the last step.
const iActivityByOwner = postBody.indexOf("from('mb_activity').delete().eq('user_id', userId)")
const iAuthDelete = postBody.indexOf('auth.admin.deleteUser(userId)')
check('the auth-user delete was located', iAuthDelete !== -1, `at ${iAuthDelete}`)
check('the by-owner mb_activity delete runs BEFORE auth.admin.deleteUser',
  iActivityByOwner !== -1 && iActivityByOwner < iAuthDelete,
  `activity=${iActivityByOwner} authDelete=${iAuthDelete}`)

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
