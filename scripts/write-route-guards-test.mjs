#!/usr/bin/env node
// Guards on two write routes, both driven as the REAL exported handlers.
//
// Run: node scripts/write-route-guards-test.mjs
//
// ── PART 1: POST /api/auth/delete-account, optional tables ───────────────────
// The account-erasure route deletes rows table by table and pushes every error
// into `dbErrors`; a non-empty dbErrors ABORTS before auth.admin.deleteUser, on
// purpose, so a half-deleted account is never left behind.
//
// That abort gate is a loaded gun for any table which may not exist in the
// environment the route is running in. mb_favorites and mb_spotify_auth arrive
// via supabase/migrations/006 and are absent from db-init's SCHEMA_SQL, so a
// freshly bootstrapped environment genuinely does not have them — and PostgREST
// answers a delete against a missing table with an error like any other. Routed
// through the plain del() helper, that error lands in dbErrors and makes the
// account UNDELETABLE. A change made to close a GDPR erasure wedge would have
// opened a new one.
//
// So delOptional() must swallow exactly one failure — "this relation is not
// here" — and nothing else. The interesting tests are therefore the NEGATIVE
// ones: a permission error naming the same table, and a missing-relation error
// naming a DIFFERENT table, must both still abort. A guard that swallows those
// silently converts a failed deletion into a reported success, which is the
// worse direction: the auth user is destroyed while PII rows keyed to that id
// linger as zombies.
//
// ── PART 1b: the cross-product pre-flight ────────────────────────────────────
// This Supabase project is shared by several products which all share ONE
// auth.users. mixMASH keys mm_mixes / mm_tracks / mm_render_jobs to auth.users
// with NO ACTION, so a user with mixMASH data cannot be deleted — and the
// failure lands on the very LAST statement of the route, after the Stripe
// subscription is cancelled, every mixBASE row is deleted and every byte is
// gone. The user loses everything and still has an account.
//
// The pre-flight asks that question FIRST and refuses without touching
// anything. These tests pin the two halves that matter: a blocker must stop the
// route before any mutation, and a mm_* table that does not exist here must NOT
// count as a blocker (a fresh environment has none of them).
//
// ── PART 2: PATCH /api/versions/[id], body shape + rate limit ────────────────
// `JSON.parse('5')` is the number 5. The old guard was `if (!body)`, which 5
// passes, and the next line does `'status' in body` — a TypeError on any
// non-object, surfacing as a 500 on a request the CLIENT got wrong. Same for
// `true` and for any JSON string. `null` was caught only by accident (it is
// falsy), and an array threw nothing but fell through to "No valid fields to
// update", blaming the caller's field names for a body that could never have
// carried a field at all.
//
// Pure — no DB, no network. Requires Node >= 22.18 for type-stripping.

import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

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
// A recording stub, not a canned response: every from()/delete()/select() is
// logged so a test can assert that a refusal really did touch nothing, and
// per-table errors are injected by key so the missing-relation branch is
// exercised through the real route rather than asserted about in text.
const USER = 'aaaaaaaa-0000-4000-8000-000000000001'

function freshDb() {
  return {
    // key: `${op}:${table}` → the error object to return, e.g. 'delete:mb_favorites'
    errors: {},
    // key: `count:${table}` → row count the pre-flight probe should report
    counts: {},
    calls: [],
    deletedUser: null,
    deleteUserError: null,
    // When set, mb_versions.single() resolves to this row — i.e. the caller owns
    // the version and the PATCH does real work instead of 404ing.
    versionRow: null,
  }
}
globalThis.__MB_DB = freshDb()
const db = () => globalThis.__MB_DB
const reset = () => { globalThis.__MB_DB = freshDb() }
const callsOf = (op) => db().calls.filter(c => c.op === op).map(c => c.table)

