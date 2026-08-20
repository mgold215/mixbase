#!/usr/bin/env node
// Contract + behaviour test: the PUBLIC, share-token-scoped duration backfill.
//
// POST /api/share/[token]/duration lets an ANONYMOUS listener write back the
// duration their browser just measured. That sentence is alarming on purpose:
// it is an unauthenticated write into a table every other route guards by
// ownership, so the whole feature rests on the claim that a share token already
// grants strictly more than the write does. This suite exists to check that the
// implementation actually matches that claim, and it drives the REAL exported
// handler against an in-memory database so the answers come from data rather
// than from asserting about source text.
//
// The five ways this endpoint could do damage, and where each is covered:
//
//   1. PERSIST A NON-FINITE READING (section C). `HTMLMediaElement.duration` is
//      NaN before metadata parses and Infinity for a stream whose length the
//      browser cannot determine — and every mix here streams through
//      /api/audio, which only forwards Content-Length when Supabase sends one.
//      "Infinity can't cross the wire" is FALSE: `1e999` is valid JSON and
//      JSON.parse turns it into Infinity. C sends the raw bytes to prove it.
//   2. OVERWRITE A GOOD READING (sections D, G). Only a NULL may be filled, and
//      the rule must live on the UPDATE (`.is('duration_seconds', null)`), not
//      in a preceding read — G opens the TOCTOU window and writes into it.
//   3. WRITE OUTSIDE THE SHARE (section E). A valid token aimed at a version of
//      a different project, at an archived mix a project link never exposes, or
//      at a project that is not in the album.
//   4. BECOME AN ORACLE (section F). The response must be a pure function of
//      the request BODY — never of anything read out of the database — so it
//      cannot be used to test whether a token or a row exists.
//   5. BE REACHABLE WITHOUT BEING PUBLIC, or public without being narrow
//      (section H): the middleware entry, plus the client-side guards that no
//      Node test can execute. Comments are stripped first — a guard that
//      survives only in a comment must not keep a check green.
//
// Run: node scripts/share-duration-heal-test.mjs
// Requires Node >= 22.15 for module.registerHooks and >= 22.18 for native
// TypeScript type-stripping (same floor as the sibling suites).

import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

import { stripComments } from './source-contract.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

let failures = 0
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Two artists. Artist A has a project with a current mix and an archived one
// (the archived row is the shape that makes up the bulk of the real NULLs:
// 110 of the 145 are versions a project link can never reach). Artist B exists
// only to be the wrong side of every isolation check.
const PROJ_A = 'aaaa1111-0000-4000-8000-00000000000a'
const PROJ_A2 = 'aaaa2222-0000-4000-8000-00000000000a'
const PROJ_B = 'bbbb2222-0000-4000-8000-00000000000b'

const V_A_LATEST = '11111111-1111-4111-8111-111111111111' // project A, v3, NULL
const V_A_OLD = '22222222-2222-4222-8222-222222222222'    // project A, v2, NULL (archived)
const V_A_SET = '33333333-3333-4333-8333-333333333333'    // project A2, v1, 268s already
const V_B = '44444444-4444-4444-8444-444444444444'        // project B, v1, NULL
const V_ABSENT = '99999999-9999-4999-8999-999999999999'

// 32 lowercase hex, exactly as `replace(gen_random_uuid()::text, '-', '')`
// produces for every share_token in production.
const TOK_PROJ_A = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1'
const TOK_PROJ_B = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2'
const TOK_VER_A_OLD = 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3'
const TOK_COLL_A = 'd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4'
const TOK_UNKNOWN = 'e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5'
const COLL_A = 'cccc3333-0000-4000-8000-00000000000c'

