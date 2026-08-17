// Survivor-scan fan-out + request-length contract test.
//
// Run: node scripts/survivor-scan-bound-test.mjs
//
// THE BUG THIS EXISTS FOR
// survivingAssetKeys() in DELETE /api/projects/[id] asks "does any surviving
// row still point at one of this project's storage objects?" for seven
// (table, column) pairs. It asked that question unboundedly in BOTH dimensions:
//
//   1. FAN-OUT. Every column × every chunk went into one array handed to
//      Promise.all — about 147 simultaneous PostgREST GETs at the route's own
//      limit(1000). Any single rejection set `failed`, which returns null,
//      which makes removeProjectAssets skip storage cleanup ENTIRELY. So the
//      cleanup did nothing for exactly the large projects it matters most for,
//      and the only trace was one console.error.
//
//   2. REQUEST LENGTH. `.in(column, chunk)` travels in the query string, and
//      the chunk size was a flat 50 regardless of URL length. This is not
//      theoretical: measured against the real @supabase/postgrest-js with real
//      production rows, 50 of the mf-audio URLs that carry raw spaces and
//      parentheses (110 such rows today) serialize to an 8,244-character URL /
//      8,217-byte request line, past the usual 8,192 nginx / Kong
//      `large_client_header_buffers` ceiling. A 414 on any project with 50
//      versions — no 1,000 required.
//
// WHAT IS TESTED HERE, AND HOW
// The planner (src/lib/survivor-scan-plan.ts) is pure and dependency-free, so
// layers A–C drive the REAL code with real inputs rather than matching source
// text: actual max-observed concurrency from an instrumented task set, actual
// per-chunk encoded cost from the real cost model, and the actual keys an
// unresolved URL protects, derived through the real collectAssetKeys.
//
// Layer D is the part a pure test cannot see: that the route actually USES the
// planner, and that the two safety properties survive — the scan is still not
// owner-scoped, and a scan that fails unscoped still removes NOTHING. Without
// D the planner could be perfect and dead code.
//
// Pure — no DB, no network.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { stripComments, functionBody } from './source-contract.mjs'
import {
  SCAN_CONCURRENCY,
  CHUNK_ENCODED_BUDGET,
  CHUNK_MAX_VALUES,
  encodedFilterCost,
  chunkByEncodedLength,
  runBounded,
  assumedSurvivorRows,
} from '../src/lib/survivor-scan-plan.ts'
import {
  AUDIO_BUCKET,
  ARTWORK_BUCKET,
  VIDEO_BUCKET,
  collectAssetKeys,
} from '../src/lib/project-assets.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const SB = 'https://mdefkqaawrusoaojstpq.supabase.co'
const PROJECT = 'b0642fc1-e7ab-4171-83d7-85b6f11a8742'
const audioUrl = (k) => `${SB}/storage/v1/object/public/mf-audio/${k}`
const artUrl = (k) => `${SB}/storage/v1/object/public/mf-artwork/${k}`
const vidUrl = (k) => `${SB}/storage/v1/object/public/mf-video/${k}`

// The two real URL shapes that share mf-audio, copied from production rows.
// PLAIN is the web upload; SPACEY is what the iOS/manual uploads look like —
// raw spaces AND parentheses, which is what makes postgrest-js quote the value.
const PLAIN = audioUrl(`${PROJECT}/1786795143590.wav`)
const SPACEY = audioUrl('CHXNDLER - ALONE (moodmixformat REMIX) - MIX 2.1.wav')

// The ceiling these budgets exist to stay under: nginx / Kong
// `large_client_header_buffers`, which bounds the whole HTTP request line.
const REQUEST_LINE_CEILING = 8192

// ── A) The real bounded runner ─────────────────────────────────────────────
console.log('\n— bounded concurrency —')

// Tasks that record how many of them are running at the same instant. If the
// runner ever exceeds its limit, `peak` proves it.
function tracker() {
  let inFlight = 0
  let peak = 0
  const started = []
  const make = (label) => async () => {
    inFlight++
    peak = Math.max(peak, inFlight)
    started.push(label)
    // A real macrotask gap, so overlap is genuinely observable rather than an
    // artefact of microtask ordering.
    await new Promise((r) => setTimeout(r, 0))
    inFlight--
    return label
  }
  return { make, peak: () => peak, started }
}

