#!/usr/bin/env node
// Contract test: the native iOS/macOS apps are SUBSCRIPTION-BLIND.
//
// App Review (Guideline 2.1(b) information request, 2026-09-10) asked whether
// a subscription bought on mixbase.app can be used in the app. The answer we
// gave — and must stay true — is NO: a request that arrives from a native app
// gets the same entitlement set for every account (NATIVE_APP_LIMITS, the free
// allowance), never the profile's web subscription tier. Honoring a web
// subscription in-app without selling it via In-App Purchase is a Guideline
// 3.1.1 / 3.1.3(b) rejection, which cost submissions #6 and #7.
//
// The signal is the middleware's X-Auth-Scheme stamp: native apps authenticate
// with a Bearer token and never hold the session cookie. This suite pins the
// whole chain — inbound header stripped, stamp set on every identity path,
// tier.ts keyed on it, and every tier-aware route passing it through.
//
// Pure source-contract test — no DB / network.
// Run: node scripts/native-client-entitlements-test.mjs (also part of `npm test`)

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { stripComments } from './source-contract.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => stripComments(readFileSync(join(root, p), 'utf8'))

let failures = 0
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

console.log('native-client-entitlements: native apps never honor a web subscription\n')

// ── 1. Middleware: the stamp cannot be spoofed and rides every identity path ─
const proxy = read('src/proxy.ts')
check('proxy strips an inbound x-auth-scheme before anything is trusted',
  /baseHeaders\.delete\('x-auth-scheme'\)/.test(proxy))
check('proxy strips it in the same place it strips x-user-id',
  proxy.indexOf("baseHeaders.delete('x-auth-scheme')") - proxy.indexOf("baseHeaders.delete('x-user-id')") < 400)

const identityStamps = (proxy.match(/requestHeaders\.set\('X-User-Id'/g) || []).length
const schemeStamps = (proxy.match(/requestHeaders\.set\('X-Auth-Scheme', authScheme\)/g) || []).length
check('every X-User-Id stamp is paired with an X-Auth-Scheme stamp',
  identityStamps > 0 && identityStamps === schemeStamps, `${schemeStamps}/${identityStamps}`)

check('bearer is only claimed when there is NO session cookie',
  /authScheme[^\n]*=\s*!cookieToken\s*&&\s*bearerToken\s*\?\s*'bearer'\s*:\s*'cookie'/.test(proxy))

// ── 2. tier.ts: native entitlements are the free allowance, tier never read ──
const tier = read('src/lib/tier.ts')
check('NATIVE_APP_LIMITS is exactly the free allowance',
  /export const NATIVE_APP_LIMITS = TIER_LIMITS\.free\b/.test(tier))
check('clientKind maps the bearer stamp to native and nothing else',
  /export function clientKind\(headers: Headers\): ClientKind \{\s*return headers\.get\('x-auth-scheme'\) === 'bearer' \? 'native' : 'web'\s*\}/.test(tier))

// The signature itself contains braces (`{ client?: ClientKind } = {}` and the
// Promise<{…}> return type), so slice the function by its neighbours instead
// of by first-brace matching.
const gate = tier.slice(
  tier.indexOf('export async function checkAndIncrementUsage'),
  tier.indexOf('async function legacyCheckAndIncrement'),
)
check('checkAndIncrementUsage body was located', gate.length > 200 && /try_increment_usage/.test(gate))
check('gate accepts the client kind', /opts: \{ client\?: ClientKind \}/.test(gate))
check('native requests use NATIVE_APP_LIMITS',
  /native \? NATIVE_APP_LIMITS : TIER_LIMITS\[tier\]/.test(gate))
check('native requests never read the profile tier',
  /native \? 'free' : \(await getUserProfile\(userId\)\)\.subscription_tier/.test(gate))

// ── 3. Every tier-aware route passes the client kind through ─────────────────
for (const [route, feature] of [
  ['src/app/api/generate-artwork/route.ts', 'artwork'],
  ['src/app/api/visualizer/runway/route.ts', 'video'],
]) {
  const src = read(route)
  check(`${route} imports clientKind`, /import \{[^}]*\bclientKind\b[^}]*\} from '@\/lib\/tier'/.test(src))
  check(`${route} gates with the request's client kind`,
    new RegExp(`checkAndIncrementUsage\\(userId, '${feature}', \\{ client: clientKind\\((?:req|request)\\.headers\\) \\}\\)`).test(src))
  check(`${route} has no client-blind gate call left`,
    !new RegExp(`checkAndIncrementUsage\\(userId, '${feature}'\\)`).test(src))
}

// ── 4. /api/subscription never reveals a web subscription to a native app ────
const sub = read('src/app/api/subscription/route.ts')
const nativeBranch = sub.slice(sub.indexOf("clientKind(request.headers) === 'native'"), sub.indexOf('const [profile, usage]'))
check('subscription route branches on the client kind before reading the profile', nativeBranch.length > 50)
check('native branch answers with NATIVE_APP_LIMITS', /limits: NATIVE_APP_LIMITS/.test(nativeBranch))
check('native branch reports no subscription', /hasStripeSubscription: false/.test(nativeBranch) && /source: null/.test(nativeBranch))
check('native branch never touches getUserProfile', !/getUserProfile/.test(nativeBranch))

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed')
process.exit(failures ? 1 : 0)
