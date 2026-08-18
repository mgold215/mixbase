#!/usr/bin/env node
// Contract test: the shared admin Supabase client must ALWAYS act as service_role.
//
// The bug this locks out (found live in prod 2026-08-15, ~5.2 GB of leaked
// objects across the three buckets):
//
//   `supabaseAdmin` is a module singleton on a long-lived Railway process.
//   /api/auth, /api/auth/signup, /api/auth/change-password and the session
//   refresher all called `supabaseAdmin.auth.signInWithPassword()` /
//   `.refreshSession()` ON IT. supabase-js keeps the resulting session on the
//   client, and SupabaseClient._getAccessToken() prefers it over the API key:
//
//       if (this.accessToken) return await this.accessToken()
//       const { data } = await this.auth.getSession()
//       return data.session?.access_token ?? this.supabaseKey
//
//   So from the first sign-in onward, every PostgREST and Storage request the
//   SERVER made carried that user's token at role `authenticated`. Storage RLS
//   grants DELETE on mf-audio/mf-artwork/mf-video only to
//   `auth.role() = 'service_role'`, so deletes matched no policy, removed zero
//   rows, and storage-api returned 200 with a body of `[]` — which supabase-js
//   surfaces as `{ data: [], error: null }`, i.e. NO error. Every cleanup path
//   in the app reported success while deleting nothing, for months.
//
// Two layers here, because a source-shape check alone would not have caught it
// (the old code looked perfectly reasonable):
//
//   A. RUNTIME — drive the real installed supabase-js with a stub fetch and
//      assert which Authorization header actually goes out, with and without a
//      session on the client. This proves the hazard is real rather than
//      assumed, and will fail if supabase-js ever changes the precedence.
//   B. SOURCE  — assert no session-establishing auth call is made on
//      supabaseAdmin anywhere in src/, and that createSessionClient() is
//      configured not to persist or auto-refresh.
//
// Deliberately offline: every request is intercepted, nothing leaves the box,
// and the keys below are fake.
//
// Run: node scripts/admin-client-role-test.mjs

import { createClient } from '@supabase/supabase-js'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(root, 'src')

let failures = 0
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`)
    failures++
  }
}

const URL_ = 'https://example.supabase.co'
const SERVICE_KEY = 'test-service-role-key'
const USER_TOKEN = 'test-user-access-token'

// Capture the Authorization header of the next outbound request instead of
// making one. Returns a shape both PostgREST and Storage accept.
function capturingFetch(seen) {
  return async (input, init = {}) => {
    const headers = new Headers(init.headers ?? (input && input.headers) ?? {})
    seen.push({
      url: typeof input === 'string' ? input : input.url,
      auth: headers.get('Authorization'),
      apikey: headers.get('apikey'),
    })
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
}

// ── A. Runtime: what token actually goes out ─────────────────────────────────
console.log('\nsupabase-js token precedence (runtime)')

{
  const seen = []
  const client = createClient(URL_, SERVICE_KEY, { global: { fetch: capturingFetch(seen) } })
  await client.storage.from('mf-video').remove(['proj/clip.mp4'])
  check(
    'with NO session, a storage call authenticates with the service key',
    seen.length === 1 && seen[0].auth === `Bearer ${SERVICE_KEY}`,
    `sent: ${seen[0]?.auth}`,
  )
}

{
  const seen = []
  const client = createClient(URL_, SERVICE_KEY, { global: { fetch: capturingFetch(seen) } })
  // Exactly what signInWithPassword()/refreshSession() leave behind on the
  // client. Stubbed rather than performed so the test needs no network.
  client.auth.getSession = async () => ({
    data: { session: { access_token: USER_TOKEN } },
    error: null,
  })
  await client.storage.from('mf-video').remove(['proj/clip.mp4'])
  check(
    'THE HAZARD: with a session, the same call sends the USER token, not the service key',
    seen.length === 1 && seen[0].auth === `Bearer ${USER_TOKEN}`,
    `sent: ${seen[0]?.auth} — if this now sends the service key, supabase-js changed and this test's premise needs revisiting`,
  )
}

{
  // PostgREST takes the same path, so the demotion was never storage-only.
  const seen = []
  const client = createClient(URL_, SERVICE_KEY, { global: { fetch: capturingFetch(seen) } })
  client.auth.getSession = async () => ({
    data: { session: { access_token: USER_TOKEN } },
    error: null,
  })
  await client.from('mb_versions').select('id').limit(1)
  check(
    'the same demotion applies to PostgREST reads/writes, not just storage',
    seen.length === 1 && seen[0].auth === `Bearer ${USER_TOKEN}`,
    `sent: ${seen[0]?.auth}`,
  )
}

