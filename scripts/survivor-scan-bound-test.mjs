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

import { stripComments, functionBody, bracketedBlock } from './source-contract.mjs'
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
  bucketRootKeys,
  keysSafeToDelete,
  storagePathFromUrl,
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

// ── C2) Pass-2 partial recovery: the claim, proved against the real code ───
console.log('\n— pass-2 partial recovery —')

// THE CLAIM
// When only the PREFIX pass (pass 2, `column LIKE '%/<id>/%'`) fails, keys with
// no path separator may still be deleted, because pass 2 could never have
// vouched for them and pass 1 already answered for them by exact URL.
//
// The load-bearing half is provable rather than asserted, so it is proved here
// against the REAL storagePathFromUrl rather than restated: for a canonical
// Supabase public URL, matching pass 2's pattern IMPLIES the derived key
// contains a separator. Contrapositive: a slash-free key can never come back
// from pass 2, so losing pass 2 tells us nothing new about it.
{
  // Exactly what PostgREST evaluates for `.like(column, '%/<id>/%')`. The
  // pattern carries no other wildcards — `id` is a validated UUID — so a plain
  // substring test is the whole of it.
  const pass2Matches = (url) => url.includes(`/${PROJECT}/`)

  // A corpus spanning every canonical shape production actually holds, plus the
  // ones that would break a careless implementation.
  const corpus = [
    audioUrl(`${PROJECT}/1786795143590.wav`),                 // web upload, own prefix
    audioUrl('HALFWAY - MIX 1.wav'),                          // 111 of 116 root keys
    audioUrl('A9241D7E-A296-49CE-8D92-5C76533BAB0F-v19-1.wav'), // iOS root key: UUID, NO separator
    audioUrl(`${PROJECT}/nested/deep.wav`),
    artUrl(`${PROJECT}/finalized-2.jpg`),
    artUrl(`covers/${PROJECT}/legacy.jpg`),                   // the one legacy shape in production
    artUrl('727255a7-fd23-42f9-aa7c-63acf9898093/other.jpg'), // another project's prefix
    vidUrl(`${PROJECT}/viz-9-h264.mp4`),
    vidUrl('viz-root-h264.mp4'),
    // A root key that happens to CONTAIN the project id without a separator
    // around it — the near-miss that makes the `/…/` anchoring load-bearing.
    audioUrl(`${PROJECT}-v3-1786837847.wav`),
  ]
  const buckets = [AUDIO_BUCKET, ARTWORK_BUCKET, VIDEO_BUCKET]
  const keyOf = (url) => buckets.map(b => storagePathFromUrl(url, b)).find(k => k !== null) ?? null

  // Positive locator: if the corpus derived no keys at all, the implication
  // below would hold vacuously over an empty set and prove nothing.
  const derived = corpus.map(keyOf).filter(k => k !== null)
  check('the recovery corpus derives a key for every URL in it',
    derived.length === corpus.length, `${derived.length}/${corpus.length}`)

  // Both sides must be non-empty, or the implication is vacuous in one direction.
  const matching = corpus.filter(pass2Matches)
  const rootKeys = corpus.filter(u => !keyOf(u).includes('/'))
  check('the corpus contains BOTH pass-2 matches and separator-free keys',
    matching.length > 0 && rootKeys.length > 0,
    `matches=${matching.length} rootKeys=${rootKeys.length}`)

  check('THE PROOF: every canonical URL pass 2 can match derives a key containing a separator',
    matching.every(u => keyOf(u).includes('/')),
    matching.filter(u => !keyOf(u).includes('/')).join(' ') || 'no counterexample')

  // The contrapositive, stated the way the recovery actually uses it.
  check('...so no separator-free key is reachable by the prefix pass',
    rootKeys.every(u => !pass2Matches(u)),
    rootKeys.filter(pass2Matches).join(' ') || 'none reachable')

  // The near-miss, called out on its own: a bucket-root key whose NAME starts
  // with the project id must not be mistaken for a prefixed one.
  const nearMiss = audioUrl(`${PROJECT}-v3-1786837847.wav`)
  check('a root key merely CONTAINING the project id is still root, and still unmatched',
    !keyOf(nearMiss).includes('/') && !pass2Matches(nearMiss), keyOf(nearMiss))

  // ── The residual this block used to assert is now CLOSED (2026-08-22) ─────
  //
  // Until today storagePathFromUrl() searched for the marker with indexOf() and
  // sliced from wherever it landed, so the marker was a substring anyone could
  // smuggle into a user-writable column. This block asserted that hole was real
  // rather than pretending it away — the honest thing to do while it existed.
  // The function is now ANCHORED on the full canonical origin + bucket prefix,
  // so each of these derives NOTHING and can no longer nominate another
  // account's object for deletion. Kept as the regression guard, inverted.
  //
  // keyOf() is called through a null-safe wrapper here on purpose: the previous
  // version of this check did `keyOf(x).includes('/')`, so the moment the hole
  // closed the suite died with a TypeError instead of reporting a result. A
  // test that goes red by crashing names nothing.
  const hasSep = (url) => (keyOf(url) ?? '').includes('/')
  const escapes = [
    ['marker smuggled into the path', `${SB}/${PROJECT}/storage/v1/object/public/mf-audio/HALFWAY - MIX 1.wav`],
    ['marker on a foreign host', `https://evil.example/storage/v1/object/public/mf-audio/HALFWAY - MIX 1.wav`],
    ['marker nested under a foreign host', `https://evil.example/x/storage/v1/object/public/mf-audio/HALFWAY - MIX 1.wav`],
    ['no host at all (relative)', `/storage/v1/object/public/mf-audio/HALFWAY - MIX 1.wav`],
    ['http, not https', `http://${SB.replace('https://', '')}/storage/v1/object/public/mf-audio/x.wav`],
  ]
  for (const [label, url] of escapes) {
    check(`off-canonical URL derives NO key — ${label}`, keyOf(url) === null, String(keyOf(url)))
  }

  // The counterweight, and the reason this must be a string compare rather than
  // new URL(): 110 production audio URLs carry LITERAL spaces because that is
  // the object's real name in the bucket. Parsing re-encodes them to %20, and a
  // delete issued against the encoded name matches nothing — every legacy object
  // would silently stop being reaped while the delete reported success.
  const spaced = audioUrl('5 AM IN ARLINGTON (Mix) - MIX 2.wav')
  check('a canonical key with LITERAL spaces survives byte-for-byte (no %20 re-encoding)',
    keyOf(spaced) === '5 AM IN ARLINGTON (Mix) - MIX 2.wav', String(keyOf(spaced)))
  check('...and is still correctly seen as a bucket-root key', !hasSep(spaced), String(keyOf(spaced)))
}