const SUPABASE_STUB = `
const db = () => globalThis.__MB_DB

function query(table) {
  let op = 'select'
  let head = false
  const record = () => db().calls.push({ op, table })
  const settle = () => {
    record()
    const err = db().errors[op + ':' + table] ?? null
    if (op === 'select' && head) {
      return Promise.resolve({ data: null, count: err ? null : (db().counts[table] ?? 0), error: err })
    }
    return Promise.resolve({ data: err ? null : [], error: err })
  }
  const q = {
    select(_cols, opts) { op = 'select'; if (opts && opts.head) head = true; return q },
    delete() { op = 'delete'; return q },
    update() { op = 'update'; return q },
    insert() { op = 'insert'; return q },
    eq() { return q },
    in() { return q },
    is() { return q },
    order() { return q },
    range() { return q },
    limit() { return q },
    single() {
      record()
      const row = table === 'mb_versions' ? db().versionRow : null
      return Promise.resolve({ data: row ?? null, error: null })
    },
    maybeSingle() { record(); return Promise.resolve({ data: null, error: null }) },
    then(res, rej) { return settle().then(res, rej) },
  }
  return q
}

export const supabaseAdmin = {
  from: (table) => query(table),
  auth: { admin: {
    deleteUser: async (id) => {
      db().deletedUser = id
      return { error: db().deleteUserError }
    },
    // tier.ts's isPlatformOwner() probes this on its way to deciding the
    // owner exemption. Resolving it cleanly to "no such user" keeps the
    // limiter on its normal path instead of its lookup-failed fallback.
    getUserById: async () => ({ data: { user: null }, error: null }),
  } },
}
export const SUPABASE_URL = 'https://example.supabase.co'
export const supabase = supabaseAdmin
export const audioProxyUrl = (u) => u
`

const SENTRY_STUB = `
export function captureMessage() {}
export function captureException() {}
export function init() {}
`

const STORAGE_REMOVE_STUB = `
export async function removeStorageObjects(bucket, paths) {
  return { ok: true, removed: paths, unconfirmed: [], error: null }
}
`

const STUBS = {
  'mbstub:supabase': SUPABASE_STUB,
  'mbstub:sentry': SENTRY_STUB,
  'mbstub:storage-remove': STORAGE_REMOVE_STUB,
}

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'next/server') return next('next/server.js', ctx)
    if (spec === '@sentry/nextjs') return { url: 'mbstub:sentry', shortCircuit: true, format: 'module' }
    // Both spellings — src/lib/* reaches its siblings relatively.
    if (spec === '@/lib/supabase' || spec === './supabase') {
      return { url: 'mbstub:supabase', shortCircuit: true, format: 'module' }
    }
    if (spec === '@/lib/storage-remove') {
      return { url: 'mbstub:storage-remove', shortCircuit: true, format: 'module' }
    }
    if (spec.startsWith('@/')) {
      return { url: pathToFileURL(join(root, 'src', spec.slice(2) + '.ts')).href, shortCircuit: true, format: 'module-typescript' }
    }
    // Extensionless RELATIVE specifiers. Webpack resolves them; Node's ESM
    // resolver does not, so `await import('./tier')` inside src/lib/rate-limit.ts
    // throws ERR_MODULE_NOT_FOUND under a plain-Node harness even though it is
    // perfectly correct in the app. Retry with .ts rather than let that pass for
    // a real failure.
    if (spec.startsWith('./') || spec.startsWith('../')) {
      try {
        return next(spec, ctx)
      } catch (err) {
        if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err
        return next(spec + '.ts', ctx)
      }
    }
    return next(spec, ctx)
  },
  load(url, ctx, next) {
    if (STUBS[url]) return { format: 'module', shortCircuit: true, source: STUBS[url] }
    return next(url, ctx)
  },
})

// STRIPE_SECRET_KEY unset → the route skips the subscription cancel entirely,
// so no Stripe network client is ever constructed.
delete process.env.STRIPE_SECRET_KEY

const { POST: DELETE_ACCOUNT } = await import(
  pathToFileURL(join(root, 'src/app/api/auth/delete-account/route.ts')).href)
const { PATCH } = await import(pathToFileURL(join(root, 'src/app/api/versions/[id]/route.ts')).href)
const { NextRequest } = await import('next/server.js')

async function eraseAccount(userId = USER) {
  const req = new NextRequest('http://localhost/api/auth/delete-account', {
    method: 'POST',
    headers: userId ? { 'X-User-Id': userId } : {},
  })
  const res = await DELETE_ACCOUNT(req)
  return { status: res.status, body: await res.json() }
}

const VERSION_ID = '11111111-1111-4111-8111-111111111111'

/** Drive the real PATCH handler. `raw` bypasses JSON.stringify so a bare
 *  primitive reaches the wire exactly as a client would send it. */
async function patch(body, { raw, userId = USER, id = VERSION_ID } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (userId) headers['X-User-Id'] = userId
  const req = new NextRequest(`http://localhost/api/versions/${id}`, {
    method: 'PATCH',
    headers,
    body: raw ?? JSON.stringify(body),
  })
  const res = await PATCH(req, { params: Promise.resolve({ id }) })
  return { status: res.status, body: await res.json(), headers: res.headers }
}