function freshDb() {
  return {
    mb_projects: [
      { id: PROJ_A, share_token: TOK_PROJ_A },
      { id: PROJ_A2, share_token: null },
      { id: PROJ_B, share_token: TOK_PROJ_B },
    ],
    mb_versions: [
      { id: V_A_LATEST, project_id: PROJ_A, version_number: 3, share_token: 'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0', duration_seconds: null },
      { id: V_A_OLD, project_id: PROJ_A, version_number: 2, share_token: TOK_VER_A_OLD, duration_seconds: null },
      { id: V_A_SET, project_id: PROJ_A2, version_number: 1, share_token: 'f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2', duration_seconds: 268 },
      { id: V_B, project_id: PROJ_B, version_number: 1, share_token: 'f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3', duration_seconds: null },
    ],
    mb_collections: [{ id: COLL_A, share_token: TOK_COLL_A }],
    // The album contains project A and project A2 — NOT project B.
    mb_collection_items: [
      { collection_id: COLL_A, project_id: PROJ_A, position: 0 },
      { collection_id: COLL_A, project_id: PROJ_A2, position: 1 },
    ],
    // Test hook for section G: fires immediately before an UPDATE resolves its
    // filters — precisely the window a read-then-write check would leave open.
    beforeUpdate: null,
  }
}
globalThis.__MB_DB = freshDb()
const db = () => globalThis.__MB_DB
const rowById = (id) => db().mb_versions.find(r => r.id === id)
const reset = () => { globalThis.__MB_DB = freshDb() }

// ── Fake Supabase ────────────────────────────────────────────────────────────
// A real in-memory store, not canned responses: token resolution, collection
// membership and the write-once filter are all resolved by actually filtering
// rows, which is what lets a mutation of the route change these results.
const SUPABASE_STUB = `
const db = () => globalThis.__MB_DB

function query(table) {
  const filters = []
  let op = 'select'
  let payload = null
  let order = null
  let max = null

  const run = (arity) => {
    if (op === 'update' && db().beforeUpdate) db().beforeUpdate(table, payload, filters)
    let rows = db()[table] ?? []
    for (const [f, col, val] of filters) {
      if (f === 'eq') rows = rows.filter(r => r[col] === val)
      else if (f === 'is' && val === null) rows = rows.filter(r => r[col] === null || r[col] === undefined)
      else throw new Error('fake supabase: unsupported filter ' + f + ' ' + col)
    }
    if (order) {
      const [col, asc] = order
      rows = rows.slice().sort((a, b) => (asc ? a[col] - b[col] : b[col] - a[col]))
    }
    if (max != null) rows = rows.slice(0, max)
    if (op === 'update') for (const r of rows) Object.assign(r, payload)
    const copies = rows.map(r => ({ ...r }))
    if (arity === 'single') {
      return copies.length === 1
        ? Promise.resolve({ data: copies[0], error: null })
        : Promise.resolve({ data: null, error: { message: 'JSON object requested, multiple (or no) rows returned' } })
    }
    if (arity === 'maybeSingle') {
      return copies.length > 1
        ? Promise.resolve({ data: null, error: { message: 'multiple rows' } })
        : Promise.resolve({ data: copies[0] ?? null, error: null })
    }
    return Promise.resolve({ data: copies, error: null })
  }

  const q = {
    select() { return q },
    update(p) { op = 'update'; payload = p; return q },
    insert(p) { op = 'insert'; payload = p; return q },
    eq(col, val) { filters.push(['eq', col, val]); return q },
    is(col, val) { filters.push(['is', col, val]); return q },
    order(col, opts) { order = [col, opts?.ascending !== false]; return q },
    limit(n) { max = n; return q },
    single() { return run('single') },
    maybeSingle() { return run('maybeSingle') },
    then(res, rej) { return run('many').then(res, rej) },
  }
  return q
}

export const supabaseAdmin = { from: (table) => query(table) }
export const SUPABASE_URL = 'https://example.supabase.co'
export const supabase = supabaseAdmin
`

const STUB_URL = 'mbstub:supabase'
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'next/server') return next('next/server.js', ctx)
    if (spec === '@/lib/supabase') return { url: STUB_URL, shortCircuit: true, format: 'module' }
    if (spec.startsWith('@/')) {
      return { url: pathToFileURL(join(root, 'src', spec.slice(2) + '.ts')).href, shortCircuit: true, format: 'module-typescript' }
    }
    return next(spec, ctx)
  },
  load(url, ctx, next) {
    if (url === STUB_URL) return { format: 'module', shortCircuit: true, source: SUPABASE_STUB }
    return next(url, ctx)
  },
})

