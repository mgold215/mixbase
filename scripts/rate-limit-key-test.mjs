#!/usr/bin/env node
// Contract test: the IP rate-limit key must be the one the edge sets, and must
// never collapse distinct callers into a shared bucket.
//
// WHY THIS EXISTS — `ipKey` is the entire defence for the three limiters that
// protect UNAUTHENTICATED surface: login (10/15min), signup (5/hr) and public
// feedback (20/hr). Every other limiter is keyed by authenticated user. It had
// zero test coverage.
//
// TWO DEFECTS, both fixed on 2026-08-05:
//
// 1. WRONG HEADER. It read `x-forwarded-for` and took `split(',')[0]` — the
//    LEFTMOST entry, which is the attacker-controlled end when a proxy appends.
//    This repo carried "leftmost or rightmost?" as an unresolved question for
//    four runs because answering it empirically means firing spoofed headers at
//    live infrastructure. It is answerable from Railway's own docs instead:
//    https://docs.railway.com/networking/public-networking/specs-and-limits
//    enumerates the headers the edge provides and names `X-Real-IP` as the
//    client-IP header, while `X-Forwarded-For` is not listed at all. X-Real-IP
//    is single-valued, so the leftmost/rightmost question dissolves entirely.
//
// 2. SHARED FALLBACK BUCKET — a self-inflicted DoS. The fallback was the
//    literal string 'unknown', so every request the edge did not stamp landed
//    in ONE bucket. A single header-less client could exhaust the global
//    10-per-15-minutes login budget and lock every real user out of signing in.
//    The rate limiter would have caused the outage it exists to prevent.
//
// Pure unit test — no network, no DB. Run: node scripts/rate-limit-key-test.mjs
// (also part of `npm run test:renderers`)

import { ipKey } from '../src/lib/rate-limit.ts'

let failures = 0
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

// Minimal stand-in for the Headers shape ipKey consumes.
const req = (headers) => ({ headers: { get: (n) => headers[n] ?? null } })

console.log('rate-limit-key: the key must be edge-set and never shared\n')

console.log('1. Railway\'s documented header wins')
check('X-Real-IP is used when present',
  ipKey(req({ 'x-real-ip': '203.0.113.7' })) === '203.0.113.7')
check('X-Real-IP takes precedence over X-Forwarded-For',
  ipKey(req({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' })) === '203.0.113.7',
  'XFF is only a fallback')
check('surrounding whitespace is trimmed',
  ipKey(req({ 'x-real-ip': '  203.0.113.7  ' })) === '203.0.113.7')

console.log('\n2. XFF fallback takes the entry CLOSEST TO THE EDGE (last), not the client end')
check('a 3-hop chain keys on the last entry',
  ipKey(req({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3' })) === '3.3.3.3')
// THE SPOOFING WITNESS. A client that prepends a forged entry must not change
// the key it is limited by — that is the whole point of taking the last hop.
const honest = ipKey(req({ 'x-forwarded-for': '198.51.100.9' }))
const spoofed = ipKey(req({ 'x-forwarded-for': 'evil-spoof, 198.51.100.9' }))
check('a prepended forged entry does NOT change the key',
  honest === spoofed && honest === '198.51.100.9',
  'prepending is the cheap attack; appending requires being the proxy')
// And prove the OLD behaviour would have failed this exact case, so the check
// is discriminating rather than decorative.
const legacyKey = (h) => h.split(',')[0].trim()
check('WITNESS: the pre-fix leftmost rule DID let the spoof through',
  legacyKey('evil-spoof, 198.51.100.9') !== legacyKey('198.51.100.9'))

console.log('\n3. no shared bucket, ever')
const a = ipKey(req({}))
const b = ipKey(req({}))
check('two unidentifiable requests get DIFFERENT keys',
  a !== b,
  'a shared constant here would let one client lock out every user')
check('the unkeyed key is namespaced so it can never collide with a real IP',
  a.startsWith('unkeyed:') && b.startsWith('unkeyed:'))
// WITNESS: run the pre-fix implementation and show it collapses two distinct
// header-less callers onto one key — the shared bucket that made the limiter
// a self-DoS. Asserting a literal against itself would prove nothing.
const legacyIpKey = (r) => {
  const forwarded = r.headers.get('x-forwarded-for')
  return (forwarded?.split(',')[0]?.trim()) ?? 'unknown'
}
check('WITNESS: the pre-fix fallback put every header-less caller in ONE bucket',
  legacyIpKey(req({})) === legacyIpKey(req({})) && legacyIpKey(req({})) === 'unknown')

console.log('\n4. empty / malformed headers fall through rather than becoming a key')
for (const [label, headers] of [
  ['empty X-Real-IP', { 'x-real-ip': '' }],
  ['whitespace X-Real-IP', { 'x-real-ip': '   ' }],
  ['empty XFF', { 'x-forwarded-for': '' }],
  ['XFF with a trailing comma', { 'x-forwarded-for': '1.1.1.1,' }],
]) {
  check(`${label} does not produce a shared/blank key`,
    ipKey(req(headers)).startsWith('unkeyed:'))
}
// An empty X-Real-IP must still let a good XFF through rather than short-circuit.
check('an empty X-Real-IP falls back to XFF instead of giving up',
  ipKey(req({ 'x-real-ip': '', 'x-forwarded-for': '2.2.2.2' })) === '2.2.2.2')

console.log('')
if (failures > 0) {
  console.error(`❌ rate-limit-key: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ rate-limit-key: all checks passed')