{
  const t = tracker()
  const tasks = Array.from({ length: 40 }, (_, i) => t.make(i))
  const results = await runBounded(tasks, 6)
  check('the runner never exceeds its concurrency limit',
    t.peak() === 6, `peak=${t.peak()} limit=6`)
  check('every task still runs exactly once',
    t.started.length === 40 && new Set(t.started).size === 40, `started=${t.started.length}`)
  // Array.from() materialises holes as undefined. `results.every(...)` SKIPS
  // holes, so a task the runner never ran would slip straight through the
  // "no holes" half of this check — which is the whole point of it.
  check('results come back in input order, with no holes',
    results.length === 40 && Array.from(results).every((v, i) => v === i),
    JSON.stringify(results.slice(0, 8)))
}

{
  const t = tracker()
  await runBounded(Array.from({ length: 12 }, (_, i) => t.make(i)), 1)
  check('a limit of 1 is strictly sequential', t.peak() === 1, `peak=${t.peak()}`)
}

{
  // More workers than tasks must not hang, and must not over-spawn.
  const t = tracker()
  const results = await runBounded(Array.from({ length: 3 }, (_, i) => t.make(i)), 50)
  check('a limit larger than the task count runs every task and stops at it',
    results.length === 3 && t.peak() === 3, `peak=${t.peak()}`)
}

check('an empty task list resolves to an empty result, not a hang',
  (await runBounded([], SCAN_CONCURRENCY)).length === 0)

// The route fires 7 columns × chunks + 7 prefix queries. The whole point of
// this change is that that number no longer reaches the pooler at once.
check('the configured concurrency is a small bound, not the old unbounded fan-out',
  SCAN_CONCURRENCY >= 1 && SCAN_CONCURRENCY <= 12, `SCAN_CONCURRENCY=${SCAN_CONCURRENCY}`)

// ── B) The real cost model and chunker ─────────────────────────────────────
console.log('\n— request-length-aware chunking —')

// The URL shapes must still be the ones this was measured against; if they
// drift, the pinned costs below stop meaning anything.
check('the production URL shapes under test are the measured ones',
  PLAIN.length === 129 && SPACEY.length === 127, `plain=${PLAIN.length} spacey=${SPACEY.length}`)

// Pinned against the real @supabase/postgrest-js: a PostgrestClient with a
// capturing fetch, `.from('mb_versions').select('audio_url').in('audio_url', …)`,
// measuring how the serialized URL grows per added value. The separator is a
// percent-encoded comma (`%2C`, 3 chars), which is the part that made the old
// flat-50 chunking wrong by more than it looked.
check('the cost model matches the library for a plain URL',
  encodedFilterCost(PLAIN) === 152, String(encodedFilterCost(PLAIN)))
check('the cost model matches the library for a spaces-and-parentheses URL',
  encodedFilterCost(SPACEY) === 158, String(encodedFilterCost(SPACEY)))

// Parentheses cost far more than their 2 raw characters: 2 each once encoded,
// plus the two `%22` of the quoting they trigger in postgrest-js.
{
  const noParens = SPACEY.replace('(', '').replace(')', '')
  check('postgrest quoting of reserved characters is charged for',
    encodedFilterCost(SPACEY) - encodedFilterCost(noParens) === 12,
    `delta=${encodedFilterCost(SPACEY) - encodedFilterCost(noParens)} for 2 raw chars`)
}

// A distinct-but-same-shape batch, the way a real project's versions look.
const fifty = Array.from({ length: 50 },
  (_, i) => SPACEY.replace('.wav', `-${String(i).padStart(4, '0')}.wav`))
const sum = (urls) => urls.reduce((a, u) => a + encodedFilterCost(u), 0)

// The defect, stated as a measurement: the old flat 50 is outside the envelope
// the budget defines. (Against the real library this same batch produced an
// 8,217-byte request line, over the 8,192 ceiling.)
check('a flat chunk of 50 real URLs blows the length budget',
  sum(fifty) > CHUNK_ENCODED_BUDGET, `${sum(fifty)} > ${CHUNK_ENCODED_BUDGET}`)

check('the budget leaves at least 2x headroom under the request-line ceiling',
  CHUNK_ENCODED_BUDGET * 2 <= REQUEST_LINE_CEILING,
  `budget=${CHUNK_ENCODED_BUDGET} ceiling=${REQUEST_LINE_CEILING}`)

check('the value cap is no looser than the flat 50 it replaced',
  CHUNK_MAX_VALUES <= 50, `CHUNK_MAX_VALUES=${CHUNK_MAX_VALUES}`)

{
  const chunks = chunkByEncodedLength(fifty)
  check('that same batch is split into more than one chunk',
    chunks.length > 1, `${chunks.length} chunk(s)`)
  const over = chunks.filter((c) => sum(c) > CHUNK_ENCODED_BUDGET)
  check('every chunk fits the budget',
    over.length === 0, `${over.length} oversized of ${chunks.length}`)
}