// ── C3) The coverage rule itself, driven by the real key filters ───────────
console.log('\n— coverage rule —')

const EMPTY_KEYS = { 'mf-audio': [], 'mf-artwork': [], 'mf-video': [] }
const keySet = (o) => ({ ...EMPTY_KEYS, ...o });

{
  const candidates = keySet({
    'mf-audio': ['HALFWAY - MIX 1.wav', `${PROJECT}/web.wav`],
    'mf-artwork': [`${PROJECT}/finalized-old.jpg`],
    'mf-video': ['viz-root.mp4', `${PROJECT}/viz-9.mp4`],
  })

  const roots = bucketRootKeys(candidates)
  check('bucketRootKeys keeps separator-free keys and drops prefixed ones',
    roots[AUDIO_BUCKET].length === 1 && roots[AUDIO_BUCKET][0] === 'HALFWAY - MIX 1.wav'
    && roots[ARTWORK_BUCKET].length === 0
    && roots[VIDEO_BUCKET].length === 1 && roots[VIDEO_BUCKET][0] === 'viz-root.mp4',
    JSON.stringify(roots))

  // FULL coverage: everything the survivors do not name may go.
  const full = keysSafeToDelete(candidates, { survivors: EMPTY_KEYS, coverage: 'all' })
  check('full coverage authorises every unreferenced candidate',
    full[AUDIO_BUCKET].length === 2 && full[ARTWORK_BUCKET].length === 1 && full[VIDEO_BUCKET].length === 2,
    JSON.stringify(full))

  // DEGRADED coverage: only the separator-free keys.
  const partial = keysSafeToDelete(candidates, { survivors: EMPTY_KEYS, coverage: 'bucket-root-only' })
  check('degraded coverage authorises the bucket-root keys pass 1 answered for',
    partial[AUDIO_BUCKET].includes('HALFWAY - MIX 1.wav') && partial[VIDEO_BUCKET].includes('viz-root.mp4'),
    JSON.stringify(partial))
  check('degraded coverage withholds every PREFIXED key (only pass 2 could vouch for those)',
    !partial[AUDIO_BUCKET].includes(`${PROJECT}/web.wav`)
    && partial[ARTWORK_BUCKET].length === 0
    && !partial[VIDEO_BUCKET].includes(`${PROJECT}/viz-9.mp4`),
    JSON.stringify(partial))

  // Degrading coverage must not switch the survivor subtraction off: a
  // bucket-root object pass 1 found a live referrer for is still protected.
  const stillReferenced = keysSafeToDelete(candidates, {
    survivors: keySet({ 'mf-audio': ['HALFWAY - MIX 1.wav'] }),
    coverage: 'bucket-root-only',
  })
  check('a bucket-root key a SURVIVOR still names is protected even under degraded coverage',
    !stillReferenced[AUDIO_BUCKET].includes('HALFWAY - MIX 1.wav'),
    JSON.stringify(stillReferenced[AUDIO_BUCKET]))

  // The direction that matters most: degraded is a strict SUBSET of full, never
  // a superset. If this ever inverts, the recovery is deleting more than a
  // healthy scan would.
  const flat = (k) => [...k[AUDIO_BUCKET], ...k[ARTWORK_BUCKET], ...k[VIDEO_BUCKET]]
  check('degraded coverage never authorises anything full coverage would not',
    flat(partial).every(k => flat(full).includes(k)) && flat(partial).length < flat(full).length,
    `partial=${flat(partial).length} full=${flat(full).length}`)
}