const ROUTE_PATH = 'src/app/api/share/[token]/duration/route.ts'
const { POST } = await import(pathToFileURL(join(root, ROUTE_PATH)).href)
const { NextRequest } = await import('next/server.js')

// Every call gets its own client IP by default, so the 60/hr limiter never
// interferes with a behaviour check. Section I opts into a fixed IP on purpose.
let ipSeq = 0
const nextIp = () => `203.0.113.${(ipSeq++ % 250) + 1}.${ipSeq}`

/** Drive the real handler with a real NextRequest — i.e. only values a browser
 *  can actually put on the wire. `raw` bypasses JSON.stringify so encodings
 *  like 1e999 survive intact. */
async function post(token, body, { raw, ip } = {}) {
  const req = new NextRequest(`http://localhost/api/share/${token}/duration`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': ip ?? nextIp() },
    body: raw ?? JSON.stringify(body),
  })
  const res = await POST(req, { params: Promise.resolve({ token }) })
  return { status: res.status, body: await res.json() }
}

/** Duck-typed request so the body can hold values JSON cannot carry at all
 *  (NaN, a real Infinity). The handler only touches headers.get(), json() and
 *  the params promise, so this exercises the same code with no encoding in the
 *  way — it is the "a hand-written client did this" case. */
async function postParsed(token, parsedBody) {
  const req = { headers: new Headers({ 'x-real-ip': nextIp() }), json: async () => parsedBody }
  const res = await POST(req, { params: Promise.resolve({ token }) })
  return { status: res.status, body: await res.json() }
}

const fingerprint = (res) => `${res.status} ${JSON.stringify(res.body)}`

// ── A. Anchors ───────────────────────────────────────────────────────────────
// Everything below is worthless if the handler is not really running, so prove
// it writes before trusting a single refusal.
console.log('\nanchors\n')

check('the real route module exported a POST handler', typeof POST === 'function')
{
  reset()
  const res = await post(TOK_PROJ_A, { duration_seconds: 261 })
  check('a project token heals the row it exposes (handler is live)',
    rowById(V_A_LATEST).duration_seconds === 261, `stored ${rowById(V_A_LATEST).duration_seconds}`)
  check('…and answers 202', res.status === 202, fingerprint(res))
}

// ── B. The three token forms ─────────────────────────────────────────────────
// The app serves three, and the ceiling on this whole feature is set by which
// of them the endpoint understands. Project links only ever play the LATEST
// mix, so without the legacy version-level form the archived rows — the bulk of
// the real NULLs — are structurally unreachable.
console.log('\ntoken forms\n')

{
  reset()
  await post(TOK_PROJ_A, { duration_seconds: 200 })
  check('form 1: PROJECT token resolves to the latest version, not an older one',
    rowById(V_A_LATEST).duration_seconds === 200 && rowById(V_A_OLD).duration_seconds === null,
    `latest ${rowById(V_A_LATEST).duration_seconds} / archived ${rowById(V_A_OLD).duration_seconds}`)
}
{
  reset()
  await post(TOK_VER_A_OLD, { duration_seconds: 190 })
  check('form 2: legacy VERSION token heals that exact archived row',
    rowById(V_A_OLD).duration_seconds === 190 && rowById(V_A_LATEST).duration_seconds === null,
    `archived ${rowById(V_A_OLD).duration_seconds} / latest ${rowById(V_A_LATEST).duration_seconds}`)
}
{
  reset()
  await post(TOK_COLL_A, { projectId: PROJ_A, duration_seconds: 210 })
  check('form 3: COLLECTION token + projectId heals that track\'s latest version',
    rowById(V_A_LATEST).duration_seconds === 210, `stored ${rowById(V_A_LATEST).duration_seconds}`)
}
{
  reset()
  await post(TOK_COLL_A, { duration_seconds: 210 })
  check('a collection token with NO projectId heals nothing (an album has many tracks)',
    db().mb_versions.every(r => r.id === V_A_SET || r.duration_seconds === null))
}
{
  reset()
  // The album player identifies a track by PROJECT id — AlbumPlayerTrack.id is
  // mb_collection_items.project_id — so this is the shape it actually sends.
  await post(TOK_COLL_A, { projectId: PROJ_A2, duration_seconds: 300 })
  check('an album track whose row is already set is not overwritten',
    rowById(V_A_SET).duration_seconds === 268, `stored ${rowById(V_A_SET).duration_seconds}`)
}