console.log('\nwrite-route-guards: optional tables, cross-product blockers, body shapes\n')

// ── A. delete-account: the happy path still completes ────────────────────────
console.log('A. account erasure completes when nothing is in the way')
{
  reset()
  const res = await eraseAccount()
  check('a clean erasure returns ok', res.status === 200 && res.body.ok === true,
    `status ${res.status} ${JSON.stringify(res.body)}`)
  check('the auth user is actually deleted', db().deletedUser === USER)
  const deletes = callsOf('delete')
  check('mb_favorites is swept', deletes.includes('mb_favorites'))
  check('mb_spotify_auth is swept', deletes.includes('mb_spotify_auth'))
}

// ── B. THE ONE THAT MATTERS: a missing relation must not abort ───────────────
console.log('\nB. a missing optional table does NOT abort the erasure')
for (const [label, error] of [
  ['42P01 (Postgres)', { code: '42P01', message: 'relation "public.mb_favorites" does not exist' }],
  ['PGRST205 (schema cache)', { code: 'PGRST205', message: "Could not find the table 'public.mb_favorites' in the schema cache" }],
  ['message-only, no code', { message: 'relation "public.mb_favorites" does not exist' }],
]) {
  reset()
  db().errors['delete:mb_favorites'] = error
  const res = await eraseAccount()
  check(`${label} → erasure still succeeds`, res.status === 200 && res.body.ok === true,
    `status ${res.status} ${JSON.stringify(res.body)}`)
  check(`${label} → the auth user is still deleted`, db().deletedUser === USER)
}
{
  reset()
  db().errors['delete:mb_spotify_auth'] = {
    code: 'PGRST205',
    message: "Could not find the table 'public.mb_spotify_auth' in the schema cache",
  }
  const res = await eraseAccount()
  check('the other optional table is covered too', res.status === 200 && db().deletedUser === USER,
    `status ${res.status}`)
}

// ── C. …but a REAL error on that same table still aborts ─────────────────────
// The whole value of the guard is that it is narrow. These are the cases a
// sloppy `catch (e) { /* table might not exist */ }` would swallow, turning a
// failed deletion into a reported success with the auth user destroyed and PII
// rows left keyed to a dead id.
console.log('\nC. a real failure on an optional table still aborts (the guard is narrow)')
for (const [label, error] of [
  ['permission denied', { code: '42501', message: 'permission denied for table mb_favorites' }],
  ['constraint violation', { code: '23503', message: 'update or delete on table "mb_favorites" violates foreign key constraint' }],
  ['transport failure', { message: 'fetch failed' }],
  // Names a missing relation, but NOT the one being deleted — a broken view or a
  // dropped FK target. Not this table's absence, so it must not be excused.
  ['missing relation, DIFFERENT table', { code: '42P01', message: 'relation "public.some_other_table" does not exist' }],
]) {
  reset()
  db().errors['delete:mb_favorites'] = error
  const res = await eraseAccount()
  check(`${label} → aborts with 500`, res.status === 500, `status ${res.status}`)
  check(`${label} → the auth user is NOT deleted`, db().deletedUser === null)
}

