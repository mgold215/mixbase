// /api/visualizer/recover contract test — the RECOVERY half of the unclaimed
// mf-video story.
//
// Run: node scripts/viz-recover-test.mjs
//
// WHY THIS EXISTS
// Saving a full-resolution visualizer is two independent steps: the browser PUTs
// the bytes straight into the PUBLIC mf-video bucket via a signed URL, then
// POSTs a small JSON claim to /api/visualizer/finalize — and ONLY that claim
// writes the mb_visualizers row. When the claim never arrives (tab closed,
// browser killed, phone suspends the tab mid-flight) the bytes are in the
// bucket and the render is simply absent from the user's library, with no error
// raised anywhere. On 2026-08-14, 19:47:45 → 19:50:12 UTC, eight objects landed
// for ONE project in a 2.5-minute burst with no rows to match, while Sentry
// recorded zero visualizer errors in thirty days.
//
// video-orphan-reaper.ts is the DISPOSAL half of that scan; this route is the
// RECOVERY half, and it inverts the risk. The reaper's dangerous mistake is
// deleting a live video; this route's dangerous mistakes are (a) claiming an
// object the caller does not own and (b) writing a second row over an object
// that already has one — so the tests below are weighted toward those two.
//
// Layers, matching scripts/viz-finalize-test.mjs and scripts/viz-save-test.mjs:
//   A) The REAL gates the route composes (parseVizStoragePath + keyProjectId,
//      loaded under Node type stripping) driven over the whole ownership
//      decision, with a fail-first witness for the case-sensitivity trap.
//   B) The REAL chunker (survivor-scan-plan.ts) on realistic mf-video URLs —
//      proof the `.in()` filters stay under the request-line ceiling.
//   C) A driven witness for the pager policy: short-page-stop vs
//      empty-page-stop, and termination against a listing that ignores offset.
//   D) A source contract over the route and over MediaClient.tsx: the things a
//      pure test cannot see — that nothing is ever deleted, that identity comes
//      only from the header, and the ORDER of the gates.
//
// Idempotence: the DECISION RULES (claimPrecheck / claimAfterInsertFailure) are
// already pinned by scripts/viz-claim-idempotency-test.mjs and are deliberately
// NOT re-asserted here. What is new on this lane — and is asserted below — is
// that the route adds its OWN pre-claim check in front of them, and that a
// repeat claim is reported to the caller as a SUCCESS rather than a failure.
//
// Pure — no DB, no network.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { stripComments, functionBody } from './source-contract.mjs'

import { parseVizStoragePath } from '../src/lib/visualizer-finalize.ts'
import { keyProjectId } from '../src/lib/project-assets.ts'
import { mp4TwinPath } from '../src/lib/visualizer-encode.ts'
import {
  CHUNK_ENCODED_BUDGET,
  chunkByEncodedLength,
  encodedFilterCost,
} from '../src/lib/survivor-scan-plan.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const MINE = '123e4567-e89b-42d3-a456-426614174000'
const THEIRS = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const OWNED = new Set([MINE])

// ── A) The ownership gate, composed from the REAL helpers ───────────────────
//
// This is the route's per-path decision, built ONLY out of the two shared
// helpers it actually imports. Nothing is re-implemented: keyProjectId is the
// codebase's one key→project attribution (and the one place case is
// normalised), parseVizStoragePath is the SAME gate /api/visualizer/finalize
// applies to an inbound claim. The source contract in section D holds the route
// to this composition and to this ORDER.

function claimable(path, ownedLowercaseIds) {
  const attributed = keyProjectId(path)          // lowercased, or null
  if (!attributed) return false                  // key attributes itself to nobody
  if (!parseVizStoragePath(attributed, path)) return false   // shape, compared as TEXT
  return ownedLowercaseIds.has(attributed)       // ownership (Postgres: case-insensitive)
}

check('an owned mp4 render is claimable', claimable(`${MINE}/viz-1755100000000.mp4`, OWNED) === true)
check('an owned webm render is claimable', claimable(`${MINE}/viz-1755100000000.webm`, OWNED) === true)

// The whole point of the endpoint: a path is judged from scratch, never trusted
// because a previous GET happened to mention it.
check("another user's project prefix is refused",
  claimable(`${THEIRS}/viz-1755100000000.mp4`, OWNED) === false)
check('traversal out of the owned prefix is refused',
  claimable(`${MINE}/../${THEIRS}/viz-1.mp4`, OWNED) === false)
check('a nested key is refused', claimable(`${MINE}/sub/viz-1.mp4`, OWNED) === false)
check('a bucket-root key attributes itself to nobody and is refused',
  claimable('viz-1755100000000.mp4', OWNED) === false)
