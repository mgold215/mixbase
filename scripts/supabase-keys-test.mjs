#!/usr/bin/env node
// Contract test: no client or server path depends on the LEGACY Supabase keys.
//
// Why (2026-10-21): Railway disclosed that an intruder may have decrypted
// customer environment variables. Ours held the legacy JWT `service_role` key
// and SUPABASE_JWT_SECRET — full database power. Supabase can only revoke those
// by disabling the legacy `anon` + `service_role` keys and revoking the legacy
// JWT secret TOGETHER, and the shipped iOS/macOS app embedded that legacy anon
// key, so revoking would have broken every installed copy. The fix moves every
// client to the publishable key (sb_publishable_...) and the server to a secret
// key (sb_secret_...). This test keeps it that way:
//
//   A. RUNTIME — serviceKeyHeaders() (the TUS upload proxy's auth) sends a
//      secret key in `apikey` ONLY. Supabase rejects sb_ keys sent as
//      `Authorization: Bearer`; the old Bearer-only header would have broken
//      every large audio upload the moment the new key went into Railway.
//   B. SOURCE  — the TUS routes use that helper rather than hand-building a
//      Bearer header from the raw env var.
//   C. SOURCE  — no legacy JWT-format Supabase key is hardcoded anywhere that
//      ships (web, iOS/macOS, CI scripts); the Apple apps never send the key
//      itself as a Bearer token.
//
// Offline; the keys below are fake. Run: node scripts/supabase-keys-test.mjs

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = p => readFileSync(join(root, p), 'utf8')

let failures = 0
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`)
    failures++
  }
}

// ── A. serviceKeyHeaders() at runtime ───────────────────────────────────────
console.log('serviceKeyHeaders() (src/lib/service-key.ts):')
const { serviceKeyHeaders } = await import('../src/lib/service-key.ts')
const withKey = value => {
  if (value === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
  else process.env.SUPABASE_SERVICE_ROLE_KEY = value
  return serviceKeyHeaders()
}

// Assembled at runtime so secret scanners never see a key-shaped literal.
const FAKE_SECRET = ['sb', 'secret', 'fake0123456789'].join('_')
const secret = withKey(FAKE_SECRET)
check('secret key → apikey header', secret.apikey === FAKE_SECRET)
check('secret key → NO Authorization header (Supabase rejects sb_ keys as Bearer)',
  !('Authorization' in secret), JSON.stringify(Object.keys(secret)))

const pasted = withKey(`  ${FAKE_SECRET}\n`)
check('a key pasted with whitespace is trimmed and still treated as a secret key',
  pasted.apikey === FAKE_SECRET && !('Authorization' in pasted))

// Any non-sb_ value is treated as a legacy JWT key; a JWT-shaped literal here
// would only trip the pre-commit secret scanner.
const legacy = withKey('legacy-jwt-service-role-key')
check('legacy JWT key → Authorization: Bearer <key> (what Storage reads)',
  legacy.Authorization === 'Bearer legacy-jwt-service-role-key')
check('legacy JWT key → apikey alongside, as supabase-js sends it',
  legacy.apikey === 'legacy-jwt-service-role-key')

let threw = false
try { withKey(undefined) } catch { threw = true }
check('missing key throws instead of sending an empty credential', threw)

// ── B. The TUS proxy uses the helper ────────────────────────────────────────
console.log('\nTUS upload proxy:')
for (const file of ['src/app/api/tus/route.ts', 'src/app/api/tus/[uploadId]/route.ts']) {
  const src = read(file)
  const name = file.replace('src/app/api/', '')
  check(`${name} authenticates via serviceKeyHeaders()`, /\.\.\.serviceKeyHeaders\(\)/.test(src))
  check(`${name} never hand-builds a Bearer header from the service key`,
    !/Bearer \$\{\s*(serviceKey|process\.env\.SUPABASE_SERVICE_ROLE_KEY)/.test(src) &&
    !/process\.env\.SUPABASE_SERVICE_ROLE_KEY/.test(src))
}

// ── C. Nothing that ships carries a legacy JWT key ──────────────────────────
console.log('\nNo legacy JWT-format Supabase key in shipped code:')
// Every legacy Supabase key starts with this header + `{"iss":"supabase",…`.
const LEGACY_KEY_PREFIX = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIs'
function gitGrepFiles(pattern, paths) {
  try {
    return execFileSync('git', ['grep', '-l', pattern, '--', ...paths],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n').filter(Boolean)
  } catch (err) {
    if (err.status === 1) return [] // git grep: no match
    throw err
  }
}
const hits = gitGrepFiles(LEGACY_KEY_PREFIX, ['src', 'ios', 'macos', '.github', 'public', 'scripts'])
  .filter(f => f !== 'scripts/supabase-keys-test.mjs')
check('src/, ios/, macos/, .github/, public/, scripts/ hold no legacy key', hits.length === 0, hits.join(', '))

const webFallback = read('src/lib/supabase.ts').match(/NEXT_PUBLIC_SUPABASE_ANON_KEY \?\? '([^']+)'/)
check('web fallback key is the publishable key', webFallback?.[1]?.startsWith('sb_publishable_'), webFallback?.[1])

const config = read('ios/mixBase/Utilities/Config.swift')
check('iOS/macOS Config embeds the publishable key',
  /static let supabasePublishableKey: String = "sb_publishable_[A-Za-z0-9_-]+"/.test(config))
const service = read('ios/mixBase/Services/SupabaseService.swift')
check('the Apple apps never send the key itself as a Bearer token',
  !/accessToken \?\? supabaseKey/.test(service) && !/Bearer \\\(supabaseKey\)/.test(service))

if (failures > 0) {
  console.error(`\nFAIL: ${failures} Supabase key assertion(s) failed.`)
  process.exit(1)
}
console.log('\nPASS: no path depends on the legacy Supabase keys.')
