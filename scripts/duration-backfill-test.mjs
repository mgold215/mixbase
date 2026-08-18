#!/usr/bin/env node
// Contract + behaviour test: the self-healing `duration_seconds` backfill.
//
// 144 of 363 production mb_versions rows have duration_seconds NULL. Nothing
// re-reads 23 GB of audio to fix that — the browser measures the true length
// every time a mix plays, and PATCH /api/versions/[id] writes that reading back
// once. This suite exists because that is a WRITE path fed by an untrusted
// client, and it has exactly three ways to do damage:
//
//   1. PERSIST A NON-FINITE READING. `HTMLMediaElement.duration` is NaN before
//      metadata parses and Infinity for a stream whose length the browser
//      cannot determine — and this app streams every mix through /api/audio,
//      which only forwards Content-Length when Supabase sends one. `Infinity`
//      is not JSON, but `1e999` IS, and JSON.parse turns it into Infinity — so
//      "you can't send Infinity over the wire" is false and section C proves it.
//      A stored non-finite value could never be corrected either, because the
//      rule below is write-once.
//   2. OVERWRITE A GOOD READING. Only a NULL may be filled. Section D covers
//      the check, and section I covers the RACE: two tabs finishing
//      'loadedmetadata' at the same instant. The read-then-write check alone is
//      TOCTOU, so the UPDATE itself must carry `.is('duration_seconds', null)`.
//   3. WRITE ACROSS ACCOUNTS. Section E has user B try to heal user A's row.
//
// Sections A–J drive the REAL exported PATCH handler. `@/lib/supabase` is
// replaced at module-resolution time with an in-memory store, so ownership,
// write-once and the atomic filter are enforced by data rather than asserted
// about text — a mutation to the route makes them fail for the right reason.
//
// Sections K–M are source contracts over the client half, which no Node test
// can execute: the guard that keeps Infinity out of the request in the first
// place, the once-per-session rule, and the fact that the write is registered
// only for rows that really are NULL. Comments are stripped first — a guard
// that survives only in a comment must not keep a check green.
//
// Run: node scripts/duration-backfill-test.mjs
// Requires Node >= 22.15 for module.registerHooks and >= 22.18 for native
// TypeScript type-stripping. CI's Renderer Tests job pins Node 22, and several
// existing suites already import .ts modules directly.

import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

import { stripComments, functionBody, bracketedBlock } from './source-contract.mjs'

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

// ── Fake Supabase ────────────────────────────────────────────────────────────
// A real in-memory store, not a canned-response stub: ownership is resolved by
// looking up the project's owner, write-once by looking at the stored value,
// and the atomic filter by actually filtering. That is what lets a mutation of
// the route change these results.
const USER_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const USER_B = 'bbbbbbbb-0000-4000-8000-000000000002'
const PROJ_A = 'aaaa1111-0000-4000-8000-00000000000a'
const PROJ_B = 'bbbb2222-0000-4000-8000-00000000000b'
const V_NULL = '11111111-1111-4111-8111-111111111111' // user A, duration NULL
const V_SET = '22222222-2222-4222-8222-222222222222'  // user A, duration 268
const V_B_NULL = '33333333-3333-4333-8333-333333333333' // user B, duration NULL
const V_ABSENT = '99999999-9999-4999-8999-999999999999'

function freshDb() {
  return {
    projectOwner: { [PROJ_A]: USER_A, [PROJ_B]: USER_B },
    mb_versions: [
      { id: V_NULL, project_id: PROJ_A, version_number: 3, status: 'WIP', label: 'Mix 3', duration_seconds: null },
      { id: V_SET, project_id: PROJ_A, version_number: 2, status: 'WIP', label: 'Mix 2', duration_seconds: 268 },
      { id: V_B_NULL, project_id: PROJ_B, version_number: 1, status: 'WIP', label: 'B mix', duration_seconds: null },
    ],
    mb_activity: [],
    // Test hook for section I: runs immediately before an UPDATE resolves its
    // filters, which is precisely the window between the route's ownership read
    // and its write.
    beforeUpdate: null,
  }
}
globalThis.__MB_DB = freshDb()
const db = () => globalThis.__MB_DB
const snapshot = () => JSON.stringify(db().mb_versions)
const rowById = (id) => db().mb_versions.find(r => r.id === id)
function reset() {
  globalThis.__MB_DB = freshDb()
}

