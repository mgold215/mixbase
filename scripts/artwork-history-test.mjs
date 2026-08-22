// Artwork History contract test — the feature, plus the two production defects
// found while building it.
//
// Run: node scripts/artwork-history-test.mjs
//
// THREE THINGS ARE PINNED HERE, and they fail for different reasons:
//
//   A. The pure logic of src/lib/artwork-history.ts — classification, the
//      restore-target decision, the sort, and the "flag, never filter" rule.
//
//   B. The ROUTE'S ADDRESS. `/api/artwork` is in PUBLIC_PATHS so the iOS lock
//      screen can fetch covers cookie-less, and PUBLIC_PATHS is matched with
//      startsWith(). A route at `/api/artwork/history` would therefore ship
//      completely unauthenticated — middleware would skip auth and never inject
//      X-User-Id. The route lives under `/api/projects/[id]/` instead. Section B
//      is what stops anyone moving it back, or widening PUBLIC_PATHS until it
//      swallows this route.
//
//   C. TWO DEFECTS THIS WORK UNCOVERED, both live in production on 2026-08-21:
//      C1. /api/generate-artwork and /api/finalize-artwork uploaded through the
//          ANON-key SSR client, not supabaseAdmin. Migration 029 narrowed the
//          mf-artwork INSERT policy to `authenticated` the night before, which
//          made both routes a guaranteed RLS denial. Proof they had never run as
//          anything else: all 275 server-written mf-artwork objects carry
//          owner_id = null while the 13 iOS-written ones carry a real uid.
//      C2. mb_collections was absent from the survivor scan's column list, so
//          DELETE /api/projects/[id] could delete a live album cover. Not
//          hypothetical: collection "TYPE II" (d10b873e) covers itself with
//          `fcbf028c-…/ai-1783622744357.webp`, an object inside project
//          "TRENCH"'s prefix. mb_collections does not cascade on project delete.

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { stripComments } from './source-contract.mjs'
import {
  artworkRestorePatch,
  buildArtworkHistory,
  classifyArtworkKey,
  compareArtworkItems,
  isRestorableArtworkKey,
} from '../src/lib/artwork-history.ts'
import { ASSET_URL_COLUMNS, OPTIONAL_ASSET_URL_COLUMNS, collectAssetKeys, collectAssetUrls, errorNamesColumn } from '../src/lib/project-assets.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

/**
 * Every `route.ts` under src/app/api, with the URL it answers on.
 *
 * Dynamic segments are substituted with a concrete value because PUBLIC_PATHS
 * is matched against a real pathname: `[id]` -> `x`, `[...path]` -> `x/y`. The
 * substitution only has to be *some* value the segment could take, since the
 * prefix test is about the static part in front of it.
 */
function walkRoutes(dir, url) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const seg = entry.name
        .replace(/^\[\.\.\..+\]$/, 'x/y')
        .replace(/^\[(.+)\]$/, 'x')
      out.push(...walkRoutes(join(dir, entry.name), `${url}/${seg}`))
    } else if (entry.name === 'route.ts') {
      const src = readFileSync(join(dir, entry.name), 'utf8')
      out.push({
        url,
        file: join(dir, entry.name),
        requiresUser: src.includes("request.headers.get('X-User-Id')") && src.includes('401'),
      })
    }
  }
  return out
}

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const PID = 'fcbf028c-388d-46ff-8799-d10d7b7d19b5'
const OTHER = 'f5b87ba6-2bce-441d-8317-0967e04e4720'

// ── A. Pure logic ───────────────────────────────────────────────────────────
console.log('\n── A. artwork-history pure logic ──')

// Real production key shapes, all six of them.
check('classify: ai- draft', classifyArtworkKey(`${PID}/ai-1787250068415.jpg`) === 'generated')
check('classify: ai- webp draft', classifyArtworkKey(`${PID}/ai-1787075577211.webp`) === 'generated')
check('classify: ai- png draft', classifyArtworkKey(`${PID}/ai-1787075577211.png`) === 'generated')
check('classify: finalized render', classifyArtworkKey(`${PID}/finalized-1787075639641.jpg`) === 'finalized')
check('classify: cover.jpg upload', classifyArtworkKey(`${PID}/cover.jpg`) === 'upload')
check('classify: legacy <ts>.jpeg upload', classifyArtworkKey(`${PID}/1774625602856.jpeg`) === 'upload')

