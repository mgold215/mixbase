#!/usr/bin/env node
// Contract test: mb_usage — the server-side tier-limit ledger — must expose NO
// client write policy, so it cannot be written over direct PostgREST.
//
// Why this matters: mb_usage counts each user's monthly artwork/video
// generations and is where tier limits are enforced (src/lib/tier.ts). Every
// write in the app goes through the service-role key (SECURITY DEFINER RPCs +
// supabaseAdmin), which bypasses RLS. Migration 007, though, shipped INSERT and
// UPDATE policies scoped `user_id = auth.uid()`, and anon/authenticated hold the
// default table write grants — so any signed-in user could
//   PATCH /rest/v1/mb_usage?user_id=eq.<self>&month=eq.YYYY-MM {artwork_generations:0}
// and reset their paid-generation quota at will (no `>= 0` guard made a negative
// value a permanent bypass). 017/018 closed the RPC door into this table; this
// closes the table's own write door. The fix must live in three places that can
// drift: the migration (canonical), db-init's SCHEMA_SQL (fresh envs + manual
// bootstrap), and a runtime schema-heal (deploys beat hand-applied migrations),
// wired into the generation path so it actually runs.
//
// Pure source-contract test — no DB / network. Run: node scripts/usage-table-rls-test.mjs
// (also part of `npm run test:renderers`)

import { readFileSync, readdirSync } from 'node:fs'
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

// Both client write policies from migration 007, by their exact names.
const INSERT_POLICY = 'Users can insert their own usage'
const UPDATE_POLICY = 'Users can update their own usage'
const dropsBoth = (sql) =>
  new RegExp(`drop\\s+policy\\s+if\\s+exists\\s+"${INSERT_POLICY}"`, 'i').test(sql) &&
  new RegExp(`drop\\s+policy\\s+if\\s+exists\\s+"${UPDATE_POLICY}"`, 'i').test(sql)

console.log('usage-table-rls: mb_usage must have no client write policy\n')

// ── 1. Canonical migration exists and drops both write policies ──────────────
const migDir = join(root, 'supabase/migrations')
const migFile = readdirSync(migDir).find((f) => /lock_mb_usage|mb_usage_write/i.test(f))
check('a migration locks mb_usage writes', !!migFile, migFile || 'none found')
const mig = migFile ? read(`supabase/migrations/${migFile}`) : ''
check('migration drops the INSERT and UPDATE client policies', dropsBoth(mig))
check('migration guards counters non-negative',
  /check\s*\(\s*artwork_generations\s*>=\s*0\s+and\s+video_generations\s*>=\s*0\s*\)/i.test(mig))
// A DROP that names a role predicate would be a no-op if the policy name drifts;
// the fix drops the *whole* policy, not a grant.
check('migration keeps RLS enabled on mb_usage', /enable\s+row\s+level\s+security/i.test(mig))

// ── 2. db-init SCHEMA_SQL applies the same lockdown (fresh envs) ─────────────
const dbInit = read('src/app/api/db-init/route.ts')
check('db-init SCHEMA_SQL drops both mb_usage write policies', dropsBoth(dbInit))
check('db-init SCHEMA_SQL keeps the non-negative guard',
  /mb_usage[\s\S]*?check\s*\(\s*artwork_generations\s*>=\s*0/i.test(dbInit))

// ── 3. Runtime schema-heal exists, is idempotent, and is wired in ────────────
const heal = read('src/lib/schema-heal.ts')
check('schema-heal exports ensureUsageTableWriteLock', /export function ensureUsageTableWriteLock\b/.test(heal))

const healSqlMatch = heal.match(/const\s+USAGE_TABLE_LOCK_SQL\s*=\s*`([\s\S]*?)`/)
const healSql = healSqlMatch ? healSqlMatch[1] : ''
check('USAGE_TABLE_LOCK_SQL drops both write policies', dropsBoth(healSql))
check('heal uses DROP POLICY IF EXISTS (idempotent, safe to re-run)',
  /drop\s+policy\s+if\s+exists/i.test(healSql))
check('heal guards the ADD CONSTRAINT against re-runs (duplicate_object)',
  /exception\s+when\s+duplicate_object/i.test(healSql))

const tier = read('src/lib/tier.ts')
check('tier.ts imports ensureUsageTableWriteLock', /ensureUsageTableWriteLock/.test(tier))
check('tier.ts invokes ensureUsageTableWriteLock()', /ensureUsageTableWriteLock\(\)/.test(tier))

// It must sit in the success path (after the missing-function fallback returns),
// so a fresh env whose table isn't provisioned yet doesn't fire mid-bootstrap.
const fnStart = tier.indexOf('export async function checkAndIncrementUsage')
const fnBody = tier.slice(fnStart, tier.indexOf('\n}', tier.indexOf('return legacyCheckAndIncrement(userId, feature, limit, month)')) + 2)
const fallbackIdx = fnBody.indexOf('return legacyCheckAndIncrement')
const callIdx = fnBody.indexOf('ensureUsageTableWriteLock()')
check('ensureUsageTableWriteLock() runs only after the missing-function fallback',
  fallbackIdx !== -1 && callIdx !== -1 && callIdx > fallbackIdx)

// ── Fail-first witness ───────────────────────────────────────────────────────
// The pre-fix world: migration 007's policies present, no drop anywhere. Prove
// the checks fail on it rather than passing vacuously.
console.log('\n  witness: migration 007 as shipped (client write policies present, never dropped)')
const preMig = `
create policy "Users can insert their own usage" on public.mb_usage for insert with check (user_id = auth.uid());
create policy "Users can update their own usage" on public.mb_usage for update using (user_id = auth.uid()) with check (user_id = auth.uid());
`
check('witness: pre-fix migration never dropped the write policies', !/drop\s+policy/i.test(preMig))
check('witness: pre-fix migration had no non-negative guard', !/artwork_generations\s*>=\s*0/i.test(preMig))

if (failures > 0) {
  console.error(`\nusage-table-rls: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nusage-table-rls: all checks passed')
