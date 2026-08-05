#!/usr/bin/env node
// Contract test: the security-critical schema heals must run on a path that
// actually executes, and must not turn a public endpoint into an amplifier.
//
// WHY THIS EXISTS — a heal that never fires is not a fix.
// `ensureUsageRpcGrants` (migration 018: revoke PUBLIC EXECUTE on the SECURITY
// DEFINER `try_increment_usage`) and `ensureUsageTableWriteLock` (migration
// 025: drop the client write policies on `mb_usage`) were both correct, both
// memoized, both tested — and both fired ONLY from `checkAndIncrementUsage`,
// i.e. only when a user starts a paid artwork/video generation.
//
// That trigger is far too rare to rely on. Verified against the LIVE database
// on 2026-08-02, weeks after the heals shipped:
//
//   try_increment_usage    proacl = {=X/postgres, postgres=X/postgres, service_role=X/postgres}
//   increment_artwork_usage proacl = {postgres=X/postgres, service_role=X/postgres}
//
// The leading `=X` on the first row is the PUBLIC grant. So anyone holding the
// public anon key could still POST /rest/v1/rpc/try_increment_usage with any
// victim's user_id and inflate their monthly counter until artwork/video
// generation was locked out (free tier caps at 3). The second row — locked by a
// migration that was actually APPLIED — shows what the healed state looks like.
// The heal was never broken. It simply never ran.
//
// The fix moves the trigger to /api/health, which Railway hits on every deploy,
// and bounds the retry so the now-public trigger can't hammer the Supabase
// Management API. Both halves are load-bearing; this test locks both.
//
// Pure source-contract test — no DB / network. schema-heal.ts imports the `@/`
// alias, so it can't be imported under plain Node type-stripping; assert on the
// source text, the same way usage-rpc-grants-test.mjs does.
// Run: node scripts/security-heal-trigger-test.mjs  (also part of `npm run test:renderers`)

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

console.log('security-heal-trigger: the lockdowns must run on a path that executes\n')

const heal = read('src/lib/schema-heal.ts')
const healRetry = read('src/lib/heal-retry.ts')
const health = read('src/app/api/health/route.ts')
const tier = read('src/lib/tier.ts')

// ── 1. A single entry point that applies BOTH lockdowns ─────────────────────
check('schema-heal exports ensureSecurityHeals', /export async function ensureSecurityHeals\b/.test(heal))

const fnStart = heal.indexOf('export async function ensureSecurityHeals')
const fnBody = fnStart === -1 ? '' : heal.slice(fnStart, heal.indexOf('\n}', fnStart) + 2)

check('it applies the usage-RPC grant lockdown', /ensureUsageRpcGrants\(\)/.test(fnBody))
check('it applies the mb_usage write lockdown', /ensureUsageTableWriteLock\(\)/.test(fnBody))

// Healing one door and not the other leaves the quota ledger open — the RPC
// grant and the table policies are independent ways in.
check('it does not report success unless BOTH succeeded',
  /grants\s*&&\s*tableLock/.test(fnBody))