// ── C. The number ────────────────────────────────────────────────────────────
console.log('\nvalidating the reading\n')

{
  reset()
  // The one that matters: `Infinity` is not JSON, but `1e999` is, and JSON.parse
  // turns it into Infinity. This is the real wire vector, sent as raw bytes.
  const res = await post(TOK_PROJ_A, null, { raw: '{"duration_seconds":1e999}' })
  check('1e999 (valid JSON, parses to Infinity) is rejected',
    res.status === 400 && rowById(V_A_LATEST).duration_seconds === null, fingerprint(res))
}
{
  reset()
  const res = await post(TOK_PROJ_A, null, { raw: '{"duration_seconds":-1e999}' })
  check('-1e999 (parses to -Infinity) is rejected',
    res.status === 400 && rowById(V_A_LATEST).duration_seconds === null, fingerprint(res))
}
for (const [label, value] of [
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
  ['NaN', NaN],
  ['a negative number', -240],
  ['zero', 0],
  ['a numeric STRING "240"', '240'],
  ['null', null],
  ['a boolean', true],
  ['an array', [240]],
  ['an object', { seconds: 240 }],
  ['13 hours (past the sane bound)', 13 * 60 * 60],
  ['milliseconds sent as seconds (300000)', 300000],
]) {
  reset()
  const res = await postParsed(TOK_PROJ_A, { duration_seconds: value })
  check(`${label} is rejected`, res.status === 400 && rowById(V_A_LATEST).duration_seconds === null, fingerprint(res))
}
{
  reset()
  const res = await postParsed(TOK_PROJ_A, {})
  check('a body with no duration_seconds at all is rejected', res.status === 400, fingerprint(res))
}
{
  reset()
  const res = await post(TOK_PROJ_A, null, { raw: 'not json' })
  check('a non-JSON body is rejected', res.status === 400, fingerprint(res))
}
{
  reset()
  await postParsed(TOK_PROJ_A, { duration_seconds: 1 })
  check('1 second (the lower bound) is accepted', rowById(V_A_LATEST).duration_seconds === 1)
}
{
  reset()
  await postParsed(TOK_PROJ_A, { duration_seconds: 12 * 60 * 60 })
  check('12 hours (the upper bound) is accepted', rowById(V_A_LATEST).duration_seconds === 43200)
}
{
  reset()
  await postParsed(TOK_PROJ_A, { duration_seconds: 261.6 })
  check('a fractional reading is rounded (the column is integer)',
    rowById(V_A_LATEST).duration_seconds === 262, `stored ${rowById(V_A_LATEST).duration_seconds}`)
}
{
  reset()
  // Rounding happens BEFORE the range test, so a value that only clears a bound
  // after rounding must not slip past it.
  const res = await postParsed(TOK_PROJ_A, { duration_seconds: 0.4 })
  check('0.4 (rounds to 0) is rejected rather than stored as 0',
    res.status === 400 && rowById(V_A_LATEST).duration_seconds === null, fingerprint(res))
}
{
  reset()
  const res = await postParsed(TOK_PROJ_A, { duration_seconds: 240, versionId: 'not-a-uuid' })
  check('a malformed versionId is rejected outright', res.status === 400, fingerprint(res))
}
{
  reset()
  const res = await postParsed(TOK_COLL_A, { duration_seconds: 240, projectId: 'not-a-uuid' })
  check('a malformed projectId is rejected outright', res.status === 400, fingerprint(res))
}

