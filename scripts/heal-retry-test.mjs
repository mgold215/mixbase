#!/usr/bin/env node
// Contract test: a schema heal must retry the failures that never reached a
// decision, and must never throw.
//
// WHY THIS EXISTS — a real production incident, not a hypothetical.
//
// On 2026-08-04T20:51:52Z, six seconds after `app_start_time`, four heals
// failed in one burst on production (Sentry MIXBASE-5, MIXBASE-7, MIXBASE-8;
// release ab70bae). The response body was not a Postgres error — it was
// Cloudflare's `supabase.com | 502: Bad gateway` HTML page. The Management API
// had blipped mid-deploy.
//
// The retry classifier at the time matched on the response BODY only, hunting
// for Postgres catalog-race text. An HTML gateway page contains none of it, so
// every one of those heals was tagged `transient:false`, none of them retried,
// and each was charged against its per-label failure budget. The single most
// likely way for the Management API to fail during a deploy was the one class
// the retry could not see.
//
// Two further holes were in the same function and are locked here too:
//   * `fetch` had no deadline. Node's undici applies no response timeout of its
//     own, so a server that accepts the socket and goes quiet leaves the heal
//     promise pending for the life of the process.
//   * `fetch` had no try/catch, so a network-level throw escaped runQuery
//     entirely. Every memoized heal guards itself with `.catch(() => false)`,
//     but `upsertProfileViaManagementSql` returns runQuery bare into
//     `PATCH /api/auth/me`, which awaits it unguarded — the fallback that
//     exists to save a user's profile could itself 500 the save.
//
// The classifier is a real import (src/lib/heal-retry.ts is dependency-free);
// the wiring in schema-heal.ts is asserted on source text, because that module
// imports the `@/` alias and cannot be loaded under Node type-stripping.
// Run: node scripts/heal-retry-test.mjs  (also part of `npm run test:renderers`)

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  isTransientCatalogRace,
  isTransientStatus,
  isRetryableHealFailure,
} from '../src/lib/heal-retry.ts'

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

console.log('heal-retry: the Management API failures that self-recover must retry\n')

// ── 0. The actual production payload ────────────────────────────────────────
// Verbatim prefix of the body Supabase returned in the 2026-08-04 incident, as
// captured in the Sentry event's `extra.detail`. Using the real artifact rather
// than a hand-written stub is the whole point: it is what the old classifier
// was handed and silently misread.
const REAL_502_BODY =
  '<!DOCTYPE html>\n<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->\n' +
  '<!--[if IE 7]>    <html class="no-js ie7 oldie" lang="en-US"> <![endif]-->\n' +
  '<!--[if IE 8]>    <html class="no-js ie8 oldie" lang="en-US"> <![endif]-->\n' +
  '<!--[if gt IE 8]><!--> <html class="no-js" lang="en-US"> <!--<![endif]-->\n<head>\n\n' +
  '<title>supabase.com | 502: Bad gateway</title>\n<meta charset="UTF-8" />'

console.log('1. the incident payload')

// FAIL-FIRST WITNESS, RUN not assumed: this is exactly what the pre-fix
// classifier computed for the real body. If this ever goes false, the body
// alone became sufficient and the status check below stopped being the thing
// carrying the fix.
check(
  'body-text classification alone does NOT recognise the real 502 (the bug)',
  isTransientCatalogRace(REAL_502_BODY) === false,
  'Cloudflare HTML contains no Postgres catalog-race text',
)
check(
  'the real 502 IS retryable once status is considered',
  isRetryableHealFailure({ kind: 'status', status: 502, detail: REAL_502_BODY }) === true,
)

console.log('\n2. status classification')
for (const status of [408, 429, 502, 503, 504]) {
  check(`${status} is transient`, isTransientStatus(status) === true)
}
// These must NOT retry. 400 = our own bad SQL, and 401/403 = a dead credential
// that never self-recovers; re-sending either just doubles load on an API we
// reach from a public endpoint.
for (const status of [400, 401, 403, 404, 409, 422, 500]) {
  check(`${status} is NOT transient`, isTransientStatus(status) === false)
}
check(
  '500 is excluded deliberately',
  isRetryableHealFailure({ kind: 'status', status: 500, detail: 'boom' }) === false,
  'Management API answers bad SQL with 400, so a 500 may be deterministic',
)