// The classification anchors on the LAST path segment. A first segment that
// happened to start with 'ai-' or 'finalized-' must not reclassify a whole
// prefix's worth of objects.
check('classify: anchored to the leaf, not the whole key',
  classifyArtworkKey('ai-notaproject/cover.jpg') === 'upload',
  'a prefix starting with ai- must not make an upload look generated')
check('classify: leaf wins over a finalized- prefix',
  classifyArtworkKey('finalized-thing/ai-1.jpg') === 'generated')

// The restore trust boundary. This is the whole security story of the POST.
check('restorable: own prefix', isRestorableArtworkKey(`${PID}/ai-1.jpg`, PID) === true)
check('restorable: case-insensitive (iOS spells UUIDs uppercase)',
  isRestorableArtworkKey(`${PID.toUpperCase()}/ai-1.jpg`, PID) === true)
check('restorable: REJECTS another project\'s object',
  isRestorableArtworkKey(`${OTHER}/ai-1.jpg`, PID) === false,
  'this is the check that makes restore narrower than PATCH')
check('restorable: REJECTS a bucket-root key',
  isRestorableArtworkKey('collection-ad99235d-e463-4139-bcb9-0b0067c0f129-1787222896.jpg', PID) === false,
  'a key with no prefix attributes itself to nobody')
check('restorable: REJECTS the covers/<collectionId>/ prefix',
  isRestorableArtworkKey(`covers/${PID}/ai-1.jpg`, PID) === false,
  'first segment is `covers`, so it names no project')
check('restorable: REJECTS traversal-shaped input',
  isRestorableArtworkKey(`../${PID}/ai-1.jpg`, PID) === false)
for (const bad of [null, undefined, '', 5, {}, [], true]) {
  check(`restorable: REJECTS ${JSON.stringify(bad) ?? String(bad)}`, isRestorableArtworkKey(bad, PID) === false)
}

// The restore-target decision — the semantic core.
const finalizedPatch = artworkRestorePatch('finalized', 'https://x/f.jpg')
check('restore: a finalized render replaces ONLY the finalized slot',
  finalizedPatch.finalized_artwork_url === 'https://x/f.jpg' && !('artwork_url' in finalizedPatch),
  'it already has the lockup burned in; clobbering artwork_url would lose the source it was rendered FROM')
for (const kind of ['generated', 'upload']) {
  const patch = artworkRestorePatch(kind, 'https://x/s.jpg')
  check(`restore: a ${kind} source sets artwork_url AND clears the finalized render`,
    patch.artwork_url === 'https://x/s.jpg' && patch.finalized_artwork_url === null,
    'displayArtworkUrl prefers finalized, so leaving a stale one shows an unrelated image everywhere')
}

// Sorting: newest first, nulls last, and a TOTAL order.
const sorted = [
  { path: 'b', createdAt: '2026-08-01T00:00:00Z' },
  { path: 'a', createdAt: null },
  { path: 'd', createdAt: '2026-08-20T00:00:00Z' },
  { path: 'c', createdAt: '2026-08-20T00:00:00Z' },
  { path: 'z', createdAt: null },
].sort(compareArtworkItems).map(i => i.path)
check('sort: newest first', sorted[0] === 'd' && sorted[1] === 'c' && sorted[2] === 'b',
  `got ${sorted.join(',')}`)
check('sort: same-timestamp ties break by name, descending', sorted[0] === 'd' && sorted[1] === 'c',
  'four finalized renders landed within 28s on 2026-08-07 — without this the strip reshuffles between loads')
check('sort: null timestamps go LAST, not first', sorted[3] === 'z' && sorted[4] === 'a',
  `got ${sorted.join(',')}`)

// "Flag, never filter" — the 2026-08-14 lesson, encoded.
const entries = [
  { path: `${PID}/ai-1.jpg`, createdAt: '2026-08-01T00:00:00Z', size: 10 },
  { path: `${PID}/finalized-2.jpg`, createdAt: '2026-08-02T00:00:00Z', size: 20 },
  { path: `${PID}/cover.jpg`, createdAt: '2026-08-03T00:00:00Z', size: 30 },
]
const built = buildArtworkHistory(entries, p => `https://x/${p}`, [`${PID}/cover.jpg`, `${PID}/finalized-2.jpg`])
check('build: nothing is ever dropped', built.length === entries.length,
  `${built.length} of ${entries.length} survived — filtering is how "unreferenced" became "junk" on 08-14`)