const SUPABASE_STUB = `
const db = () => globalThis.__MB_DB

function matches(table, filters) {
  let rows = db()[table] ?? []
  for (const [op, col, val] of filters) {
    if (op === 'eq' && col === 'mb_projects.user_id') {
      rows = rows.filter(r => db().projectOwner[r.project_id] === val)
    } else if (op === 'eq') {
      rows = rows.filter(r => r[col] === val)
    } else if (op === 'is' && val === null) {
      rows = rows.filter(r => r[col] === null || r[col] === undefined)
    } else {
      throw new Error('fake supabase: unsupported filter ' + op + ' ' + col)
    }
  }
  return rows
}

function query(table) {
  const filters = []
  let op = 'select'
  let payload = null
  const run = (arity) => {
    if (op === 'insert') {
      db()[table] = (db()[table] ?? []).concat([payload])
      return Promise.resolve({ data: payload, error: null })
    }
    if (op === 'update' && db().beforeUpdate) db().beforeUpdate(table, payload, filters)
    const rows = matches(table, filters)
    if (op === 'update') for (const r of rows) Object.assign(r, payload)
    if (op === 'delete') db()[table] = db()[table].filter(r => !rows.includes(r))
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
    delete() { op = 'delete'; return q },
    eq(col, val) { filters.push(['eq', col, val]); return q },
    is(col, val) { filters.push(['is', col, val]); return q },
    limit() { return q },
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
    // next/server has no bare-subpath export map entry Node can resolve.
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

const ROUTE_PATH = 'src/app/api/versions/[id]/route.ts'
const { PATCH } = await import(pathToFileURL(join(root, ROUTE_PATH)).href)
const { NextRequest } = await import('next/server.js')

/** Drive the real handler with a real NextRequest — i.e. only values a browser
 *  can actually put on the wire. `raw` bypasses JSON.stringify so encodings
 *  like 1e999 survive intact. */
async function patch(id, body, userId, { raw } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (userId) headers['X-User-Id'] = userId
  const req = new NextRequest(`http://localhost/api/versions/${id}`, {
    method: 'PATCH',
    headers,
    body: raw ?? JSON.stringify(body),
  })
  const res = await PATCH(req, { params: Promise.resolve({ id }) })
  return { status: res.status, body: await res.json() }
}

/** Drive the handler with a duck-typed request so the body can hold values JSON
 *  cannot carry at all (NaN). The handler only ever touches headers.get() and
 *  json(), so this exercises the same code with no wire encoding in the way. */
async function patchRaw(id, parsedBody, userId) {
  const req = { headers: new Headers(userId ? { 'X-User-Id': userId } : {}), json: async () => parsedBody }
  const res = await PATCH(req, { params: Promise.resolve({ id }) })
  return { status: res.status, body: await res.json() }
}

// ── A. Anchors ───────────────────────────────────────────────────────────────
// Everything below is worthless if the handler isn't really running, so prove
// it before trusting a single rejection.
console.log('\nanchors\n')

check('the real route module exported a PATCH handler', typeof PATCH === 'function')
{
  reset()
  const res = await patch(V_NULL, { label: 'renamed' }, USER_A)
  check('an ordinary allowlisted edit still works (handler is live)',
    res.status === 200 && rowById(V_NULL).label === 'renamed', `status ${res.status}`)
}
{
  reset()
  const res = await patch(V_NULL, {}, USER_A)
  check('an empty body is still rejected', res.status === 400, `status ${res.status}`)
}

// ── B. The happy path ────────────────────────────────────────────────────────
console.log('\nbackfilling a NULL row\n')

{
  reset()
  const res = await patch(V_NULL, { duration_seconds: 261 }, USER_A)
  check('a valid reading is written to a NULL row',
    res.status === 200 && rowById(V_NULL).duration_seconds === 261,
    `status ${res.status} stored ${rowById(V_NULL).duration_seconds}`)
  check('the response reports the row was healed', res.body.backfilled === 'written', JSON.stringify(res.body))
}
{
  reset()
  await patch(V_NULL, { duration_seconds: 261.6 }, USER_A)
  check('a fractional reading is rounded (the column is integer)',
    rowById(V_NULL).duration_seconds === 262, `stored ${rowById(V_NULL).duration_seconds}`)
}
{
  reset()
  await patch(V_NULL, { duration_seconds: 12 * 60 * 60 }, USER_A)
  check('a 12-hour reading is accepted (long DJ sets are legitimate)',
    rowById(V_NULL).duration_seconds === 43200, `stored ${rowById(V_NULL).duration_seconds}`)
}
{
  reset()
  const res = await patch(V_NULL, { duration_seconds: 261 }, USER_A)
  check('a duration-only request writes nothing else',
    res.status === 200 && rowById(V_NULL).status === 'WIP' && rowById(V_NULL).label === 'Mix 3',
    JSON.stringify(rowById(V_NULL)))
}