// THE safety property of the chunker: a URL that is never asked about reads as
// "nothing references this object", which is how a shared object gets deleted.
{
  const many = Array.from({ length: 213 }, (_, i) =>
    (i % 2 ? PLAIN : SPACEY).replace('.wav', `-${i}.wav`))
  const chunks = chunkByEncodedLength(many)
  const flat = chunks.flat()
  check('chunking loses nothing and duplicates nothing, order preserved',
    flat.length === many.length && flat.every((u, i) => u === many[i]),
    `in=${many.length} out=${flat.length}`)
  check('every chunk of the mixed batch fits the budget',
    chunks.every((c) => sum(c) <= CHUNK_ENCODED_BUDGET),
    `max=${Math.max(...chunks.map(sum))}`)
  // No "no empty chunk" check here on purpose: nothing in this batch is
  // over-budget on its own, so an empty chunk cannot arise and the assertion
  // could never fail. The case that CAN fail is asserted below, on a list that
  // leads with an over-budget URL.
}

// At production URL lengths the BUDGET is what binds (~25 per chunk), so the
// value cap is never exercised by the batches above. Drive it directly with
// short URLs, or "no chunk exceeds the cap" can never fail and proves nothing.
{
  const short = Array.from({ length: 120 }, (_, i) => `${SB}/s/${i}.wav`)
  const chunks = chunkByEncodedLength(short)
  check('short URLs are capped by the value cap, not the byte budget',
    Math.max(...chunks.map((c) => c.length)) === CHUNK_MAX_VALUES
    && Math.max(...chunks.map(sum)) < CHUNK_ENCODED_BUDGET,
    `maxValues=${Math.max(...chunks.map((c) => c.length))} maxCost=${Math.max(...chunks.map(sum))}`)
  check('no chunk exceeds the value cap',
    chunks.every((c) => c.length <= CHUNK_MAX_VALUES),
    `max=${Math.max(...chunks.map((c) => c.length))}`)
  check('the short batch also loses nothing',
    chunks.flat().length === short.length)
}

// A single value bigger than the whole budget must still be asked about.
// Dropping it would be the unsafe direction; nothing here can shorten it.
{
  const huge = audioUrl(`${PROJECT}/${'x'.repeat(CHUNK_ENCODED_BUDGET)}.wav`)
  const chunks = chunkByEncodedLength([PLAIN, huge, SPACEY])
  const flat = chunks.flat()
  check('a single over-budget URL is still emitted, never dropped',
    flat.includes(huge) && flat.length === 3, JSON.stringify(chunks.map((c) => c.length)))
  check('the over-budget URL is isolated in its own chunk',
    chunks.some((c) => c.length === 1 && c[0] === huge),
    JSON.stringify(chunks.map((c) => c.length)))
  // The empty-chunk case only arises when the over-budget URL arrives while the
  // current chunk is still empty — i.e. FIRST. Without the `current.length > 0`
  // progress guard that flushes an EMPTY chunk ahead of it, costing a pointless
  // `.in(column, [])` round trip on every column.
  const leading = chunkByEncodedLength([huge, PLAIN])
  check('an over-budget URL leading the list emits no empty chunk',
    leading.every((c) => c.length > 0) && leading.flat().length === 2,
    JSON.stringify(leading.map((c) => c.length)))
}

check('an empty URL list produces no queries at all',
  chunkByEncodedLength([]).length === 0)

// ── C) What an unanswered chunk protects, via the REAL derivation ──────────
console.log('\n— unresolved URLs are protected as survivors —')

// When a chunk cannot be answered, the route folds its URLs into the survivor
// set. That mapping has to agree exactly with how the candidate keys were
// derived, or it protects the wrong key and the object is deleted anyway.
{
  const iosKey = 'A9241D7E-A296-49CE-8D92-5C76533BAB0F-v19-1786837847.wav'
  const keys = collectAssetKeys(assumedSurvivorRows([
    audioUrl(iosKey),
    artUrl(`${PROJECT}/cover.jpg`),
    vidUrl(`${PROJECT}/viz-9-h264.mp4`),
  ]))
  check('an unresolved AUDIO url protects its audio key',
    keys[AUDIO_BUCKET].includes(iosKey), JSON.stringify(keys[AUDIO_BUCKET]))
  check('an unresolved ARTWORK url protects its artwork key',
    keys[ARTWORK_BUCKET].includes(`${PROJECT}/cover.jpg`), JSON.stringify(keys[ARTWORK_BUCKET]))
  check('an unresolved VIDEO url protects the key AND its pre-conversion WebM twin',
    keys[VIDEO_BUCKET].includes(`${PROJECT}/viz-9-h264.mp4`)
    && keys[VIDEO_BUCKET].includes(`${PROJECT}/viz-9.webm`),
    JSON.stringify(keys[VIDEO_BUCKET]))
}