check('a non-viz basename under an owned prefix is refused',
  claimable(`${MINE}/finalized-1755100000000.jpg`, OWNED) === false)
check('a foreign extension is refused', claimable(`${MINE}/viz-1.mov`, OWNED) === false)
check('an empty stamp is refused', claimable(`${MINE}/viz-.mp4`, OWNED) === false)
check('a non-uuid first segment is refused', claimable('covers/viz-1.mp4', OWNED) === false)

// ── The case-sensitivity trap, and a fail-first witness for it ──────────────
//
// Three facts compose into it, none of them wrong alone:
//   1. Postgres compares `uuid` values case-INSENSITIVELY, so an ownership gate
//      that resolves `<UPPERCASE-UUID>` against mb_projects.id SUCCEEDS.
//   2. Supabase Storage keys are plain text, stored VERBATIM — case and all.
//   3. VIZ_KEY_RE (what parseVizStoragePath applies, and what the orphan sweep
//      uses as its recognizer) matches LOWERCASE hex only.
// So an uppercase key is simultaneously "owned" and unrecognizable: indexing it
// would create a library row over bytes that no reaper, heal or delete path can
// ever name again. The route must refuse it — and refuse it on SHAPE, which is
// the only gate that can see the difference.
const UPPER = MINE.toUpperCase()
check('an UPPERCASE-uuid key under a project I own is still refused',
  claimable(`${UPPER}/viz-1755100000000.mp4`, OWNED) === false)
check('…and the refusal is the SHAPE gate, not the ownership gate',
  keyProjectId(`${UPPER}/viz-1.mp4`) === MINE
  && parseVizStoragePath(MINE, `${UPPER}/viz-1.mp4`) === null)

{
  // Witness: the obvious implementation — normalise both sides and compare —
  // accepts exactly what the real gate refuses. If the check above ever passes
  // vacuously, this pair says so.
  const naive = (path, owned) => {
    const seg = path.slice(0, path.indexOf('/'))
    return seg.length === 36 && owned.has(seg.toLowerCase())
  }
  check('witness: the naive gate accepts the UPPERCASE key', naive(`${UPPER}/viz-1.mp4`, OWNED) === true)
  check('witness: …and the real gate does not',
    naive(`${UPPER}/viz-1.mp4`, OWNED) !== claimable(`${UPPER}/viz-1.mp4`, OWNED))
  check('witness: the naive gate also waves through a non-viz key',
    naive(`${MINE}/finalized-1.jpg`, OWNED) === true
    && claimable(`${MINE}/finalized-1.jpg`, OWNED) === false)
}

// The listing side of the same mismatch: a folder spelled in the other case
// must still be ATTRIBUTED to its owner (so the scan can see it and count it),
// even though nothing inside it will pass the shape gate. Attribution and
// claimability are different questions and only one of them normalises case.
check('an uppercase folder is still attributed to its owner',
  keyProjectId(`${UPPER}/anything`) === MINE)

// ── mp4-twin exclusion ──────────────────────────────────────────────────────
// A claim that got as far as transcoding leaves the webm original in place and
// unreferenced, with the row pointing at the derived twin. Offering that
// original as "unsaved" would file a SECOND library entry for a video the user
// can already see, so the scan asks about the twin's URL too.
check('the twin derivation is the shared one',
  mp4TwinPath(`${MINE}/viz-1755100000000.webm`) === `${MINE}/viz-1755100000000-h264.mp4`)
check('a twin key is itself a claimable shape (so it is never mis-filed as foreign)',
  parseVizStoragePath(MINE, mp4TwinPath(`${MINE}/viz-1755100000000.webm`)) !== null)

// ── B) The `.in()` filters stay under the request line ──────────────────────
// The exclusion pass asks "does any row point at these URLs?" with `.in()`,
// which travels in the QUERY STRING. A flat chunk count is what put the
// survivor scan over the ~8,192-byte request line nginx/Kong enforce in front
// of PostgREST — a 414 before the request leaves the building. The route reuses
// chunkByEncodedLength rather than re-deriving a size, so this drives the real
// chunker on realistic mf-video URLs.

const REQUEST_LINE_CEILING = 8192
const vizUrl = (path) =>
  `https://mdefkqaawrusoaojstpq.supabase.co/storage/v1/object/public/mf-video/${path}`