// ── C. Every unusable reading is refused ─────────────────────────────────────
// Each case asserts BOTH the rejection and that the row is untouched — a 400
// that still wrote would otherwise pass on the status code alone.
console.log('\nadversarial readings\n')

const WIRE_REJECTS = [
  ['1e999 — JSON.parse turns this into Infinity, the real over-the-wire vector', '{"duration_seconds":1e999}'],
  ['-1e999 — parses to -Infinity', '{"duration_seconds":-1e999}'],
  ['null — what JSON.stringify makes of Infinity and NaN', '{"duration_seconds":null}'],
  ['the string "240"', '{"duration_seconds":"240"}'],
  ['the string "Infinity"', '{"duration_seconds":"Infinity"}'],
  ['zero', '{"duration_seconds":0}'],
  ['a negative reading', '{"duration_seconds":-5}'],
  ['0.4s — rounds to 0, so the bound is tested after rounding', '{"duration_seconds":0.4}'],
  ['300000 — a 5-minute mix sent in milliseconds', '{"duration_seconds":300000}'],
  ['43201 — one second past the cap', '{"duration_seconds":43201}'],
  ['a boolean', '{"duration_seconds":true}'],
  ['an object', '{"duration_seconds":{"seconds":240}}'],
  ['an array', '{"duration_seconds":[240]}'],
]
for (const [label, raw] of WIRE_REJECTS) {
  reset()
  const before = snapshot()
  const res = await patch(V_NULL, null, USER_A, { raw })
  check(`rejects ${label}`,
    res.status === 400 && snapshot() === before,
    `status ${res.status} stored ${rowById(V_NULL).duration_seconds}`)
}

for (const [label, value] of [['NaN', NaN], ['Infinity', Infinity], ['-Infinity', -Infinity]]) {
  reset()
  const before = snapshot()
  const res = await patchRaw(V_NULL, { duration_seconds: value }, USER_A)
  check(`rejects a literal ${label} reaching the handler`,
    res.status === 400 && snapshot() === before,
    `status ${res.status} stored ${rowById(V_NULL).duration_seconds}`)
}

// The property that actually matters, stated so it can fail: NOTHING the client
// can send may leave a non-integer, non-positive or non-finite value on the row.
{
  reset()
  const attempts = [
    ...WIRE_REJECTS.map(([, raw]) => raw),
    '{"duration_seconds":261}', '{"duration_seconds":0.5}', '{"duration_seconds":43200}',
  ]
  const bad = []
  for (const raw of attempts) {
    reset()
    await patch(V_NULL, null, USER_A, { raw })
    const stored = rowById(V_NULL).duration_seconds
    if (stored === null) continue
    if (!Number.isInteger(stored) || stored < 1 || stored > 43200) bad.push(`${raw} -> ${stored}`)
  }
  check('no accepted reading can leave a non-integer or out-of-range value on the row',
    bad.length === 0, bad.length ? bad.join(' | ') : `${attempts.length} attempts, all clean`)
}

// ── D. Write-once ────────────────────────────────────────────────────────────
console.log('\nwrite-once\n')

