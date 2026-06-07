#!/usr/bin/env node
// Security contract test for middleware JWT verification (src/lib/verifyToken.ts).
//
// This does NOT need any real secret. It generates its own HS256 secret, signs
// tokens with it, and asserts the exact invariants the middleware relies on:
//   1. A token signed with the correct secret VERIFIES and yields its `sub`.
//   2. A token signed with a DIFFERENT secret (forged) FAILS verification.
//   3. An expired token signed with the correct secret throws JWTExpired
//      (signature checked first) and is distinguishable from a forgery.
//   4. An "alg: none" / unsigned token does NOT verify under HS256.
//
// If jose ever changes these behaviours, this test fails loudly — which is the
// difference between "auth is enforced" and "auth silently bypassed".
//
// Run: node scripts/verify-token-test.mjs

import { SignJWT, jwtVerify, decodeJwt, errors as joseErrors } from 'jose'

const enc = new TextEncoder()
const SECRET = enc.encode('test-secret-correct-0123456789abcdef')
const WRONG = enc.encode('test-secret-attacker-fedcba9876543210')
const USER = '11111111-1111-1111-1111-111111111111'

let failures = 0
function check(name, cond) {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    console.error(`  ✗ ${name}`)
    failures++
  }
}

async function sign(secret, expiresIn) {
  return new SignJWT({ sub: USER, role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secret)
}

// Mirrors verifyAccessToken() in src/lib/verifyToken.ts. Kept in sync as the
// behavioural contract; if these jose calls drift, the middleware drifts too.
async function verify(token, key) {
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] })
    return { userId: payload.sub ?? null, expired: false, verified: true }
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      return { userId: decodeJwt(token).sub ?? null, expired: true, verified: true }
    }
    return { userId: null, expired: true, verified: false }
  }
}

console.log('JWT verification security contract:')

// 1. Valid token signed with correct secret
const valid = await sign(SECRET, '1h')
const r1 = await verify(valid, SECRET)
check('valid token verifies', r1.verified === true && r1.expired === false)
check('valid token yields correct sub', r1.userId === USER)

// 2. Forged token (signed with a different secret) must be rejected
const forged = await sign(WRONG, '1h')
const r2 = await verify(forged, SECRET)
check('forged token is REJECTED (verified=false)', r2.verified === false)
check('forged token yields NO userId (no spoofing)', r2.userId === null)

// 3. Expired-but-correctly-signed token: flagged expired, sub still readable
const expired = await sign(SECRET, '-1h')
const r3 = await verify(expired, SECRET)
check('expired+valid token is flagged expired', r3.expired === true)
check('expired+valid token keeps verified=true (signature was good)', r3.verified === true)
check('expired+valid token yields sub (for refresh)', r3.userId === USER)

// 4. Unsigned / alg:none style token must not verify under HS256
const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: USER, exp: 9999999999 })).toString('base64url')}.`
const r4 = await verify(unsigned, SECRET)
check('unsigned (alg:none) token is REJECTED', r4.verified === false && r4.userId === null)

if (failures > 0) {
  console.error(`\nFAIL: ${failures} security assertion(s) failed.`)
  process.exit(1)
}
console.log('\nPASS: all JWT verification invariants hold.')