// ── D. cross-product pre-flight ──────────────────────────────────────────────
console.log('\nD. another product\'s rows block the erasure BEFORE anything is touched')
{
  reset()
  db().counts['mm_mixes'] = 3
  const res = await eraseAccount()
  check('a blocking table refuses the erasure', res.status === 409, `status ${res.status}`)
  check('the auth user is untouched', db().deletedUser === null)
  check('NOTHING was deleted — not one row, not one byte', callsOf('delete').length === 0,
    `deletes: ${JSON.stringify(callsOf('delete'))}`)
  check('the refusal says nothing was changed', /nothing was changed/i.test(res.body.error),
    res.body.error)
}
{
  reset()
  db().errors['select:mm_tracks'] = { message: 'connection reset' }
  const res = await eraseAccount()
  check('an unanswerable probe also refuses rather than half-deleting', res.status === 409,
    `status ${res.status}`)
  check('…and still touched nothing', callsOf('delete').length === 0 && db().deletedUser === null)
}
{
  // A fresh environment has the mb_* tables but none of the mm_* ones. Treating
  // that as a blocker would be a brand-new way to make an account undeletable —
  // the exact bug the pre-flight exists to prevent.
  reset()
  for (const t of ['mm_mixes', 'mm_tracks', 'mm_render_jobs']) {
    db().errors[`select:${t}`] = { code: '42P01', message: `relation "public.${t}" does not exist` }
  }
  const res = await eraseAccount()
  check('mm_* tables absent from this environment do NOT block', res.status === 200 && res.body.ok === true,
    `status ${res.status} ${JSON.stringify(res.body)}`)
  check('the erasure completed', db().deletedUser === USER)
}
{
  reset()
  for (const t of ['mm_mixes', 'mm_tracks', 'mm_render_jobs']) {
    db().errors[`select:${t}`] = {
      code: 'PGRST205',
      message: `Could not find the table 'public.${t}' in the schema cache`,
    }
  }
  const res = await eraseAccount()
  check('the schema-cache spelling is covered too', res.status === 200 && db().deletedUser === USER,
    `status ${res.status}`)
}
{
  // Order: the probe must precede the deletes, not merely coexist with them.
  reset()
  db().counts['mm_render_jobs'] = 1
  await eraseAccount()
  const probed = db().calls.findIndex(c => c.table === 'mm_render_jobs')
  check('the probe runs before any delete could have', probed > -1 && callsOf('delete').length === 0)
}

// ── E. delete-account: the route does not delete another product's rows ──────
console.log('\nE. mixBASE never writes to another product\'s tables')
{
  reset()
  await eraseAccount()
  const touched = db().calls.filter(c => c.op !== 'select').map(c => c.table)
  const foreign = touched.filter(t => t.startsWith('mm_'))
  check('no mm_* table is deleted from, updated or inserted into', foreign.length === 0,
    `mutations on: ${JSON.stringify(foreign)}`)
}

// ── F. PATCH body shapes: the 500s ───────────────────────────────────────────
console.log('\nF. a JSON body that is not an object is a 400, never a 500')
for (const [label, raw] of [
  ['a bare number (JSON.parse("5") === 5)', '5'],
  ['zero', '0'],
  ['a negative number', '-1'],
  ['a float', '1.5'],
  ['true', 'true'],
  ['false', 'false'],
  ['null (typeof null === "object"!)', 'null'],
  ['a JSON string', '"status"'],
  ['an empty string', '""'],
  ['an empty array', '[]'],
  ['a populated array', '[1,2,3]'],
  ['an array of objects', '[{"status":"WIP"}]'],
  ['unparseable bytes', '{not json'],
]) {
  let res
  try {
    res = await patch(null, { raw })
  } catch (err) {
    check(`${label} → 400`, false, `THREW ${err?.constructor?.name}: ${err?.message}`)
    continue
  }
  check(`${label} → 400 Invalid JSON body`,
    res.status === 400 && res.body.error === 'Invalid JSON body',
    `status ${res.status} ${JSON.stringify(res.body)}`)
}

// ── G. …while real object bodies keep their existing answers ─────────────────
console.log('\nG. object bodies still behave exactly as before')
{
  const res = await patch({})
  check('an empty object is still "No valid fields to update"',
    res.status === 400 && res.body.error === 'No valid fields to update',
    `status ${res.status} ${JSON.stringify(res.body)}`)
}
{
  const res = await patch({ nope: 1, another: 2 })
  check('an object of unknown keys is still "No valid fields to update"',
    res.status === 400 && res.body.error === 'No valid fields to update',
    `status ${res.status} ${JSON.stringify(res.body)}`)
}
{
  const res = await patch({ duration_seconds: 'not a number' })
  check('an unusable duration is still its own 400',
    res.status === 400 && res.body.error === 'Invalid duration_seconds',
    `status ${res.status} ${JSON.stringify(res.body)}`)
}
{
  // The fake store owns no rows, so an allowlisted edit reaches the ownership
  // read and 404s — which proves the body passed validation rather than being
  // rejected as malformed.
  const res = await patch({ status: 'APPROVED' })
  check('an allowlisted edit gets past body validation to the ownership check',
    res.status === 404, `status ${res.status} ${JSON.stringify(res.body)}`)
}
{
  const res = await patch(null, { raw: '{"status":"WIP"}', userId: null })
  check('an unauthenticated PATCH is still 401 before anything else',
    res.status === 401, `status ${res.status}`)
}
{
  const res = await patch({ status: 'WIP' }, { id: 'not-a-uuid' })
  check('a non-uuid id is still rejected', res.status === 400 && res.body.error === 'Invalid id',
    `status ${res.status}`)
}

