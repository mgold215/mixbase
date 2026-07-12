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
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

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

// ─────────────────────────────────────────────────────────────────────────────
// 5. REAL-MODULE invariant — exercise src/lib/verifyToken.ts itself, not the
//    HS256-only mirror above. The mirror never modelled "path 4" (an alg the
//    verifier doesn't handle — e.g. {alg:'none'} — or ANY token when
//    SUPABASE_JWT_SECRET is unset), which used to return reason:'expired' with
//    verified:false for a past-exp token. The middleware trusts an 'expired'
//    token's `sub` as X-User-Id, so a forged token could impersonate a user.
//    Lock the invariant against the live code: reason ∈ {'valid','expired'} ⇒
//    verified === true. verifyToken.ts imports '@/lib/supabase' (unresolvable
//    under plain node), so load a copy with that single unused import stubbed —
//    forged/legacy tokens here never reach the JWKS branch that reads those
//    values, so the path-4 / HS256 / expiry logic runs exactly as in production.
console.log('\nReal-module (src/lib/verifyToken.ts) forged-token invariant:')
const here = dirname(fileURLToPath(import.meta.url))
const stubbed = readFileSync(join(here, '..', 'src', 'lib', 'verifyToken.ts'), 'utf8')
  .replace(
    /import \{ SUPABASE_URL, SUPABASE_ANON_KEY \} from '\.\/supabase'/,
    "const SUPABASE_URL = 'https://stub.supabase.co'; const SUPABASE_ANON_KEY = 'stub'",
  )
const tmpPath = join(here, '_verifytoken-under-test.ts')
writeFileSync(tmpPath, stubbed)
try {
  const { verifyAccessToken, makeJwtKey } = await import('./_verifytoken-under-test.ts')
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
  const past = Math.floor(Date.now() / 1000) - 3600
  const future = Math.floor(Date.now() / 1000) + 3600
  const REAL_SECRET = 'correct-secret-0123456789abcdef0'
  // Hand-forged tokens with an attacker-chosen sub and no valid signature.
  const forge = (alg, exp) =>
    `${b64({ alg, typ: 'JWT' })}.${b64({ sub: USER, exp })}.${alg === 'none' ? '' : Buffer.from('garbage-sig').toString('base64url')}`
  const forged = {
    'alg:none past-exp': forge('none', past),
    'alg:none future-exp': forge('none', future),
    'alg:HS512 past-exp': forge('HS512', past),
  }
  // The core security invariant, checked with the secret SET and UNSET (unset is
  // the fail-open state the middleware must survive without trusting forged sub).
  for (const [mode, key] of [['secret set', makeJwtKey(REAL_SECRET)], ['no secret', makeJwtKey(undefined)]]) {
    for (const [name, tok] of Object.entries(forged)) {
      const r = await verifyAccessToken(tok, key)
      const trustedUnverified = (r.reason === 'valid' || r.reason === 'expired') && r.verified === false
      check(`forged ${name} (${mode}) is NEVER labelled valid/expired`, !trustedUnverified)
    }
  }
  // Legit paths still behave — the fix must not break real sessions.
  const good = makeJwtKey(REAL_SECRET)
  const validTok = await sign(enc.encode(REAL_SECRET), '1h')
  const rv = await verifyAccessToken(validTok, good)
  check('correctly-signed token → valid + verified + sub', rv.reason === 'valid' && rv.verified === true && rv.userId === USER)
  const expTok = await sign(enc.encode(REAL_SECRET), '-1h')
  const re = await verifyAccessToken(expTok, good)
  check('correctly-signed EXPIRED token → expired + verified + sub (refreshable)', re.reason === 'expired' && re.verified === true && re.userId === USER)
} finally {
  try { unlinkSync(tmpPath) } catch {}
}

if (failures > 0) {
  console.error(`\nFAIL: ${failures} security assertion(s) failed.`)
  process.exit(1)
}
console.log('\nPASS: all JWT verification invariants hold.')