check('build: both live columns are flagged current',
  built.filter(i => i.current).map(i => i.path).sort().join(',') ===
    [`${PID}/cover.jpg`, `${PID}/finalized-2.jpg`].sort().join(','))
check('build: the superseded draft is NOT flagged current',
  built.find(i => i.path === `${PID}/ai-1.jpg`).current === false)
check('build: url comes from the injected builder', built.every(i => i.url === `https://x/${i.path}`))
check('build: size and createdAt survive', built.find(i => i.size === 30).path === `${PID}/cover.jpg`)
check('build: a null current column is not treated as a path',
  buildArtworkHistory(entries, p => p, [null, undefined]).every(i => i.current === false))

// ── B. The route's ADDRESS — the public-prefix trap ─────────────────────────
console.log('\n── B. route address vs PUBLIC_PATHS ──')

const proxySrc = read('src/proxy.ts')
const publicBlock = stripComments(proxySrc).match(/const PUBLIC_PATHS = \[([\s\S]*?)\]/)
check('proxy.ts still declares PUBLIC_PATHS as an array literal', !!publicBlock)
const publicPaths = [...(publicBlock?.[1] ?? '').matchAll(/'([^']+)'/g)].map(m => m[1])
check('PUBLIC_PATHS parsed', publicPaths.length > 5, `${publicPaths.length} entries`)

// The trap, stated as an assertion: the `/api/artwork` subtree IS public, so
// the obvious address for this feature would have been unauthenticated.
// The entry gained a trailing slash on 2026-08-22 — it is still a startsWith()
// PREFIX, so the trap it creates for anything named `/api/artwork/<x>` is
// unchanged; the slash only stops it swallowing a sibling like
// `/api/artwork-history`. Asserted on the prefix, not the exact spelling, so a
// future re-tightening does not read as the trap having disappeared.
check('the /api/artwork subtree is still public (the trap is real, not folklore)',
  publicPaths.some(p => p === '/api/artwork' || p === '/api/artwork/'))
check('...and it is a prefix, not an exact match, so children inherit it',
  publicPaths.some(p => p.startsWith('/api/artwork')))
check('middleware still matches PUBLIC_PATHS with startsWith',
  /PUBLIC_PATHS\.some\(p => pathname\.startsWith\(p\)\)/.test(stripComments(proxySrc)),
  'if this becomes an exact match the trap dissolves and this section can relax')

// The general invariant, not a check on one route: a route that demands
// X-User-Id can never sit under a PUBLIC_PATHS prefix, because middleware skips
// such paths entirely and never injects the header — so the route would either
// 401 unconditionally or, if the guard were ever relaxed, serve anonymously.
// Written as a sweep over EVERY api route (72 of them today, all clean) rather
// than as an assertion about artwork-history, so it also catches the next route
// someone files under /api/artwork/, and any future widening of PUBLIC_PATHS.
const apiRoutes = walkRoutes(join(root, 'src/app/api'), '/api')
check('api route census is non-trivial', apiRoutes.length > 40, `${apiRoutes.length} routes`)
check('artwork-history is in the census',
  apiRoutes.some(r => r.file.includes('artwork-history')),
  'if this fails the route was moved or deleted — the sweep below would silently pass over nothing')

const publicised = apiRoutes
  .filter(r => r.requiresUser)
  .map(r => ({ ...r, swallowedBy: publicPaths.filter(p => r.url.startsWith(p)) }))
  .filter(r => r.swallowedBy.length > 0)
check('NO auth-requiring api route sits under a PUBLIC_PATHS prefix',
  publicised.length === 0,
  publicised.map(r => `${r.url} <- ${r.swallowedBy.join(',')}`).join(' | ') || 'all clean')