{
  const urls = Array.from({ length: 500 }, (_, i) => vizUrl(`${MINE}/viz-17551000${String(i).padStart(5, '0')}.mp4`))
  const chunks = chunkByEncodedLength(urls, CHUNK_ENCODED_BUDGET)
  const cost = (chunk) => chunk.reduce((n, u) => n + encodedFilterCost(u), 0)

  check('every chunk fits the encoded budget',
    chunks.every(c => cost(c) <= CHUNK_ENCODED_BUDGET),
    `max ${Math.max(...chunks.map(cost))} / ${CHUNK_ENCODED_BUDGET}`)
  check('the budget leaves real headroom under the request line',
    CHUNK_ENCODED_BUDGET * 2 <= REQUEST_LINE_CEILING,
    `budget ${CHUNK_ENCODED_BUDGET}, ceiling ${REQUEST_LINE_CEILING}`)
  // Not one URL may be dropped: an unasked question reads as "nothing points at
  // this", which is what would offer a LIVE library item up for a duplicate
  // claim.
  const flat = chunks.flat()
  check('every URL lands in exactly one chunk',
    flat.length === urls.length && new Set(flat).size === urls.length)

  // A webm candidate contributes TWO URLs (itself and its twin), so the chunker
  // has to survive twice the candidate count.
  const withTwins = urls.flatMap(u => [u, u.replace(/\.mp4$/, '-h264.mp4')])
  check('twin URLs do not push any chunk over the budget',
    chunkByEncodedLength(withTwins, CHUNK_ENCODED_BUDGET).every(c => cost(c) <= CHUNK_ENCODED_BUDGET))
}

// ── C) The pager policy, driven ─────────────────────────────────────────────
// The route's storage pager stops on an EMPTY page, not a SHORT one. That is a
// deliberate divergence from video-orphan-plan's pager and the reason is the
// inverted risk: for the reaper a missed row survives another 24 h, while here
// a missed row is a user's render the UI never offers to restore.

const LIST_MAX_PAGES = Number(/const LIST_MAX_PAGES = (\d+)/.exec(read('src/app/api/visualizer/recover/route.ts'))?.[1])
check('the route declares a page cap', Number.isInteger(LIST_MAX_PAGES) && LIST_MAX_PAGES > 0,
  `LIST_MAX_PAGES=${LIST_MAX_PAGES}`)

{
  const PAGE = 4
  // A listing that hands back a SHORT page with more rows still behind it —
  // exactly what an in-page filter (folder markers, placeholder rows) produces.
  const pages = [
    ['a', 'b', 'c'],   // short, but NOT the end
    ['d', 'e', 'f', 'g'],
    [],
  ]
  const serve = (offset) => pages[offset / PAGE] ?? []

  const stopOnShort = () => {
    const out = []
    for (let p = 0; p < LIST_MAX_PAGES; p++) {
      const batch = serve(p * PAGE)
      out.push(...batch)
      if (batch.length < PAGE) return out
    }
    return null
  }
  const stopOnEmpty = () => {
    const out = []
    for (let p = 0; p < LIST_MAX_PAGES; p++) {
      const batch = serve(p * PAGE)
      if (batch.length === 0) return out
      out.push(...batch)
    }
    return null
  }

  check('witness: stopping on a SHORT page loses rows', stopOnShort().length === 3)
  check('stopping on an EMPTY page finds them all', stopOnEmpty().length === 7)

  // The other half of the bargain: a server that ignores `offset` can no longer
  // end the loop by handing back the same page, so the cap must. Falling out of
  // the loop is reported as a FAILED listing, never as the end of the data.
  const ignoresOffset = () => {
    const out = []
    for (let p = 0; p < LIST_MAX_PAGES; p++) {
      const batch = ['a', 'b', 'c', 'd']
      if (batch.length === 0) return out
      out.push(...batch)
    }
    return null
  }
  check('an offset-ignoring listing terminates at the cap rather than spinning',
    ignoresOffset() === null)
}

// ── D) Source contract over the route ───────────────────────────────────────
// Comments are stripped first, so a guard that survives only as prose cannot
// keep an assertion green.

const routeSrc = read('src/app/api/visualizer/recover/route.ts')
const route = stripComments(routeSrc)
const getBody = functionBody(route, 'export async function GET')
const postBody = functionBody(route, 'export async function POST')

check('the GET handler was located', getBody.length > 200)
check('the POST handler was located', postBody.length > 200)

