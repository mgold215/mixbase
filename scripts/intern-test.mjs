#!/usr/bin/env node
// The mixing intern (owner-only): the Mac app reports what it can read of
// Logic Pro. Source checks only: no database, no network, no Mac.
//
// Run: node scripts/intern-test.mjs  (part of `npm test`)
import { readFileSync } from 'node:fs'

const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

console.log('intern: the Mac app\'s report\n')
const route = read('src/app/api/intern/diagnostics/route.ts')
const proxy = read('src/proxy.ts')
const auth = read('ios/mixBase/Services/AuthService.swift')
const api = read('ios/mixBase/Services/MixbaseAPI.swift')
const mac = read('macos/MixbaseApp/InternDiagnostics.swift')

check('the route takes the caller from the middleware header and 404s anyone but the owner',
  /request\.headers\.get\('X-User-Id'\)/.test(route) && /if \(!\(await isAdminIdentity\(userId\)\)\) return NextResponse\.json\(\{ error: 'Not found' \}, \{ status: 404 \}\)/.test(route))
check('…before it reads the body', route.indexOf('isAdminIdentity(userId)') < route.indexOf('request.json()'))
check('the route is rate limited and caps what it stores', /checkUserLimit\(mixCheckLimiter, userId\)/.test(route) && /\.slice\(0, MAX_REPORT\)/.test(route))
check('nothing under /api/intern is public', !/['"]\/api\/intern/.test(proxy))
check('only the Mac build starts it, and only for the owner',
  /#if os\(macOS\)[\s\S]{0,260}if self\.ownerTools \{ InternDiagnostics\.start\(\) \}[\s\S]{0,40}#endif/.test(auth))
check('the app sends it to that route', api.includes('"/api/intern/diagnostics"'))
// Read-only: it may read attributes and ask whether one CAN be set, nothing else.
check('the Mac code reads Logic and never acts on it',
  !/AXUIElementSetAttributeValue|AXUIElementPerformAction|CGEvent|NSAppleScript|Process\(\)/.test(mac))
check('it asks for the Accessibility permission once, not on every launch', /internAskedForAccessibility/.test(mac) && /UserDefaults\.standard\.set\(true/.test(mac))

if (failures) { console.error(`\nintern: ${failures} check(s) FAILED`); process.exit(1) }
console.log('\nintern: all checks passed')