// And the route file is where that address says it is.
const routeSrc = read('src/app/api/projects/[id]/artwork-history/route.ts')
const routeBare = stripComments(routeSrc)
for (const verb of ['GET', 'POST']) {
  check(`${verb} reads identity from the X-User-Id header only`,
    new RegExp(`export async function ${verb}[\\s\\S]{0,400}?request\\.headers\\.get\\('X-User-Id'\\)`).test(routeBare),
    'never from the body — middleware strips inbound x-user-id so only this header is trustworthy')
}
check('both verbs 401 without an identity',
  (routeBare.match(/status: 401/g) ?? []).length >= 2)
check('ownership is scoped in SQL, not compared in JS',
  /\.eq\('id', id\)[\s\S]{0,80}\.eq\('user_id', userId\)/.test(routeBare))
check('the restore UPDATE re-asserts user_id (TOCTOU)',
  /\.update\(\{[\s\S]{0,120}\}\)[\s\S]{0,400}?\.eq\('user_id', userId\)/.test(routeBare))
check('non-owner and non-existent are both 404 — no existence oracle',
  !/status: 403/.test(routeBare) && /status: 404/.test(routeBare))
check('the POST guards the path with isRestorableArtworkKey, not isSupabaseStorageUrl',
  routeBare.includes('isRestorableArtworkKey') && !routeBare.includes('isSupabaseStorageUrl'),
  'isSupabaseStorageUrl validates protocol+hostname only and admits a stranger\'s object')
check('a partial listing is a 503, never a short history',
  /entries === null[\s\S]{0,200}status: 503/.test(routeBare),
  'answering "you have 2" when the walk died after 2 of 9 recreates the bug this feature fixes')
check('the listing goes through listProjectPrefix (which re-validates the prefix)',
  routeBare.includes('listProjectPrefix'),
  'a hand-rolled prefix here could degrade into a bucket-wide listing')
