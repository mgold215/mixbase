#!/usr/bin/env node
// Contract test for the shared transient-vs-definitive auth-error classifier
// (src/lib/auth-errors.ts). Three code paths depend on this EXACT boundary — the
// middleware (fail open), the refresh route (503 + keep cookies), and the
// forgot-password page (show "try again", not a false "email sent"). If the
// classification drifts — e.g. someone reverts to a `>= 500`-only check and drops
// status 0 (network) and 429 (rate limit) — users get logged out on transient
// Supabase blips again, the exact regression the auth fixes closed. This asserts
// the boundary so a future change can't silently reintroduce it.
//
// Runs on Node 22 native TS type-stripping, same as the other renderer tests.
// Run: node scripts/auth-errors-test.mjs  (also part of `npm run test:renderers`)

import { isTransientAuthError } from '../src/lib/auth-errors.ts'

let failures = 0
function check(name, cond) {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    console.error(`  ✗ ${name}`)
    failures++
  }
}

console.log('auth-errors: transient-vs-definitive classification')

// ── Transient: the session is NOT dead — retry / keep the user in ─────────────
check('network failure (status 0) is transient', isTransientAuthError({ status: 0 }) === true)
check('rate limit (429) is transient', isTransientAuthError({ status: 429 }) === true)
check('500 is transient', isTransientAuthError({ status: 500 }) === true)
check('502 is transient', isTransientAuthError({ status: 502 }) === true)
check('503 is transient', isTransientAuthError({ status: 503 }) === true)
check('504 is transient', isTransientAuthError({ status: 504 }) === true)
check('error object with no status is transient (fail-safe)', isTransientAuthError({}) === true)

// ── Definitive: token revoked/expired/invalid or bad request — END the session ─
check('400 is definitive', isTransientAuthError({ status: 400 }) === false)
check('401 is definitive', isTransientAuthError({ status: 401 }) === false)
check('403 is definitive', isTransientAuthError({ status: 403 }) === false)
check('404 is definitive', isTransientAuthError({ status: 404 }) === false)
check('422 is definitive', isTransientAuthError({ status: 422 }) === false)

// ── 5xx boundary — 499 is the last definitive status, 500 the first transient ──
check('499 (just below 5xx) is definitive', isTransientAuthError({ status: 499 }) === false)
check('500 (5xx boundary) is transient', isTransientAuthError({ status: 500 }) === true)

// ── Absent error: not "transient" — callers treat null/undefined as success or
//    handle it explicitly (the middleware only calls this on a real error). ─────
check('null is not transient', isTransientAuthError(null) === false)
check('undefined is not transient', isTransientAuthError(undefined) === false)

if (failures) {
  console.error(`\nauth-errors: ${failures} assertion(s) FAILED`)
  process.exit(1)
}
console.log('\nauth-errors: all assertions passed')