// ── The one rule: this route never deletes anything ────────────────────────
// The reaper is the only code licensed to remove an mf-video object. A recovery
// tool that can destroy the bytes it is recovering is a footgun, and every
// "cleanup" helper in this area (removeStorageObjects / removeStorageObjectsLogged
// / storage.remove) is one import away.
for (const forbidden of ['removeStorageObjects', 'removeStorageObjectsLogged', '.remove(', 'storage-remove']) {
  check(`the route never reaches for ${forbidden}`, !route.includes(forbidden))
}
check('the route deletes no rows either', !/\.delete\(/.test(route))

// …and the one deletion this route cannot see in its own source. The checks
// above only prove it never removes bytes DIRECTLY; indexVisualizer() removes
// them on its behalf, defaulting to 'remove-bytes' when a claim's insert
// definitively fails. That default is right for save/finalize — the object was
// uploaded moments ago FOR that claim — and exactly backwards here, where the
// bytes have already survived one lost claim and are the whole point of the
// request. Dropping this argument reopens the footgun through a door the
// forbidden-token scan above cannot watch.
check('the claim opts OUT of indexVisualizer\'s delete-on-failure',
  /removeOnFailure:\s*false/.test(postBody),
  postBody.includes('indexVisualizer(') ? 'indexVisualizer called without removeOnFailure: false' : 'no indexVisualizer call found')

// ── Identity comes from the header, never the body ─────────────────────────
check('both handlers read identity from X-User-Id',
  (getBody.match(/headers\.get\('X-User-Id'\)/g) ?? []).length === 1
  && (postBody.match(/headers\.get\('X-User-Id'\)/g) ?? []).length === 1)
check('no handler reads a user id out of the request body',
  !/body\.(userId|user_id)/.test(route) && !/body\?\.(userId|user_id)/.test(route))
// The POST body is a bare list of paths — nothing else is honoured, so no
// client-supplied projectId can ever stand in for the one the KEY names.
check('the POST body carries paths and nothing else',
  /\{ paths\?: unknown \}/.test(route) && !/body\.projectId/.test(route))

// ── Per-path ownership, in the right order ─────────────────────────────────
const iAttribute = postBody.indexOf('keyProjectId(')
const iShape = postBody.indexOf('parseVizStoragePath(')
const iOwns = postBody.indexOf('userOwnsProject(')
const iIndex = postBody.indexOf('indexVisualizer(')
check('POST attributes the key to a project before anything else',
  iAttribute !== -1 && iAttribute < iShape)
check('POST applies the shared shape gate before the ownership query',
  iShape !== -1 && iShape < iOwns,
  'the cheap textual gate is also the one that refuses a non-canonical spelling')
check('POST proves ownership before it indexes anything',
  iOwns !== -1 && iIndex !== -1 && iOwns < iIndex)
// No second parser: the route must not carry its own copy of the key
// recognizer, or the write gate and the reaper's shape filter can drift apart.
check('the route declares no key regex of its own',
  !route.includes('VIZ_KEY_RE') && !/\/\^\(\[0-9a-f-\]/.test(route))

// ── Idempotence without migration 033 ──────────────────────────────────────
// 033 (the unique index on mb_visualizers.video_url) is written but NOT applied
// in production — scripts/viz-claim-idempotency-test.mjs pins that, and pins
// the decision rules inside indexVisualizer. What is this route's own: it asks
// BEFORE it claims, and a hit is reported as a SUCCESS.
const iAlready = postBody.indexOf('indexedVisualizerAt(')
check('POST checks for an existing row before claiming',
  iAlready !== -1 && iAlready < iIndex)
const alreadyBlock = functionBody(postBody, 'const already = await indexedVisualizerAt')
check('a repeat claim is reported as recovered, not as an error',
  /recovered\.push\(/.test(postBody.slice(iAlready, iIndex))
  && !/failed\.push\(/.test(postBody.slice(iAlready, postBody.indexOf('const bytes'))),
  alreadyBlock ? '' : 'reuse branch located by slice')

// ── Rate limiting, same cap as the sibling save lanes ──────────────────────
check('POST is rate limited by the shared visualizer-save limiter',
  postBody.includes('checkUserLimit(vizSaveLimiter'))
check('…and answers 429 with standard headers', postBody.includes('rateLimitHeaders(limit)'))
// A malformed request must not cost a save: the limiter runs after the body is
// parsed and found usable, exactly as /api/visualizer/finalize orders it.
check('a malformed body is rejected before a credit is spent',
  postBody.indexOf("{ error: 'Invalid JSON body' }") < postBody.indexOf('checkUserLimit(')
  && postBody.indexOf("{ error: 'paths is required' }") < postBody.indexOf('checkUserLimit('))
// GET is a read-only scan and deliberately does NOT charge the save cap.
check('GET does not spend a save credit', !getBody.includes('checkUserLimit('))

// ── Bounded enumeration ────────────────────────────────────────────────────
const pager = functionBody(route, 'async function pageThrough')
check('the storage pager body was located', pager.includes('await listPage('))
check('the pager stops on an EMPTY page', /batch\.length === 0/.test(pager))
check('the pager does NOT infer the end from a short page',
  !/batch\.length < LIST_PAGE_SIZE/.test(pager) && !/< LIST_PAGE_SIZE/.test(pager))
check('the pager is capped', /page < LIST_MAX_PAGES/.test(pager))
check('falling out of the cap is a FAILED listing, not an end-of-data',
  /return null/.test(pager.slice(pager.lastIndexOf('}'), pager.length) + pager))

const owner = functionBody(route, 'async function ownedProjects')
// Located, and located as the BODY rather than a return-type literal — an
// inline `Promise<{ … }>` would put the first brace in the signature and make
// every assertion below vacuously true.
check('the owned-project scan body was located',
  owner.includes('mb_projects') && owner.includes('return { projects, pinned }'))
check('the owned-project scan is capped', /page < PROJECT_MAX_PAGES/.test(owner))
check('the owned-project scan filters on the authenticated user',
  owner.includes(".eq('user_id', userId)"))

const refs = functionBody(route, 'async function referencedUrls')
check('the reference scan body was located', refs.includes('mb_visualizers'))
check('the reference scan chunks its .in() by ENCODED length',
  refs.includes('chunkByEncodedLength(') && refs.includes('CHUNK_ENCODED_BUDGET'))
check('the only .in() filter in the route is the chunked one',
  (route.match(/\.in\(/g) ?? []).length === 1 && refs.includes(".in('video_url', chunk)"))
check('a failed reference chunk aborts rather than reading as "no row"',
  /return null/.test(refs))

// Every GET failure exit is a 503 that reports NOTHING, never a 200 with a
// partial list — an incomplete scan cannot tell "no row exists" from "we did
// not ask", and the difference is whether a live library item gets offered up
// for a pointless duplicate claim.
const incomplete = functionBody(getBody, 'const incomplete = ()')
check('GET has a single incomplete-scan exit',
  incomplete.includes('NextResponse.json') && incomplete.includes('status: 503'))
// Four independent ways the scan can come up short — the owned-project walk,
// the bucket-root listing, any per-prefix walk, and the reference scan — and
// every one of them must take that exit rather than answer 200 with a list it
// knows is partial.
const incompleteUses = (getBody.match(/return incomplete\(\)/g) ?? []).length
check('GET uses it on every scan failure', incompleteUses >= 4, `${incompleteUses} uses`)
check('GET has no OTHER 5xx exit that could answer with a partial list',
  (getBody.match(/status: 5\d\d/g) ?? []).length === 1)

// The result caps, so one request's work stays proportional to a library rather
// than to the bucket.
for (const bound of ['MAX_OWNED_PREFIXES', 'MAX_CANDIDATES', 'MAX_RECOVERABLE', 'MAX_RECOVER_PATHS']) {
  check(`${bound} is declared and applied`,
    new RegExp(`const ${bound} = \\d+`).test(route) && (route.match(new RegExp(bound, 'g')) ?? []).length >= 2)
}
check('POST caps how many paths one call may claim',
  postBody.includes('.slice(0, MAX_RECOVER_PATHS)'))
check('POST dedupes the paths it was handed', postBody.includes('new Set('))

// ── E) Source contract over the Media entry point ──────────────────────────
const mediaSrc = read('src/app/media/MediaClient.tsx')
const media = stripComments(mediaSrc)

check('the Media tab asks for unclaimed renders', media.includes("fetch('/api/visualizer/recover')"))
check('…and offers to claim them back',
  /fetch\('\/api\/visualizer\/recover', \{\s*method: 'POST'/.test(media))
// The worst case is a user whose renders ALL failed to claim: their library is
// EMPTY, so a banner nested inside the `visualizers.length > 0` section would
// be invisible to exactly the person who needs it.
const iBanner = media.indexOf('unsaved.length > 0')
const iVizSection = media.indexOf('visualizers.length > 0 && (')
check('the banner renders outside — and above — the visualizers section',
  iBanner !== -1 && iVizSection !== -1 && iBanner < iVizSection)
check('a failed or empty scan shows no banner at all',
  media.includes('if (!res.ok) return') && media.includes('unsaved.length > 0'))
check('a successful recovery refreshes the library', /router\.refresh\(\)/.test(media))
check('the client honours the per-call path cap', /paths: unsaved\.slice\(0, 25\)/.test(media))

console.log(failures === 0 ? '\nAll viz-recover tests passed' : `\n${failures} viz-recover test(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
