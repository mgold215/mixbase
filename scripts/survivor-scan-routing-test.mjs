// scanSurvivingKeys() result-routing contract test.
//
// Run: node scripts/survivor-scan-routing-test.mjs
//
// THE BUG THIS EXISTS FOR
// On 2026-08-21 a live album cover was found to be deletable by an unrelated
// project's delete, because mb_collections was not among the columns the
// survivor scan asked about. The fix added two entries to ASSET_URL_COLUMNS:
//
//     ['mb_collections', 'cover_url'],
//     ['mb_collections', 'artwork_url'],
//
// That made the scan ASK. It did not make the scan LISTEN. scanSurvivingKeys
// sorted every answer into one of three arrays with a bare else:
//
//     if (table === 'mb_versions') versions.push(...)
//     else if (table === 'mb_projects') projects.push(...)
//     else visualizers.push(...)            // ← mb_collections landed HERE
//
// An mb_collections row is `{cover_url, artwork_url}`. Run through the
// visualizer derivation, which reads video_url/source_image_url, it yields
// NOTHING — and collectAssetKeys was never handed a `collections` array at all,
// even though AssetRows.collections and the loop that consumes it both existed.
//
// WHY IT WAS DANGEROUS RATHER THAN MERELY WRONG
// `answered++` ran BEFORE the routing. So the misrouted chunk still counted as
// successfully answered and the scan returned coverage:'all' — maximum
// confidence — with the answer discarded. A chunk that simply FAILED would have
// been folded into `unresolved` and the object PROTECTED. Confidently wrong is
// worse than admittedly ignorant: it is the state that authorises the delete.
// DELETE /api/projects/[id] was unaffected (it has its own mb_collections
// branch); POST /api/auth/delete-account ran on the broken path.
//
// WHAT IS ASSERTED
// Not "mb_collections is handled" — that fixes one instance of the class. The
// general invariant instead: EVERY (table, column) pair in ASSET_URL_COLUMNS
// must be able to contribute a survivor. A pair the scan asks about but cannot
// derive from is exactly the bug, whatever its name. Adding a column without
// wiring it fails here.
//
// Pure — no DB, no network.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { stripComments, functionBody } from './source-contract.mjs'
import {
  ASSET_URL_COLUMNS,
  AUDIO_BUCKET,
  ARTWORK_BUCKET,
  VIDEO_BUCKET,
  scanSurvivingKeys,
  totalKeyCount,
} from '../src/lib/project-assets.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const SB = 'https://mdefkqaawrusoaojstpq.supabase.co'
const BUCKETS = [AUDIO_BUCKET, ARTWORK_BUCKET, VIDEO_BUCKET]
const urlIn = (bucket, key) => `${SB}/storage/v1/object/public/${bucket}/${key}`

/**
 * Run the REAL scanSurvivingKeys with a select that answers for exactly one
 * (table, column) pair and returns an empty row set for every other pair.
 */
async function scanFor(table, column, url) {
  return scanSurvivingKeys(
    async (t, c) => (t === table && c === column ? [{ [column]: url }] : []),
    [url],
  )
}

// ── A) The general invariant: every asked-about pair can yield a survivor ────
console.log('— every ASSET_URL_COLUMNS pair must be derivable —')

check('ASSET_URL_COLUMNS is non-empty (guards a vacuous sweep below)',
  ASSET_URL_COLUMNS.length > 0, `${ASSET_URL_COLUMNS.length} pairs`)

for (const [table, column] of ASSET_URL_COLUMNS) {
  // Try the pair in each bucket rather than hardcoding a column→bucket map:
  // that map is exactly the kind of second spelling that drifts out of sync
  // with the derivation it is supposed to mirror.
  let derived = 0
  for (const bucket of BUCKETS) {
    const scan = await scanFor(table, column, urlIn(bucket, `survivor-probe.bin`))
    if (scan && totalKeyCount(scan.survivors) > 0) derived++
  }
  check(`${table}.${column} — a row the scan asked for contributes a survivor key`,
    derived > 0,
    derived > 0 ? `${derived} bucket(s)` : 'ROW DISCARDED — asked about, then dropped')
}

// ── B) The original instance, stated concretely ─────────────────────────────
console.log('\n— the 2026-08-21 regression, concretely —')

const coverKey = 'fcbf028c-1111-2222-3333-444444444444/ai-1783622744357.webp'
const coverScan = await scanFor('mb_collections', 'cover_url', urlIn(ARTWORK_BUCKET, coverKey))
check('a live collection cover is reported as a SURVIVOR, not discarded',
  !!coverScan && coverScan.survivors[ARTWORK_BUCKET].includes(coverKey),
  JSON.stringify(coverScan?.survivors ?? null))

const legacyKey = 'collection-ad99235d-5555-6666-7777-888888888888.jpg'
const legacyScan = await scanFor('mb_collections', 'artwork_url', urlIn(ARTWORK_BUCKET, legacyKey))
check('the legacy artwork_url spelling is derived too (migration 004 rows)',
  !!legacyScan && legacyScan.survivors[ARTWORK_BUCKET].includes(legacyKey),
  JSON.stringify(legacyScan?.survivors ?? null))

// ── C) Source contract: the shape that made it dangerous ────────────────────
console.log('\n— routing shape —')

const src = stripComments(read('src/lib/project-assets.ts'))
const body = functionBody(src, 'export async function scanSurvivingKeys')
check('scanSurvivingKeys body was located', body.length > 0, `${body.length} chars`)

// The bare `else` is the defect itself: it silently absorbs any table nobody
// wired up. Routing must name every table it accepts.
check('routing has no bare `else` catch-all — an unnamed table cannot be absorbed',
  !/\belse\s+visualizers\.push/.test(body) && !/\belse\s*\{?\s*\w+\.push/.test(body))

for (const table of [...new Set(ASSET_URL_COLUMNS.map(([t]) => t))]) {
  check(`routing names '${table}' explicitly`, body.includes(`'${table}'`))
}

// The ordering that turned a dropped answer into a confident one.
const iSwitch = body.indexOf('switch (table)')
const iAnswered = body.indexOf('answered++')
check('the routing switch comes BEFORE answered++', iSwitch !== -1 && iAnswered !== -1 && iSwitch < iAnswered,
  `switch=${iSwitch} answered++=${iAnswered}`)
check('answered++ appears exactly once (one place decides "we got an answer")',
  (body.match(/answered\+\+/g) ?? []).length === 1)

// An answer we cannot interpret must be treated as an answer we never got.
const dflt = body.slice(body.indexOf('default:'))
check('the default arm folds the chunk into `unresolved` (protect, do not delete)',
  body.includes('default:') && /unresolved\.add/.test(dflt.slice(0, 400)))
check('the default arm returns without reaching answered++',
  /return/.test(dflt.slice(0, 400)))
check('a `never` assignment makes an unwired table a COMPILE error',
  /:\s*never\s*=\s*table/.test(body))

// The survivors must actually be handed the collections array.
check('collectAssetKeys receives the collections rows it derives from',
  /collections,?\s*[\n}]/.test(body) && /collections:\s*CollectionAssetRow\[\]|const collections/.test(body),
  'collections wired into the derivation call')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