console.log('\n3. the catalog race still retries (no regression on MIXBASE-6)')
for (const detail of [
  'ERROR: tuple concurrently updated',
  'deadlock detected',
  'could not serialize access due to concurrent update',
]) {
  check(
    `retries: ${detail.slice(0, 40)}`,
    isRetryableHealFailure({ kind: 'status', status: 400, detail }) === true,
    'a 400 whose body is a catalog race',
  )
}
check(
  'an ordinary 400 does not retry',
  isRetryableHealFailure({ kind: 'status', status: 400, detail: 'syntax error at or near "slect"' }) === false,
)

console.log('\n4. failures with no HTTP status at all')
check(
  'a network/deadline failure is retryable',
  isRetryableHealFailure({ kind: 'network' }) === true,
  'DNS, reset, or AbortSignal — nothing reached Postgres',
)

// ── 5. The wiring in schema-heal.ts ─────────────────────────────────────────
console.log('\n5. runQuery actually uses it, bounds the request, and cannot throw')
const heal = read('src/lib/schema-heal.ts')

const fnStart = heal.indexOf('async function runQuery(')
check('runQuery exists', fnStart > -1)
const runQuerySrc = fnStart > -1 ? heal.slice(fnStart, fnStart + 3200) : ''

check(
  'runQuery classifies via the shared module, not a local regex',
  /isRetryableHealFailure\(/.test(runQuerySrc),
)
check(
  'schema-heal imports heal-retry with an explicit .ts extension',
  /from '\.\/heal-retry\.ts'/.test(heal),
  'extensionless relative imports block Node type-stripping',
)
check(
  'the classifier no longer lives in schema-heal',
  !/function isTransientCatalogRace/.test(heal),
  'one definition, and it is the tested one',
)
check(
  'the fetch carries an AbortSignal deadline',
  /signal:\s*AbortSignal\.timeout\(/.test(runQuerySrc),
)
check(
  'the fetch is wrapped in try/catch',
  /try\s*\{[\s\S]*await fetch\(/.test(runQuerySrc) && /\}\s*catch\s*\(/.test(runQuerySrc),
)
check(
  'a caught failure is classified as network, not swallowed as success',
  /failure = \{ kind: 'network' \}/.test(runQuerySrc),
)
check(
  'the retry waits before re-sending',
  /RUN_QUERY_RETRY_DELAY_MS/.test(runQuerySrc),
  'an instant re-send into the same 502 spends the attempt for nothing',
)
check(
  'the retry is still capped at one',
  /for \(let attempt = 0; attempt < 2; attempt\+\+\)/.test(runQuerySrc),
  '/api/health is public — this must not become an amplifier',
)
check(
  'the per-label failure budget is still charged',
  /runQueryFailures\.set\(label/.test(runQuerySrc),
)
check(
  'a bad credential is still escalated to Sentry at error level',
  /status === 401 \|\| status === 403 \? 'error' : 'warning'/.test(runQuerySrc),
)

// The no-throw contract is what makes the deadline safe. Prove the one call
// site that depends on it is still shaped the way that assumption requires.
console.log('\n6. the unguarded call site the no-throw contract protects')
const me = read('src/app/api/auth/me/route.ts')
check(
  'auth/me still awaits upsertProfileViaManagementSql without its own try/catch',
  /await upsertProfileViaManagementSql\(/.test(me),
  'so runQuery must never reject — if this ever gains a guard, say so here',
)
check(
  'upsertProfileViaManagementSql still returns runQuery directly',
  /return runQuery\(sql, 'profiles upsert fallback'\)/.test(heal),
)

console.log('')
if (failures > 0) {
  console.error(`❌ heal-retry: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ heal-retry: all checks passed')