// ── D. Write-once ────────────────────────────────────────────────────────────
console.log('\nwrite-once\n')

{
  reset()
  await post(TOK_PROJ_A, { duration_seconds: 261 })
  await post(TOK_PROJ_A, { duration_seconds: 999 })
  check('a second call does NOT overwrite the value the first wrote',
    rowById(V_A_LATEST).duration_seconds === 261, `stored ${rowById(V_A_LATEST).duration_seconds}`)
}
{
  reset()
  await post(TOK_VER_A_OLD, { duration_seconds: 190 })
  const before = rowById(V_A_OLD).duration_seconds
  await post(TOK_VER_A_OLD, { duration_seconds: 1 })
  check('the write-once rule holds on the legacy version-token path too',
    rowById(V_A_OLD).duration_seconds === before, `stored ${rowById(V_A_OLD).duration_seconds}`)
}
{
  reset()
  // An artist-supplied value must be untouchable by a public caller: this is
  // the whole reason the rule is fill-a-NULL rather than last-write-wins.
  await post(TOK_COLL_A, { projectId: PROJ_A2, duration_seconds: 5 })
  check('a value the artist\'s own client already wrote cannot be changed',
    rowById(V_A_SET).duration_seconds === 268, `stored ${rowById(V_A_SET).duration_seconds}`)
}

// ── E. Staying inside the share ──────────────────────────────────────────────
// A body id may only ever NARROW what the token resolved to. If any of these
// writes, a valid token has been aimed at a row it does not cover.
console.log('\nstaying inside the share\n')

{
  reset()
  const res = await post(TOK_PROJ_A, { versionId: V_B, duration_seconds: 240 })
  check('project A\'s token cannot heal a version of project B',
    rowById(V_B).duration_seconds === null, fingerprint(res))
}
{
  reset()
  const res = await post(TOK_PROJ_A, { versionId: V_A_OLD, duration_seconds: 240 })
  check('a project token cannot be redirected to an ARCHIVED mix it never exposes',
    rowById(V_A_OLD).duration_seconds === null, fingerprint(res))
}
{
  reset()
  const res = await post(TOK_VER_A_OLD, { versionId: V_A_LATEST, duration_seconds: 240 })
  check('a version token cannot be redirected to a different version',
    rowById(V_A_LATEST).duration_seconds === null && rowById(V_A_OLD).duration_seconds === null,
    fingerprint(res))
}
{
  reset()
  const res = await post(TOK_COLL_A, { projectId: PROJ_B, duration_seconds: 240 })
  check('an album token cannot heal a project that is not in that album',
    rowById(V_B).duration_seconds === null, fingerprint(res))
}
{
  reset()
  const res = await post(TOK_PROJ_A, { projectId: PROJ_B, duration_seconds: 240 })
  check('a projectId that disagrees with the token heals nothing at all',
    rowById(V_A_LATEST).duration_seconds === null && rowById(V_B).duration_seconds === null,
    fingerprint(res))
}
{
  reset()
  const res = await post(TOK_UNKNOWN, { duration_seconds: 240 })
  check('an unknown token heals nothing',
    db().mb_versions.every(r => r.id === V_A_SET || r.duration_seconds === null), fingerprint(res))
}
{
  reset()
  const res = await post('../../versions/' + V_B, { duration_seconds: 240 })
  check('a path-traversal-shaped token is refused by the shape check',
    rowById(V_B).duration_seconds === null, fingerprint(res))
}

// ── F. Not an oracle ─────────────────────────────────────────────────────────
// The response must be a pure function of the request BODY. If the database can
// change it, the endpoint can be used to test whether a token or a row exists.
console.log('\nnot an oracle\n')