{
  reset()
  const res = await patch(V_SET, { duration_seconds: 999 }, USER_A)
  check('a row that already has a duration is NOT overwritten',
    rowById(V_SET).duration_seconds === 268, `stored ${rowById(V_SET).duration_seconds}`)
  check('the refusal is a success, not an error (the client must not retry)',
    res.status === 200 && res.body.backfilled === 'already-set', `${res.status} ${JSON.stringify(res.body)}`)
}
{
  reset()
  await patch(V_NULL, { duration_seconds: 261 }, USER_A)
  await patch(V_NULL, { duration_seconds: 1, }, USER_A)
  check('a second write against the now-filled row is refused',
    rowById(V_NULL).duration_seconds === 261, `stored ${rowById(V_NULL).duration_seconds}`)
}
{
  // A duration that cannot be written must not take an unrelated edit down with
  // it — the write-once filter has to be scoped to its own statement.
  reset()
  const res = await patch(V_SET, { duration_seconds: 999, status: 'Finished' }, USER_A)
  check('an edit sent alongside a refused duration still applies',
    res.status === 200 && rowById(V_SET).status === 'Finished' && rowById(V_SET).duration_seconds === 268,
    `status ${rowById(V_SET).status} duration ${rowById(V_SET).duration_seconds}`)
}

// ── E. Cross-account ─────────────────────────────────────────────────────────
console.log('\nownership\n')

{
  reset()
  const before = snapshot()
  const res = await patch(V_NULL, { duration_seconds: 261 }, USER_B)
  check('user B cannot backfill user A\'s version',
    res.status === 404 && snapshot() === before,
    `status ${res.status} stored ${rowById(V_NULL).duration_seconds}`)
}
{
  reset()
  const res = await patch(V_B_NULL, { duration_seconds: 190 }, USER_B)
  check('…but user B can still backfill their OWN version (the 404 is ownership, not a dead path)',
    res.status === 200 && rowById(V_B_NULL).duration_seconds === 190,
    `status ${res.status} stored ${rowById(V_B_NULL).duration_seconds}`)
}
{
  reset()
  const before = snapshot()
  const res = await patch(V_NULL, { duration_seconds: 261 }, null)
  check('an unauthenticated backfill is refused',
    res.status === 401 && snapshot() === before, `status ${res.status}`)
}
// The gap between the two checks either side of this one. Above: no header and
// no body id. Below: a body id, but a real header alongside it. NEITHER covers
// the case the project rule actually names — header ABSENT while the body
// carries an id — and that is the only shape in which a body-derived identity
// can promote an anonymous caller instead of merely losing to a real header.
// Found by mutation: `headers.get('X-User-Id') ?? (await request.clone().json()).userId`
// survived the whole suite. The source contract at the bottom of this file
// missed it too, because it bans the literal text `body.userId` and that
// formulation never spells it. Behaviour is checked here so any spelling fails.
// Both key styles, since the route's own body uses snake_case and JS callers
// reach for camelCase.
for (const key of ['user_id', 'userId']) {
  reset()
  const before = snapshot()
  const res = await patch(V_NULL, { duration_seconds: 261, [key]: USER_A }, null)
  check(`an anonymous caller cannot authenticate via a body '${key}'`,
    res.status === 401 && snapshot() === before, `status ${res.status}`)
}
{
  reset()
  const before = snapshot()
  const res = await patchRaw(V_NULL, { duration_seconds: 261, user_id: USER_A }, USER_B)
  check('a user id in the BODY cannot stand in for the header',
    res.status === 404 && snapshot() === before, `status ${res.status}`)
}
{
  reset()
  const res = await patch(V_ABSENT, { duration_seconds: 261 }, USER_A)
  check('a version that does not exist is a 404', res.status === 404, `status ${res.status}`)
}
{
  reset()
  const res = await patch('not-a-uuid', { duration_seconds: 261 }, USER_A)
  check('a non-uuid id is rejected before any query', res.status === 400, `status ${res.status}`)
}

// ── F. The existing allowlist is unchanged ───────────────────────────────────
console.log('\nthe allowlist did not widen\n')

{
  reset()
  const res = await patch(V_NULL, { status: 'Finished' }, USER_A)
  check('a status change still updates the row and logs activity',
    res.status === 200 && rowById(V_NULL).status === 'Finished' && db().mb_activity.length === 1,
    `${rowById(V_NULL).status}, ${db().mb_activity.length} activity rows`)
}
{
  reset()
  const before = rowById(V_NULL).version_number
  await patch(V_NULL, { duration_seconds: 261, version_number: 99, user_id: USER_B, audio_url: 'http://evil' }, USER_A)
  const row = rowById(V_NULL)
  check('unknown keys riding along with a duration are still ignored',
    row.version_number === before && row.user_id === undefined && row.audio_url === undefined,
    JSON.stringify(row))
}