check('the route never deletes',
  !/\.remove\(|removeStorageObjects|\.delete\(/.test(routeBare),
  'Artwork History is non-destructive by construction')
check('the POST rejects a non-object JSON body',
  /typeof body !== 'object'/.test(routeBare),
  "JSON.parse('5') is truthy — `'path' in 5` throws and 500s (the /api/versions/[id] defect)")
check('both verbs are rate limited', (routeBare.match(/checkUserLimit\(/g) ?? []).length >= 2)

// ── C1. The anon-client upload defect ───────────────────────────────────────
console.log('\n── C1. server-side storage writes run as service role ──')

check('src/lib/supabase-server.ts is gone', (() => {
  try { read('src/lib/supabase-server.ts'); return false } catch { return true }
})(), 'a helper that silently hands out ANON privileges to any route that imports it')

for (const file of ['src/app/api/generate-artwork/route.ts', 'src/app/api/finalize-artwork/route.ts']) {
  const src = stripComments(read(file))
  check(`${file}: does not import the anon SSR client`, !src.includes('supabase-server'))
  check(`${file}: uploads via supabaseAdmin`,
    /supabaseAdmin\.storage\s*\n?\s*\.from\('mf-artwork'\)\s*\n?\s*\.upload\(/.test(src),
    'anon cannot satisfy migration 029\'s `INSERT TO authenticated` policy')
}

// The general rule, not an exception list: no server route may reach storage
// through a client that is not supabaseAdmin.
const serverStorageCalls = []
for (const file of [
  'src/app/api/generate-artwork/route.ts',
  'src/app/api/finalize-artwork/route.ts',
  'src/app/api/upload-audio/route.ts',
  'src/app/api/upload-url/route.ts',
  'src/app/api/visualizer/finalize/route.ts',
  'src/app/api/projects/[id]/artwork-history/route.ts',
]) {
  for (const line of stripComments(read(file)).split('\n')) {
    if (/(?<![A-Za-z])\.storage\b/.test(line) && !/supabaseAdmin\.storage/.test(line)) {
      serverStorageCalls.push(`${file}: ${line.trim()}`)
    }
  }
}
check('no audited server route touches storage with a non-admin client',
  serverStorageCalls.length === 0, serverStorageCalls.join(' | '))

// ── C2. mb_collections in the survivor scan ─────────────────────────────────
console.log('\n── C2. collection covers cannot be deleted by a project delete ──')

const pairs = ASSET_URL_COLUMNS.map(([t, c]) => `${t}.${c}`)
check('ASSET_URL_COLUMNS names mb_collections.cover_url', pairs.includes('mb_collections.cover_url'),
  'collection TYPE II covers itself with an object inside project TRENCH\'s prefix')
check('ASSET_URL_COLUMNS names mb_collections.artwork_url (migration 004 legacy, still read by iOS)',
  pairs.includes('mb_collections.artwork_url'))

// The derivation and the column list must agree, or the scan asks about a
// column whose answer it then throws away.
const fromCollections = collectAssetKeys({
  collections: [{
    cover_url: `https://mdefkqaawrusoaojstpq.supabase.co/storage/v1/object/public/mf-artwork/${PID}/ai-1783622744357.webp`,
    artwork_url: `https://mdefkqaawrusoaojstpq.supabase.co/storage/v1/object/public/mf-artwork/${OTHER}/cover.jpg`,
  }],
})
check('collectAssetKeys derives keys from a collection row',
  fromCollections['mf-artwork'].sort().join(',') === [`${PID}/ai-1783622744357.webp`, `${OTHER}/cover.jpg`].sort().join(','),
  `got ${JSON.stringify(fromCollections['mf-artwork'])}`)
check('collectAssetUrls includes collection covers',
  collectAssetUrls({ collections: [{ cover_url: 'https://h/x' }] }).includes('https://h/x'))

// The optional-column set must be keyed by TABLE.COLUMN. Keyed by column alone,
// 'artwork_url' would excuse an mb_projects.artwork_url failure — turning a
// broken scan into a licence to delete.
check('mb_collections.artwork_url is optional', OPTIONAL_ASSET_URL_COLUMNS.has('mb_collections.artwork_url'))
check('mb_projects.artwork_url is NOT optional', !OPTIONAL_ASSET_URL_COLUMNS.has('mb_projects.artwork_url'),
  'its absence is a broken scan, never "nothing to protect"')
check('mb_projects.artwork_url is not excused by a bare column name',
  ![...OPTIONAL_ASSET_URL_COLUMNS].includes('artwork_url'))
check('errorNamesColumn is scoped per column',
  errorNamesColumn({ message: "column mb_collections.cover_url does not exist" }, 'cover_url') === true &&
  errorNamesColumn({ message: "column mb_collections.cover_url does not exist" }, 'artwork_url') === false)
check('errorNamesColumn is false for a null error', errorNamesColumn(null, 'cover_url') === false)

// The route must CONSUME the shared list rather than re-declaring one. Two
// copies is how this drifted out of step in the first place.
const deleteRoute = stripComments(read('src/app/api/projects/[id]/route.ts'))
check('the delete route imports ASSET_URL_COLUMNS', deleteRoute.includes('ASSET_URL_COLUMNS'))
check('the delete route no longer re-declares its own column literal',
  !/const columns = \[\s*\n\s*\['mb_versions'/.test(deleteRoute),
  'a second literal that had to be hand-synced with ASSET_URL_COLUMNS — and had already drifted')
check('the survivor derivation receives the collections it collected',
  /collectAssetKeys\(\{[^}]*collections[^}]*\}\)/.test(deleteRoute))
check('mb_collections rows are absorbed into their own accumulator',
  /table === 'mb_collections'\) collections\.push/.test(deleteRoute))

// The other half of the same blind spot. DELETE /api/projects/[id] must not
// delete a collection's cover; POST /api/auth/delete-account must. Until
// 2026-08-21 it enumerated collections with select('id') in the row-delete
// phase, so a cover was never a CANDIDATE and its bytes outlived the user's
// erasure in a public bucket — the GDPR-facing mirror of C2.
const accountRoute = stripComments(read('src/app/api/auth/delete-account/route.ts'))
check('account erasure enumerates collections with all their columns',
  /from\('mb_collections'\)\.select\('\*'\)/.test(accountRoute),
  "select('id') cannot see cover_url; a named-column select breaks when either spelling is absent")
check('account erasure feeds collections into the shared derivation',
  /collections: collections \?\? \[\]/.test(accountRoute),
  'enumerating them and then not deriving their keys would leak just as quietly')
check('account erasure enumerates collections exactly once',
  (accountRoute.match(/from\('mb_collections'\)\.select\(/g) ?? []).length === 1,
  'two enumerations of the same rows is the drift this file keeps being bitten by')

console.log(`\n${failures === 0 ? '✓ all checks passed' : `✗ ${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