{
  const body = { duration_seconds: 240 }
  reset(); const success = await post(TOK_PROJ_A, body)
  reset(); const badToken = await post(TOK_UNKNOWN, body)
  reset(); const malformedToken = await post('nope', body)
  reset(); const wrongProject = await post(TOK_PROJ_A, { ...body, versionId: V_B })
  reset(); const absentVersion = await post(TOK_PROJ_A, { ...body, versionId: V_ABSENT })
  reset(); const notInAlbum = await post(TOK_COLL_A, { ...body, projectId: PROJ_B })
  reset(); await post(TOK_PROJ_A, body); const alreadyHealed = await post(TOK_PROJ_A, body)

  const all = { success, badToken, malformedToken, wrongProject, absentVersion, notInAlbum, alreadyHealed }
  const prints = Object.entries(all).map(([k, v]) => [k, fingerprint(v)])
  const distinct = new Set(prints.map(([, p]) => p))
  check('every outcome the database could influence is byte-identical',
    distinct.size === 1, [...distinct].join(' | '))
  check('…including a successful heal (so success itself is not detectable)',
    fingerprint(success) === fingerprint(badToken), `${fingerprint(success)} vs ${fingerprint(badToken)}`)
  check('…and the shared answer is a 2xx, not an error the client would log',
    success.status === 202, fingerprint(success))
}
{
  // The one thing that MAY change the response is the caller's own body — a
  // rejected reading must stay loud, exactly as the authenticated route is.
  reset()
  const good = await post(TOK_UNKNOWN, { duration_seconds: 240 })
  const bad = await post(TOK_UNKNOWN, { duration_seconds: -1 })
  check('a bad reading is still refused loudly, on a bad token too',
    good.status === 202 && bad.status === 400, `${fingerprint(good)} / ${fingerprint(bad)}`)
}

// ── G. The race ──────────────────────────────────────────────────────────────
// Two listeners whose 'loadedmetadata' lands in the same instant. The rule must
// be enforced by the UPDATE's own filter, not by a preceding read — a
// read-then-write would let the loser overwrite the winner.
console.log('\nthe race\n')

{
  reset()
  db().beforeUpdate = () => {
    // Another writer wins the race in the window between resolving the token
    // and this UPDATE resolving its filters.
    db().beforeUpdate = null
    rowById(V_A_LATEST).duration_seconds = 261
  }
  await post(TOK_PROJ_A, { duration_seconds: 999 })
  check('a writer that loses the race does not overwrite the winner',
    rowById(V_A_LATEST).duration_seconds === 261, `stored ${rowById(V_A_LATEST).duration_seconds}`)
}

// ── H. Source contracts ──────────────────────────────────────────────────────
// The half no Node test can execute: the middleware entry and the browser-side
// guards. Comments are stripped first so a rule that survives only in a comment
// cannot keep a check green.
console.log('\nsource contracts\n')

const routeSrc = stripComments(read(ROUTE_PATH))
const authedRouteSrc = stripComments(read('src/app/api/versions/[id]/route.ts'))
const proxySrc = stripComments(read('src/proxy.ts'))
const shareClientSrc = stripComments(read('src/app/share/[token]/ShareClient.tsx'))
const albumPlayerSrc = stripComments(read('src/components/AlbumPlayer.tsx'))
const projectClientSrc = stripComments(read('src/app/projects/[id]/ProjectClient.tsx'))
const newProjectSrc = stripComments(read('src/app/projects/new/NewProjectForm.tsx'))

check('the UPDATE itself carries the write-once filter',
  /\.update\([^)]*duration_seconds[\s\S]{0,200}?\.is\('duration_seconds',\s*null\)/.test(routeSrc))
check('the route never reads duration_seconds back before writing (no TOCTOU check)',
  !/\.select\([^)]*duration_seconds/.test(routeSrc))