// ── B. Source: the admin client is never given a session ─────────────────────
console.log('\nsource contract')

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(p)) out.push(p)
  }
  return out
}

// An ALLOW-LIST, deliberately, not a list of banned methods.
//
// The first version of this check enumerated the session-establishing methods
// (signInWithPassword, refreshSession, …) and was both over- and
// under-inclusive: it listed `signInWithOtp`, which does not save a session, and
// omitted `signInAnonymously`, `exchangeCodeForSession`, `updateUser`,
// `linkIdentityIdToken` and the MFA `_verify` path, all of which DO. Every one
// of those reaches `_saveSession` in @supabase/auth-js. `exchangeCodeForSession`
// is the live risk: src/app/auth/callback/route.ts already calls it (correctly,
// on its own client), so a refactor to `supabaseAdmin.auth.exchangeCodeForSession`
// — the natural mistake, since every other route imports supabaseAdmin —
// recreates the incident, and a deny-list would have stayed green.
//
// Only two uses of `supabaseAdmin.auth` are safe, and both are safe by
// construction rather than by convention:
//   auth.admin.*   — always sends the service key explicitly
//   getUser(token) — with a jwt argument it short-circuits to a bare request and
//                    never touches _useSession/_saveSession/storage
//   getSession()   — READS the session; it is the health probe's leak detector.
//                    (It is not purely passive: on an EXPIRED stored session it
//                    refreshes, which writes one back. That cannot establish a
//                    session where none exists, so it cannot cause the bug —
//                    but it is why the probe can report a false negative for a
//                    process whose leaked session had just expired.)
// Anything else must go through createSessionClient(). Complete by construction,
// so it cannot rot as the library adds methods.
const ADMIN_AUTH_ALLOWED = /^(admin\b|getUser\s*\(|getSession\s*\()/

const files = walk(srcDir)
const offenders = []
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  for (const m of text.matchAll(/supabaseAdmin\s*\.\s*auth\s*\.\s*/g)) {
    const rest = text.slice(m.index + m[0].length, m.index + m[0].length + 40)
    if (!ADMIN_AUTH_ALLOWED.test(rest)) {
      const member = (rest.match(/^[A-Za-z_$][\w$]*/) ?? ['<unknown>'])[0]
      offenders.push(`${relative(root, file)} → supabaseAdmin.auth.${member}`)
    }
  }
}
check(
  'supabaseAdmin.auth is used ONLY for admin.* and getUser(token)',
  offenders.length === 0,
  offenders.join('\n      '),
)

const libSource = readFileSync(join(srcDir, 'lib', 'supabase.ts'), 'utf8')
check(
  'src/lib/supabase.ts exports createSessionClient()',
  /export function createSessionClient\s*\(/.test(libSource),
)
check(
  'createSessionClient does not persist its session',
  /persistSession:\s*false/.test(libSource),
)
check(
  'createSessionClient does not auto-refresh (no background timers left behind)',
  /autoRefreshToken:\s*false/.test(libSource),
)

// The four call sites that caused the incident must now use the throwaway client.
for (const [file, label] of [
  ['app/api/auth/route.ts', 'sign-in'],
  ['app/api/auth/signup/route.ts', 'sign-up auto-login'],
  ['app/api/auth/change-password/route.ts', 'password re-auth'],
  ['lib/refresh-session.ts', 'token refresh'],
]) {
  const text = readFileSync(join(srcDir, file), 'utf8')
  check(
    `${label} (${file}) uses createSessionClient()`,
    /createSessionClient\s*\(/.test(text),
  )
}

// The monitoring that was blind to this. /api/health's `admin_power` probe
// counts profiles rows, which catches degradation to ANON (sees zero rows) but
// NOT degradation to a user (still sees their own row) — so it reported healthy
// throughout. It must now also report the session directly.
const healthSource = readFileSync(join(srcDir, 'app', 'api', 'health', 'route.ts'), 'utf8')
check(
  '/api/health detects a session on the admin client',
  /supabaseAdmin\s*\.\s*auth\s*\.\s*getSession\s*\(/.test(healthSource),
)
check(
  '/api/health reports admin_session_leak',
  /admin_session_leak/.test(healthSource),
)

// ── Summary ──────────────────────────────────────────────────────────────────
if (failures) {
  console.error(`\n✗ admin-client-role-test: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\n✅ admin-client-role-test: all checks passed')
