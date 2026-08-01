#!/usr/bin/env node
// Contract test: the SECURITY DEFINER usage RPC must have its EXECUTE grant
// locked to service_role, and that lockdown must be RE-ASSERTABLE against an
// already-present function — not only bundled with CREATE FUNCTION.
//
// Why this matters: try_increment_usage bypasses mb_usage RLS (SECURITY
// DEFINER). A freshly created function keeps a default EXECUTE grant to PUBLIC,
// so any anon or authenticated caller can POST /rest/v1/rpc/try_increment_usage
// and inflate — or exhaust — any user's monthly artwork/video quota. Migration
// 018 revokes that grant, but the revoke only ever ran on the CREATE-FUNCTION
// path (schema-heal's ensureUsageRpc and db-init's SCHEMA_SQL), which fires ONLY
// when the function is ABSENT. Production created the function under migration
// 017 (before the revoke text existed) and never hit that path again, so the
// PUBLIC grant stood for weeks — confirmed live: an anon key reaches the
// function body (FK error), not a permission denial. The durable fix is a
// standalone REVOKE/GRANT heal that runs on its own and is wired into the
// generation path so it actually executes.
//
// Pure source-contract test — no DB / network. Run: node scripts/usage-rpc-grants-test.mjs
// (also part of `npm run test:renderers`)

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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

// Grab the value of a top-level `const NAME = ` template-literal assignment.
function backtickConst(src, name) {
  const m = src.match(new RegExp(`const\\s+${name}\\s*=\\s*\`([\\s\\S]*?)\``))
  return m ? m[1] : ''
}

console.log('usage-rpc-grants: the usage RPC execute grant must be locked and self-healing\n')

const heal = read('src/lib/schema-heal.ts')
const tier = read('src/lib/tier.ts')

// ── 1. A standalone grant-lockdown heal exists and is exported ───────────────
check('schema-heal exports ensureUsageRpcGrants', /export function ensureUsageRpcGrants\b/.test(heal))

const grantsSql = backtickConst(heal, 'USAGE_RPC_GRANTS_SQL')
check('USAGE_RPC_GRANTS_SQL is defined', grantsSql.length > 0)

// ── 2. It revokes from PUBLIC, anon AND authenticated ────────────────────────
// Revoking only anon/authenticated leaves the default PUBLIC grant intact, so
// both roles keep RPC access. All three must be named in one revoke.
const revoke = (grantsSql.match(/revoke\s+execute[\s\S]*?;/i) || [''])[0]
check('revoke names public', /\bpublic\b/i.test(revoke))
check('revoke names anon', /\banon\b/i.test(revoke))
check('revoke names authenticated', /\bauthenticated\b/i.test(revoke))
check('grants execute back to service_role', /grant\s+execute[\s\S]*?to\s+service_role/i.test(grantsSql))

// ── 3. It must NOT re-create the function ────────────────────────────────────
// A REVOKE-only statement is exactly what makes this heal safe to run against
// the already-present production function without racing its definition.
check('grant heal does not CREATE OR REPLACE the function', !/create\s+or\s+replace\s+function/i.test(grantsSql))

// ── 4. It targets the same 4-arg signature the app calls ─────────────────────
check('grant heal targets try_increment_usage(uuid, text, text, int)',
  /try_increment_usage\(uuid,\s*text,\s*text,\s*int\)/i.test(grantsSql))

// It applies the whole of migration 018 — including the handle_new_user revoke.
check('grant heal also revokes handle_new_user() (completes migration 018)',
  /revoke\s+execute\s+on\s+function\s+public\.handle_new_user\(\)\s+from[\s\S]*?public/i.test(grantsSql))

// ── 5. It's wired into the generation path (not dead code) ───────────────────
check('tier.ts imports ensureUsageRpcGrants', /ensureUsageRpcGrants/.test(tier))
check('tier.ts invokes ensureUsageRpcGrants()', /ensureUsageRpcGrants\(\)/.test(tier))

// The call must sit in the SUCCESS path — after the res.error fallback returns —
// so a fresh environment whose function does not exist yet never fires a REVOKE
// at a missing function (that path heals via ensureUsageRpc's create instead).
const fnStart = tier.indexOf('export async function checkAndIncrementUsage')
const fnBody = tier.slice(fnStart, tier.indexOf('\n}', tier.indexOf('legacyCheckAndIncrement(userId, feature, limit, month)')) + 2)
const fallbackIdx = fnBody.indexOf('return legacyCheckAndIncrement')
const callIdx = fnBody.indexOf('ensureUsageRpcGrants()')
check('ensureUsageRpcGrants() runs only after the missing-function fallback',
  fallbackIdx !== -1 && callIdx !== -1 && callIdx > fallbackIdx)

// ── 6. The canonical create-path revoke still exists (defence in depth) ──────
// Fresh environments get the lockdown at CREATE time; this test does not let a
// refactor quietly drop it from the create SQL.
const createSql = backtickConst(heal, 'USAGE_RPC_SQL')
check('create-path USAGE_RPC_SQL still revokes from public/anon/authenticated',
  /revoke\s+execute[\s\S]*?from[\s\S]*?public[\s\S]*?anon[\s\S]*?authenticated/i.test(createSql))
check('db-init SCHEMA_SQL still revokes the usage RPC from public',
  /revoke\s+execute\s+on\s+function\s+public\.try_increment_usage[\s\S]*?public/i.test(read('src/app/api/db-init/route.ts')))

// ── Fail-first witness ───────────────────────────────────────────────────────
// The pre-fix state: only the create-bundled revoke existed, with no standalone
// heal and no wiring in the generation path. Prove the new checks fail on it.
console.log('\n  witness: the pre-fix world (revoke bundled in CREATE only, no standalone heal)')
const preHeal = `
const USAGE_RPC_SQL = \`create or replace function public.try_increment_usage(...) ...;
revoke execute on function public.try_increment_usage(uuid, text, text, int) from public, anon, authenticated;
grant execute on function public.try_increment_usage(uuid, text, text, int) to service_role;\`
export function ensureUsageRpc() { /* create-path heal, gated on PGRST202 */ }
`
const preTier = `
export async function checkAndIncrementUsage(userId, feature) {
  let res = await supabaseAdmin.rpc('try_increment_usage', {})
  if (res.error && isMissingUsageRpc(res.error)) { await ensureUsageRpc(); res = await supabaseAdmin.rpc('try_increment_usage', {}) }
  if (res.error) return legacyCheckAndIncrement(userId, feature, limit, month)
  return { allowed: res.data.allowed }
}
`
check('witness: pre-fix schema-heal had no ensureUsageRpcGrants', !/export function ensureUsageRpcGrants\b/.test(preHeal))
check('witness: pre-fix tier.ts never invoked ensureUsageRpcGrants()', !/ensureUsageRpcGrants\(\)/.test(preTier))

if (failures > 0) {
  console.error(`\nusage-rpc-grants: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nusage-rpc-grants: all checks passed')