// ── H. PATCH rate limit ──────────────────────────────────────────────────────
console.log('\nH. the PATCH route is rate limited')
{
  // The shared limiter is 60/hour per user. Spend the window on a fresh user id
  // and confirm the 61st call is refused with the standard headers.
  const heavy = 'cccccccc-0000-4000-8000-00000000000c'
  db().versionRow = { id: VERSION_ID, status: 'WIP', project_id: 'p1', version_number: 1, duration_seconds: 240 }
  let sawLimit = null
  for (let i = 0; i < 70; i++) {
    const res = await patch({ status: 'WIP' }, { userId: heavy })
    if (res.status === 429) { sawLimit = { i, res }; break }
  }
  check('a runaway client is eventually refused', sawLimit !== null,
    sawLimit ? `429 on call ${sawLimit.i + 1}` : 'never hit the limit in 70 calls')
  if (sawLimit) {
    const h = sawLimit.res.headers
    check('the 429 carries Retry-After', !!h.get('Retry-After'), h.get('Retry-After'))
    check('the 429 carries X-RateLimit-Limit', !!h.get('X-RateLimit-Limit'), h.get('X-RateLimit-Limit'))
    check('the 429 carries X-RateLimit-Remaining', h.get('X-RateLimit-Remaining') !== null)
    check('the 429 carries X-RateLimit-Reset', !!h.get('X-RateLimit-Reset'))
  }
}
{
  // A malformed body must not cost a credit — the limiter is spent only on work
  // the route was actually asked to do. A fresh id that only ever sends garbage
  // must never reach 429.
  const junk = 'dddddddd-0000-4000-8000-00000000000d'
  let refused = false
  for (let i = 0; i < 70; i++) {
    const res = await patch(null, { raw: '5', userId: junk })
    if (res.status === 429) { refused = true; break }
  }
  check('a malformed body never spends a rate-limit credit', !refused)
}
{
  // A 404 refunds — the window counts work performed, not rejected attempts.
  db().versionRow = null
  const ghost = 'eeeeeeee-0000-4000-8000-00000000000e'
  let refused = false
  for (let i = 0; i < 70; i++) {
    const res = await patch({ status: 'WIP' }, { userId: ghost })
    if (res.status === 429) { refused = true; break }
  }
  check('a 404 refunds the credit it spent', !refused)
}

// ── I. source contracts ──────────────────────────────────────────────────────
// The invariants no behavioural test can see.
console.log('\nI. source contracts')
{
  const versionsRoute = read('src/app/api/versions/[id]/route.ts')
  const allowedLine = versionsRoute.split('\n').find(l => l.includes('const allowed ='))
  check('the allowlist line was located', !!allowedLine && allowedLine.includes('status'),
    allowedLine?.trim())
  check('duration_seconds is STILL not in the passthrough allowlist',
    !!allowedLine && !allowedLine.includes('duration_seconds'), allowedLine?.trim())
  check('the limiter is the shared helper, not a route-local one',
    /from '@\/lib\/rate-limit'/.test(versionsRoute) && !/rateLimiter\(\{/.test(versionsRoute))
  check('identity for the limit key is the header, never the body',
    /checkUserLimit\(\w+,\s*userId\)/.test(versionsRoute))

  const deleteRoute = read('src/app/api/auth/delete-account/route.ts')
  check('the pre-flight lists the foreign tables by name only',
    /FOREIGN_BLOCKING_TABLES\s*=\s*\[[^\]]*mm_mixes[^\]]*mm_tracks[^\]]*mm_render_jobs[^\]]*\]/.test(deleteRoute))
  check('no delete/update/insert is ever issued against an mm_ table',
    !/from\('mm_[a-z_]*'\)\s*\.(delete|update|insert)/.test(deleteRoute))
  check('the pre-flight probes with head:true (a count, never the rows)',
    /count:\s*'exact',\s*head:\s*true/.test(deleteRoute))
  check('the missing-relation test requires the table NAME',
    /message\.includes\(table\)/.test(deleteRoute))
  check('delOptional still pushes non-missing errors into dbErrors',
    /isMissingRelation\(error, label\)[\s\S]{0,200}dbErrors\.push/.test(deleteRoute))
}

console.log(`\n${failures === 0 ? '✓ all checks passed' : `✗ ${failures} check(s) failed`}\n`)
process.exit(failures === 0 ? 0 : 1)