// It must never throw into a caller that is fire-and-forgetting it.
check('each heal is individually catch-guarded', (fnBody.match(/\.catch\(/g) || []).length >= 2)

// ── 2. Wired into a path that runs on EVERY deploy ──────────────────────────
// This is the whole point of the change: /api/health is Railway's deploy
// healthcheck, so the lockdown is re-asserted on every single release rather
// than waiting for a paid generation that may never come.
check('the health route imports ensureSecurityHeals', /ensureSecurityHeals/.test(health))
check('the health route invokes it', /ensureSecurityHeals\(\)/.test(health))

// Fire-and-forget: the heal must not be awaited, or a slow/hanging Management
// API call would stall the healthcheck and could fail a good deploy.
check('the health route does NOT await it (never delays or fails the check)',
  /void\s+ensureSecurityHeals\(\)/.test(health) && !/await\s+ensureSecurityHeals\(/.test(health))

// The response must not depend on the heal's outcome.
check('the health response does not branch on the heal result',
  !/ensureSecurityHeals[\s\S]{0,200}?(\?|if\s*\()/.test(health.replace(/void ensureSecurityHeals\(\)/, '')))

// ── 3. Bounded retry — a PUBLIC trigger must not become an amplifier ────────
// /api/health is unauthenticated. The underlying heals null their memo on
// failure so the next call retries; without a cap, one request per attacker
// request would hit the Supabase Management API forever.
check('an attempt cap is defined', /HEAL_MAX_ATTEMPTS\s*=\s*\d+/.test(heal))
check('a retry cooldown is defined', /HEAL_RETRY_COOLDOWN_MS\s*=\s*[\d_]+/.test(heal))
check('the cap is enforced before doing any work',
  /attempts\s*>=\s*HEAL_MAX_ATTEMPTS/i.test(fnBody))
check('the cooldown is enforced between attempts',
  /HEAL_RETRY_COOLDOWN_MS/.test(fnBody))
check('a satisfied heal short-circuits immediately',
  /if\s*\(\s*securityHealDone\s*\)\s*return true/.test(fnBody))

const cap = Number((heal.match(/HEAL_MAX_ATTEMPTS\s*=\s*(\d+)/) || [])[1])
check('the cap is small enough to bound Management API load', cap > 0 && cap <= 10, `cap = ${cap}`)

// ── 3b. A failing heal must be VISIBLE ──────────────────────────────────────
// The trigger fix is worthless if the heal fires and silently fails. That is
// not hypothetical: on 2026-08-02 the Railway-stored SUPABASE_MANAGEMENT_TOKEN
// was rejected `401 JWT could not be decoded` on staging AND production, so
// every heal in this module had been a no-op for an unknown period while the
// code read as correct. console.error alone is not a signal anyone sees.
check('runQuery reports failures to Sentry, not just the console',
  /Sentry\.captureMessage\(`schema-heal:/.test(heal))
check('a rejected credential (401/403) is raised at error level',
  /status === 401 \|\| status === 403 \? 'error' : 'warning'/.test(heal))
check('the heal label is tagged so the failing heal is identifiable',
  /tags:\s*\{\s*heal:/.test(heal))
// The SQL can carry schema details and the token must never be logged; only
// Supabase's own error envelope is attached.
check('the report attaches the error envelope, never the SQL or the token',
  !/extra:[\s\S]{0,120}\bsql\b/.test(heal) && !/extra:[\s\S]{0,120}\btoken\b/.test(heal))

// ── 4. The original generation-path wiring is RETAINED ──────────────────────
// The health trigger is an addition, not a replacement: a long-running process
// that healed at boot before the grant drifted still re-asserts on generation.
check('tier.ts still fires ensureUsageRpcGrants (defence in depth)', /ensureUsageRpcGrants\(\)/.test(tier))
check('tier.ts still fires ensureUsageTableWriteLock', /ensureUsageTableWriteLock\(\)/.test(tier))

// ── 5. The lockdown SQL itself still says what it must ──────────────────────
// Guard against a refactor that keeps the wiring but guts the statement.
const grantsSql = (heal.match(/const\s+USAGE_RPC_GRANTS_SQL\s*=\s*`([\s\S]*?)`/) || [])[1] ?? ''
check('the revoke still names public (not just anon/authenticated)',
  /revoke\s+execute[\s\S]*?\bpublic\b/i.test(grantsSql))
check('service_role keeps execute (the app must still work)',
  /grant\s+execute[\s\S]*?to\s+service_role/i.test(grantsSql))

// ── Fail-first witness ──────────────────────────────────────────────────────
// Reconstruct the pre-fix world and prove these checks would have caught it:
// the heals existed and were correct, but were reachable only from the paid
// generation path, and the health route knew nothing about them.
console.log('\n  witness: the pre-fix world (heals correct, but only ever fired on a paid generation)')

const preHeal = `
export function ensureUsageRpcGrants() { /* memoized, nulls on failure */ }
export function ensureUsageTableWriteLock() { /* memoized, nulls on failure */ }
`
const preHealth = `
import { supabaseAdmin, serviceRoleKeyValid } from '@/lib/supabase'
export async function GET() {
  let db = 'ok'
  return Response.json({ ok: db === 'ok', db })
}
`
check('witness: pre-fix schema-heal had no ensureSecurityHeals',
  !/export async function ensureSecurityHeals\b/.test(preHeal))
check('witness: pre-fix health route never triggered any heal',
  !/ensureSecurityHeals/.test(preHealth))
check('witness: pre-fix had no attempt cap, so a public trigger would be unbounded',
  !/HEAL_MAX_ATTEMPTS/.test(preHeal))


// ── 2026-08-03: the heal raced ITSELF across containers (Sentry MIXBASE-6) ───
// REVOKE/GRANT rewrites a pg_proc catalog row. The heal fires once per fresh
// process from /api/health, so a Railway rollout boots two containers that both
// re-assert the same grant within seconds — and Postgres kills the loser with
// `XX000: tuple concurrently updated`. Observed live 2 seconds after
// app_start_time. It failed precisely when it was LEAST needed (the state was
// already correct), and because failure nulls the memo, the loser retried and
// sustained its own noise.
console.log('\nHeal DDL is serialized, not racing')
{
  const heal = readFileSync(new URL('../src/lib/schema-heal.ts', import.meta.url), 'utf8')

  check('the grants heal takes an advisory lock before touching pg_proc',
    /pg_advisory_xact_lock\(hashtext\('mixbase:usage_rpc_grants'\)\)/.test(heal))
  check('the mb_usage lockdown takes its own advisory lock',
    /pg_advisory_xact_lock\(hashtext\('mixbase:usage_table_lock'\)\)/.test(heal))
  check('the two heals use DIFFERENT lock keys (they must not block each other)',
    /mixbase:usage_rpc_grants/.test(heal) && /mixbase:usage_table_lock/.test(heal))

  // The lock must be INSIDE a DO block: a transaction-scoped advisory lock is
  // released when the block's implicit transaction ends, so there is no unlock
  // bookkeeping and no way to leak a lock if a statement throws.
  const grantsBlock = heal.slice(heal.indexOf('const USAGE_RPC_GRANTS_SQL'), heal.indexOf('let usageRpcGrantsEnsured'))
  check('the grants DDL is wrapped in a DO block',
    /do \$\$ begin/.test(grantsBlock) && /end \$\$;/.test(grantsBlock))
  check('the REVOKE still runs unconditionally inside the lock (no clever skip predicate)',
    /revoke execute on function public\.try_increment_usage/.test(grantsBlock) &&
    !/has_function_privilege|proacl/.test(grantsBlock))

  // Transient catalog contention must not page anyone, but must not be
  // swallowed forever either — one retry, then report.
  // The classifier moved to src/lib/heal-retry.ts on 2026-08-05 so it could be
  // imported and tested for real (see heal-retry-test.mjs). Assert it still
  // exists there AND that runQuery delegates to it — checking only one half
  // would let the pair drift apart silently.
  check('catalog contention is classified as transient',
    /tuple concurrently updated/.test(healRetry) && /isRetryableHealFailure/.test(heal))
  check('a transient failure is retried exactly once',
    /attempt < 2/.test(heal) && /transient && attempt === 0/.test(heal))
  check('a NON-transient failure is reported on the first try (no doubled load)',
    /if \(transient && attempt === 0\)/.test(heal))

  // Every heal — not just the security pair — now has a failure budget.
  check('runQuery caps repeated failures per label',
    /RUN_QUERY_MAX_FAILURES/.test(heal) && /runQueryFailures/.test(heal))
  check('a successful heal clears its failure budget',
    /runQueryFailures\.delete\(label\)/.test(heal))

  // Witness: the pre-fix SQL was bare statements with no lock.
  const preFix = `
const USAGE_RPC_GRANTS_SQL = \`
revoke execute on function public.try_increment_usage(uuid, text, text, int) from public, anon, authenticated;
grant execute on function public.try_increment_usage(uuid, text, text, int) to service_role;\``
  check('witness: the pre-fix SQL had no advisory lock',
    !/pg_advisory/.test(preFix))
  check('witness: the pre-fix runQuery had no retry and no failure budget',
    !/attempt < 2/.test(preFix) && !/RUN_QUERY_MAX_FAILURES/.test(preFix))
}

if (failures > 0) {
  console.error(`\nsecurity-heal-trigger: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nsecurity-heal-trigger: all checks passed')