{
  // A transient generator URL names no storage object, so it protects nothing —
  // protecting it would be harmless but protecting the WRONG bucket would not.
  const keys = collectAssetKeys(assumedSurvivorRows(['https://replicate.delivery/pbxt/abc.jpg']))
  check('a non-Supabase URL protects nothing in any bucket',
    keys[AUDIO_BUCKET].length === 0 && keys[ARTWORK_BUCKET].length === 0 && keys[VIDEO_BUCKET].length === 0)
}

// ── D) The route must actually use the planner, and stay fail-safe ─────────
console.log('\n— route contract —')

const routeSrc = stripComments(read('src/app/api/projects/[id]/route.ts'))
const survivorFn = functionBody(routeSrc, 'async function survivingAssetKeys')

// Positive locator FIRST: an extraction that silently returned '' would make
// every "does NOT contain" assertion below vacuously true.
check('the survivor scan body was located, with both of its query passes',
  survivorFn.length > 0
  && /\.select\(column\)\.in\(column, chunk\)/.test(survivorFn)
  && /\.select\(column\)\.like\(column, `%\/\$\{id\}\/%`\)/.test(survivorFn),
  `${survivorFn.length} chars`)

check('the route imports the planner rather than re-deriving it',
  /from '@\/lib\/survivor-scan-plan'/.test(routeSrc))

check('the scan is run through the bounded runner',
  /runBounded\(queries, SCAN_CONCURRENCY\)/.test(survivorFn))

check('the scan no longer hands its queries to Promise.all',
  !/Promise\.all\(/.test(survivorFn))

check('chunking is delegated to the length-aware chunker',
  /chunkByEncodedLength\(urls\)/.test(survivorFn))

check('the hard-coded 50-URL chunk stride is gone',
  !/\+= 50/.test(survivorFn) && !/i \+ 50/.test(survivorFn))

// A chunk query knows which URLs it asked about; the prefix query does not.
// Getting these two arguments the wrong way round is what would let an
// unscoped failure be silently downgraded to "protect nothing".
check('a pass-1 chunk query carries its own URL list as the protect argument',
  /\.in\(column, chunk\), chunk\)/.test(survivorFn))
check('the pass-2 prefix query is explicitly unscoped (null)',
  /\.like\(column, `%\/\$\{id\}\/%`\), null\)/.test(survivorFn))

check('a failed query is retried once before being given up on',
  /for \(let attempt = 0; attempt < 2; attempt\+\+\)/.test(survivorFn))

check('a thrown transport fault is caught rather than escaping the route',
  /catch \(thrown\)/.test(survivorFn))

// ORDER: the scoped branch must RETURN before the whole-scan failure flag is
// reached, or a recoverable chunk failure would still nuke the cleanup.
{
  const iProtect = survivorFn.indexOf('if (protect)')
  const iFailed = survivorFn.indexOf('failed = true')
  const between = iProtect !== -1 && iFailed !== -1 ? survivorFn.slice(iProtect, iFailed) : ''
  check('the scoped-failure branch comes before the whole-scan failure flag',
    iProtect !== -1 && iFailed !== -1 && iProtect < iFailed, `protect=${iProtect} failed=${iFailed}`)
  check('the scoped-failure branch returns instead of falling through to it',
    between.length > 0 && /\breturn\b/.test(between))
  check('the whole-scan failure flag is set in exactly one place',
    survivorFn.split('failed = true').length - 1 === 1)
}

check('unresolved URLs are folded in through the SHARED derivation',
  /unionKeys\(found, collectAssetKeys\(assumedSurvivorRows\(/.test(survivorFn))

// ── The two safety properties that must NOT have moved ─────────────────────
console.log('\n— preserved safety properties —')

// PATCH accepts any Supabase storage URL as artwork_url, so one account can
// point a project at another account's object. Scoping the scan by owner would
// let that pin be used to delete a stranger's artwork.
check('the survivor scan is still NOT scoped to the deleting user',
  !/\.eq\(\s*['"]user_id['"]/.test(survivorFn))

const removeFn = functionBody(routeSrc, 'async function removeProjectAssets')
check('the removal function body was located',
  removeFn.length > 0 && /subtractKeys\(/.test(removeFn), `${removeFn.length} chars`)
check('a null (unscoped-failure) scan still removes NOTHING',
  /if \(!survivors\) \{/.test(removeFn)
  && /\breturn\b/.test(removeFn.slice(removeFn.indexOf('if (!survivors)'), removeFn.indexOf('subtractKeys'))))

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