// An EMPTY survivor set is a real answer ("asked, nothing references these") and
// must keep authorising deletion. Conflating it with "unknown" is what would
// turn this whole feature back into a no-op.
{
  const candidates = keySet({ 'mf-audio': ['solo.wav'] })
  const out = keysSafeToDelete(candidates, { survivors: EMPTY_KEYS, coverage: 'all' })
  check('an EMPTY survivor set still authorises deletion (it is an answer, not a shrug)',
    out[AUDIO_BUCKET].includes('solo.wav'), JSON.stringify(out))
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

// ORDER: the scoped branch must RETURN before the unscoped downgrade is
// reached, or a recoverable chunk failure would also cost the prefix pass.
{
  const iProtect = survivorFn.indexOf('if (protect)')
  const iDowngrade = survivorFn.indexOf('prefixFailed = true')
  const between = iProtect !== -1 && iDowngrade !== -1 ? survivorFn.slice(iProtect, iDowngrade) : ''
  check('the scoped-failure branch comes before the coverage downgrade',
    iProtect !== -1 && iDowngrade !== -1 && iProtect < iDowngrade,
    `protect=${iProtect} downgrade=${iDowngrade}`)
  check('the scoped-failure branch returns instead of falling through to it',
    between.length > 0 && /\breturn\b/.test(between))
  check('the coverage downgrade is set in exactly one place',
    survivorFn.split('prefixFailed = true').length - 1 === 1)
}

// The downgrade must be reachable ONLY from the unscoped (pass-2) branch. If a
// scoped chunk failure could also set it, one bad chunk would cost every
// prefixed object its cleanup — the regression this whole degradation replaced.
{
  const iProtect = survivorFn.indexOf('if (protect)')
  const beforeProtect = iProtect !== -1 ? survivorFn.slice(0, iProtect) : survivorFn
  check('nothing before the scoped-failure branch can downgrade coverage',
    iProtect !== -1 && !/prefixFailed = true/.test(beforeProtect))
}

// "Learned nothing" must remain its own answer. Returning a survivor set here
// would read as "no row references any of these" and authorise deleting every
// candidate — the single confusion the return type exists to prevent.
check('a scan where NOTHING answered still returns null, not an empty survivor set',
  /if \(answered === 0 && queries\.length > 0\) return null/.test(survivorFn))
check('the answered counter is incremented on a successful query',
  /if \(!error\) \{\s*answered\+\+/.test(survivorFn))

// The coverage value is what the caller branches on; a scan that always claimed
// 'all' would silently re-enable the unsafe deletes on a pass-2 outage.
check('the returned coverage reflects whether the prefix pass survived',
  /coverage: prefixFailed \? 'bucket-root-only' : 'all'/.test(survivorFn))

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
  removeFn.length > 0 && /keysSafeToDelete\(/.test(removeFn), `${removeFn.length} chars`)

// A null scan means "I learned nothing" and must still remove NOTHING. Sliced
// as the real `if (!scan)` block rather than a character window, so an edit that
// moves the two apart cannot quietly stop measuring anything.
{
  const nullBlock = bracketedBlock(removeFn, 'if (!scan)')
  check('the null-scan branch was located',
    nullBlock.length > 0 && /console\.error/.test(nullBlock), `${nullBlock.length} chars`)
  check('a null (learned-nothing) scan still removes NOTHING',
    /\breturn\b/.test(nullBlock)
    && !/keysSafeToDelete|removeStorageObjectsLogged/.test(nullBlock))
  check('the null-scan branch returns BEFORE anything is subtracted',
    removeFn.indexOf('if (!scan)') < removeFn.indexOf('keysSafeToDelete('))
}

// The coverage rule must be applied by the SHARED helper. A hand-written
// subtractKeys(candidates, scan.survivors) here would spend a downgraded scan as
// though it were complete, which is precisely the deletion this change must not
// authorise — so the raw subtraction is banned from the function outright.
check('the removal helper does not subtract around the coverage rule',
  !/subtractKeys\(/.test(removeFn))
check('a partial-coverage scan is reported, not silently narrowed',
  /scan\.coverage !== 'all'/.test(removeFn) && /console\.error/.test(removeFn))

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