// ── G. Atomicity of write-once ───────────────────────────────────────────────
// The read-then-decide check in the handler is TOCTOU on its own: two tabs can
// both read NULL. The UPDATE has to carry the filter as well. This simulates the
// loser of that race by filling the row in the window between the two.
console.log('\nthe race between two tabs\n')

{
  reset()
  db().beforeUpdate = () => { rowById(V_NULL).duration_seconds = 777 }
  const res = await patch(V_NULL, { duration_seconds: 261 }, USER_A)
  db().beforeUpdate = null
  check('a write that loses the race does not clobber the winner',
    rowById(V_NULL).duration_seconds === 777, `stored ${rowById(V_NULL).duration_seconds}`)
  check('the loser is told the row was already set',
    res.status === 200 && res.body.backfilled === 'already-set', `${res.status} ${JSON.stringify(res.body)}`)
}

// ── H. Route source contract ─────────────────────────────────────────────────
console.log('\nroute source\n')

const routeSrc = stripComments(read(ROUTE_PATH))
// Sliced between two top-level declarations rather than with functionBody: the
// first `{` after the PATCH signature belongs to the `{ params: … }` parameter
// type, so the bracket matcher would return the type literal, not the body —
// and every "does NOT contain" check below would go vacuously green.
const patchBody = (() => {
  const from = routeSrc.indexOf('export async function PATCH(')
  const to = routeSrc.indexOf('export async function DELETE(')
  return from > -1 && to > from ? routeSrc.slice(from, to) : ''
})()
check('the PATCH body was located', patchBody.length > 0 && patchBody.includes('X-User-Id'), `${patchBody.length} chars`)
{
  const allowedLine = routeSrc.split('\n').find(l => l.includes('const allowed = [')) ?? ''
  check('the allowlist line was located', allowedLine.includes('status'), allowedLine.trim())
  check('duration_seconds is NOT in the passthrough allowlist',
    !allowedLine.includes('duration_seconds'), allowedLine.trim())
}
check('identity is read from the X-User-Id header only',
  /headers\.get\('X-User-Id'\)/.test(patchBody) && !/body\.(user_?[iI]d)/.test(patchBody))

// The two value guards are mutually redundant for most inputs, so no behavioural
// case above can pin either one ALONE — deleting the typeof test changes no
// result while Number.isFinite stands, and vice versa. They are still a pair
// worth keeping: the one regression that would actually happen here is somebody
// "simplifying" Number.isFinite to the bare global isFinite, which COERCES
// ("240" and true both pass it) and would be caught only by the typeof test.
// These two checks are what make each half falsifiable on its own.
{
  const validator = functionBody(routeSrc, 'function parseBackfillSeconds(')
  check('the validator was located', validator.includes('return null'), `${validator.length} chars`)
  check('it refuses anything that is not already a number', /typeof raw !== 'number'/.test(validator))
  check('its finite test is Number.isFinite, never the coercing global isFinite',
    /!Number\.isFinite\(raw\)/.test(validator) && !/[^.\w]isFinite\(raw\)/.test(validator))
}
check('the guarded update filters on a NULL duration',
  /\.is\('duration_seconds',\s*null\)/.test(patchBody))
{
  const iOwn = patchBody.indexOf("eq('mb_projects.user_id'")
  const iWrite = patchBody.indexOf(".is('duration_seconds'")
  check('ownership is proven BEFORE the backfill write', iOwn > -1 && iWrite > -1 && iOwn < iWrite,
    `own@${iOwn} write@${iWrite}`)
}

// ── I. PlayerContext: the client-side guard ──────────────────────────────────
// Sections A–H cannot see the browser half, and the browser half is where the
// Infinity comes from. These are source contracts over the real component.
console.log('\nclient: PlayerContext\n')

const PLAYER_PATH = 'src/contexts/PlayerContext.tsx'
const playerSrc = stripComments(read(PLAYER_PATH))
const backfillFn = functionBody(playerSrc, 'const attemptDurationBackfill = useCallback(')
const registerFn = functionBody(playerSrc, 'const registerUnmeasuredVersions = useCallback((entries: UnmeasuredVersion[]) =>')
const syncFn = functionBody(playerSrc, 'const syncDuration = () =>')