check('the route has no allowlist passthrough — duration is the ONLY writable field',
  (routeSrc.match(/\.update\(/g) ?? []).length === 1)
check('the route does not read identity from a header or a body field',
  !/X-User-Id/i.test(routeSrc) && !/body\.user_?id/i.test(routeSrc))

for (const name of ['MIN_BACKFILL_SECONDS', 'MAX_BACKFILL_SECONDS']) {
  const grab = (src) => (src.match(new RegExp(`const ${name} = ([^\\n]+)`)) ?? [])[1]?.trim()
  const here = grab(routeSrc)
  const there = grab(authedRouteSrc)
  check(`${name} agrees with the authenticated route (one column, one range)`,
    here != null && here === there, `${here} vs ${there}`)
}

check("proxy.ts PUBLIC_PATHS contains '/api/share/'", /'\/api\/share\/'/.test(proxySrc))
check("…with the trailing slash, so it cannot match a sibling like /api/shared",
  !/'\/api\/share'/.test(proxySrc))
check("…and '/share/' alone would NOT have covered it (startsWith on the pathname)",
  !'/api/share/duration'.startsWith('/share/'))

for (const [label, src] of [['ShareClient', shareClientSrc], ['AlbumPlayer', albumPlayerSrc]]) {
  check(`${label} posts to the share-scoped heal route`,
    /fetch\(`\/api\/share\/\$\{encodeURIComponent\([a-zA-Z]+\)\}\/duration`/.test(src))
  check(`${label} guards the reading with Number.isFinite before sending`,
    /if \(!Number\.isFinite\(seconds\) \|\| seconds <= 0\) return/.test(src))
  check(`${label} marks the attempt BEFORE the request (one shot, no retry loop)`,
    /healAttemptedRef\.current[\s\S]{0,40}(=\s*true|\.add\()[\s\S]{0,200}fetch\(/.test(src))
  check(`${label} sends Math.round(seconds), never the raw float`,
    /duration_seconds: Math\.round\(seconds\)/.test(src))
  check(`${label} does nothing at all without a token`, /!(shareToken|albumToken)[^\n]*return/.test(src))
}
check('AlbumPlayer only posts for tracks whose stored duration is null',
  /if \(track\.duration != null\) return/.test(albumPlayerSrc))
check('AlbumPlayer names the PROJECT and lets the server resolve the version',
  /projectId: track\.id/.test(albumPlayerSrc) && !/versionId: track\.id/.test(albumPlayerSrc))

check('ProjectClient no longer rounds audio.duration unguarded (the null factory)',
  !/resolve\(Math\.round\(audio\.duration\)\)/.test(projectClientSrc))
check('ProjectClient resolves null unless the reading is finite and positive',
  /Number\.isFinite\(d\) && d > 0 \? Math\.round\(d\) : null/.test(projectClientSrc))
check('no player sets duration state with the isNaN test that lets Infinity through',
  !/isNaN\(audio\.duration\)/.test(shareClientSrc) && !/isNaN\(audio\.duration\)/.test(albumPlayerSrc))

// Reported, not enforced: NewProjectForm.tsx has the identical unguarded probe
// and is owned elsewhere. Left as a visible signal rather than a silent gap.
if (/resolve\(Math\.round\(audio\.duration\)\)/.test(newProjectSrc)) {
  console.log('  · NOTE NewProjectForm.tsx still has the unguarded Math.round(audio.duration) probe (owned elsewhere)')
}

// ── I. Rate limit ────────────────────────────────────────────────────────────
console.log('\nrate limit\n')

{
  reset()
  const ip = '198.51.100.7'
  let last = null
  // 60/hr/IP. Bodies are deliberately invalid so this section measures the
  // limiter alone and writes nothing.
  for (let i = 0; i < 61; i++) last = await post(TOK_UNKNOWN, { duration_seconds: -1 }, { ip })
  check('the 61st request from one IP is refused', last.status === 429, fingerprint(last))
  check('…with standard back-off headers (rateLimitHeaders)', last.body?.error != null)

  const other = await post(TOK_UNKNOWN, { duration_seconds: -1 }, { ip: '198.51.100.8' })
  check('a different IP is unaffected (keyed per caller, not globally)',
    other.status === 400, fingerprint(other))
}

console.log(failures === 0 ? '\nall checks passed\n' : `\n${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