check('the backfill function was located', backfillFn.includes('fetch('), `${backfillFn.length} chars`)
check('the register function was located', registerFn.includes('durationTargetsRef'), `${registerFn.length} chars`)
check('the duration-sync handler was located', syncFn.includes('setDuration'), `${syncFn.length} chars`)

{
  const iFinite = backfillFn.indexOf('Number.isFinite')
  const iFetch = backfillFn.indexOf('fetch(')
  check('a finiteness test runs BEFORE the request is sent',
    iFinite > -1 && iFinite < iFetch, `isFinite@${iFinite} fetch@${iFetch}`)
}
check('non-positive readings are refused client-side too', /seconds\s*<=\s*0/.test(backfillFn))
{
  const iMark = backfillFn.indexOf('durationAttemptedRef.current.add(')
  const iFetch = backfillFn.indexOf('fetch(')
  check('the version is marked attempted BEFORE the request (no double-send)',
    iMark > -1 && iMark < iFetch, `add@${iMark} fetch@${iFetch}`)
}
check('a version already attempted this session is skipped',
  /durationAttemptedRef\.current\.has\(/.test(backfillFn))
check('the request is never awaited (playback is never delayed)',
  !/await\s+fetch\(/.test(backfillFn))
check('a failed request is swallowed, never surfaced', /\.catch\(/.test(backfillFn))
check('the request body carries the duration and nothing else',
  /JSON\.stringify\(\{\s*duration_seconds:/.test(backfillFn) && !/user_?[iI]d/.test(backfillFn))
check('the reading is rounded before it is sent', /Math\.round\(seconds\)/.test(backfillFn))
check('the measurement is read off the element, not from React state',
  /const seconds = audio\.duration/.test(backfillFn))
check('the loaded source is identified by the element\'s own currentSrc',
  /audio\.currentSrc/.test(backfillFn))

check('the sync handler drives the backfill', /attemptDurationBackfill\(audio\)/.test(syncFn))
check('Infinity never reaches the duration state either',
  /Number\.isFinite\(d\)/.test(syncFn) && !/isNaN\(/.test(syncFn))
check('durationchange is wired to that same handler',
  /addEventListener\('durationchange',\s*syncDuration\)/.test(playerSrc))
check('loadedmetadata reaches it too',
  /addEventListener\('loadedmetadata',\s*onLoadedMeta\)/.test(playerSrc) &&
  /syncDuration\(\)/.test(functionBody(playerSrc, 'const onLoadedMeta = () =>')))
check('registerUnmeasuredVersions is exposed on the context value',
  /^\s*registerUnmeasuredVersions,$/m.test(playerSrc))
check('registration also heals a mix that is already loaded',
  /attemptDurationBackfill\(audio\)/.test(registerFn))

// ── J. ProjectClient: who gets registered ────────────────────────────────────
console.log('\nclient: ProjectClient\n')

const PROJECT_PATH = 'src/app/projects/[id]/ProjectClient.tsx'
const projectSrc = stripComments(read(PROJECT_PATH))
// The whole effect, not just the `.map()` object literal that follows the
// `const unmeasured` line — that literal is what a naive bracket match returns.
const registerEffect = bracketedBlock(projectSrc, 'useEffect(() =>')
const hookLine = projectSrc.split('\n').find(l => l.includes('= usePlayer()')) ?? ''

check('the registration effect was located',
  registerEffect.includes('registerUnmeasuredVersions'), `${registerEffect.length} chars`)
check('only rows whose stored duration is NULL are registered',
  /duration_seconds\s*==\s*null/.test(registerEffect))
check('the registered URL is the audio PROXY url (a raw URL reports no duration)',
  /audioProxyUrl\(v\.audio_url\)/.test(registerEffect))
check('the version id sent is the row id', /versionId:\s*v\.id/.test(registerEffect))
check('the page takes registerUnmeasuredVersions from the shared engine',
  hookLine.includes('registerUnmeasuredVersions'), hookLine.trim().slice(0, 120))
// Guarding the neighbouring suite's invariant: this destructure must still not
// reach for the Web Audio chain, whose failure mode is silence app-wide.
check('the destructure still refuses ensureAudioChain / setEQGains',
  !hookLine.includes('ensureAudioChain') && !hookLine.includes('setEQGains'))

console.log(`\n${failures === 0 ? '✓ all checks passed' : `✗ ${failures} check(s) failed`}\n`)
process.exit(failures === 0 ? 0 : 1)
