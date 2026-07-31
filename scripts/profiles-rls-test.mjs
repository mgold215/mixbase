#!/usr/bin/env node
// Contract test: no table holding billing / privilege columns may end the
// migration sequence with a world-readable RLS select policy.
//
// Why this matters: RLS is the ONLY thing standing between the anon role and
// these tables. The anon role holds a plain SELECT grant on public tables (see
// the note in src/app/api/db-init/route.ts), and NEXT_PUBLIC_SUPABASE_ANON_KEY
// ships in the client bundle by design — so a `for select using (true)` policy
// means "anyone on the internet can read every row".
//
// Migration 006 created exactly that on `profiles`:
//     create policy "anyone_can_read_profiles" on profiles for select using (true);
// and then 007 added stripe_customer_id / stripe_subscription_id /
// apple_original_transaction_id / subscription_tier to the same table. Worse,
// subscription_tier IS the admin gate (src/proxy.ts rejects anything that is
// not `subscription_tier === 'admin'` for /admin, /api/admin, /api/infra), so a
// readable profiles table also tells an attacker which account to go after.
//
// Production had already been remediated out-of-band (live policy set is
// `users_read_own_profile` + `users_update_own_profile`, both `id = auth.uid()`),
// but the repository never learned about it — so every fresh environment built
// from supabase/migrations/ was born world-readable. Migration 024 closes that.
//
// This test replays the migration files in order (create/drop policy), then
// asserts the RESULTING policy set is safe — so it catches the whole class, not
// just the one policy: any future migration that adds a broad select policy to a
// sensitive table, or that reintroduces the 006 policy, fails CI.
//
// Pure source-contract test — no DB / network. Run: node scripts/profiles-rls-test.mjs
// (also part of `npm run test:renderers`)

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const MIGRATIONS = join(root, 'supabase/migrations')

let failures = 0
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

/** Read the balanced (...) group that starts at or after `from`. */
function balancedParens(src, from) {
  const start = src.indexOf('(', from)
  if (start === -1) return null
  let depth = 0
  for (let i = start; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')') {
      depth--
      if (depth === 0) return src.slice(start + 1, i).trim()
    }
  }
  return null
}

const stripComments = (sql) => sql.replace(/--[^\n]*/g, '')
const norm = (s) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * Replay every migration in filename order and return the surviving policies
 * as Map<table, Map<policyName, {cmd, using}>>, plus the set of RLS-enabled
 * tables and the columns each table accumulated.
 */
function replayMigrations(files) {
  const policies = new Map()
  const rlsEnabled = new Set()
  const columns = new Map()

  const addCol = (table, col) => {
    if (!columns.has(table)) columns.set(table, new Set())
    columns.get(table).add(col)
  }

  for (const file of files) {
    const sql = stripComments(readFileSync(join(MIGRATIONS, file), 'utf8'))

    for (const m of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?([\w."]+)\s+enable\s+row\s+level\s+security/gi)) {
      rlsEnabled.add(m[1].replace(/"/g, '').replace(/^public\./, ''))
    }

    // Columns: `create table ... ( ... )` bodies and `add column [if not exists] <name>`.
    for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([\w."]+)\s*\(/gi)) {
      const table = m[1].replace(/"/g, '').replace(/^public\./, '')
      const body = balancedParens(sql, m.index + m[0].length - 1)
      if (!body) continue
      for (const line of body.split('\n')) {
        const c = line.trim().match(/^([a-z_][\w]*)\s+/i)
        if (c && !/^(primary|foreign|unique|constraint|check)$/i.test(c[1])) addCol(table, c[1].toLowerCase())
      }
    }
    // One ALTER TABLE may carry several comma-separated ADD COLUMN clauses
    // (migration 007 adds all six billing columns in a single statement), so
    // take the whole statement and collect every clause inside it.
    for (const m of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?([\w."]+)([\s\S]*?);/gi)) {
      const table = m[1].replace(/"/g, '').replace(/^public\./, '')
      for (const c of m[2].matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?([\w]+)/gi)) {
        addCol(table, c[1].toLowerCase())
      }
    }

    for (const m of sql.matchAll(/drop\s+policy\s+(?:if\s+exists\s+)?"?([^"\n]+?)"?\s+on\s+([\w."]+)/gi)) {
      const table = m[2].replace(/"/g, '').replace(/^public\./, '')
      policies.get(table)?.delete(m[1].trim())
    }

    for (const m of sql.matchAll(/create\s+policy\s+"([^"]+)"\s+on\s+([\w."]+)\s+for\s+(\w+)/gi)) {
      const table = m[2].replace(/"/g, '').replace(/^public\./, '')
      const tail = sql.slice(m.index)
      const end = tail.indexOf(';')
      const stmt = end === -1 ? tail : tail.slice(0, end)
      const usingIdx = stmt.search(/\busing\b/i)
      const using = usingIdx === -1 ? null : balancedParens(stmt, usingIdx)
      if (!policies.has(table)) policies.set(table, new Map())
      policies.get(table).set(m[1], { cmd: m[3].toLowerCase(), using })
    }
  }
  return { policies, rlsEnabled, columns }
}

// A column whose value must never be world-readable.
const SENSITIVE = /^(stripe_|apple_|subscription_|is_owner$|.*_secret$|.*_api_key$)/

const allFiles = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()

console.log('profiles-rls: sensitive tables must not end up world-readable\n')

// ── The generalized invariant, over the full migration sequence ──────────────
const { policies, rlsEnabled, columns } = replayMigrations(allFiles)

const sensitiveTables = [...columns.entries()]
  .filter(([, cols]) => [...cols].some((c) => SENSITIVE.test(c)))
  .map(([t]) => t)

check('found at least one sensitive table to guard', sensitiveTables.length > 0, sensitiveTables.join(', '))

for (const table of sensitiveTables) {
  check(`${table}: RLS enabled`, rlsEnabled.has(table))
  const tablePolicies = policies.get(table) ?? new Map()
  const reads = [...tablePolicies.entries()].filter(([, p]) => p.cmd === 'select' || p.cmd === 'all')

  for (const [name, p] of reads) {
    check(
      `${table}: read policy "${name}" is not world-readable`,
      norm(p.using) !== 'true',
      norm(p.using) === 'true' ? 'using (true) exposes every row to the anon key' : `using (${norm(p.using)})`,
    )
    check(
      `${table}: read policy "${name}" is scoped to the requesting user`,
      /auth\.uid\(\)/i.test(p.using ?? ''),
    )
  }
}

// ── Explicit locks on profiles, the table this migration is about ────────────
const profilePolicies = policies.get('profiles') ?? new Map()
check('profiles: the 006 permissive policy does not survive', !profilePolicies.has('anyone_can_read_profiles'))
check('profiles: an owner-scoped select policy exists', [...profilePolicies.values()].some((p) => p.cmd === 'select' && /auth\.uid\(\)/i.test(p.using ?? '')))
check('profiles: owner-scoped update policy retained', [...profilePolicies.values()].some((p) => p.cmd === 'update' && /auth\.uid\(\)/i.test(p.using ?? '')))

// The columns that made this urgent must still be recognised as sensitive, so
// nobody "fixes" a future failure by renaming the guard out from under them.
const profileCols = columns.get('profiles') ?? new Set()
for (const c of ['stripe_customer_id', 'stripe_subscription_id', 'subscription_tier', 'is_owner']) {
  check(`profiles: "${c}" is present and classified sensitive`, profileCols.has(c) && SENSITIVE.test(c))
}

// ── Fail-first witness: the same engine over the pre-024 migration set ────────
// Proves these checks actually detect the real vulnerability rather than
// passing vacuously.
console.log('\n  witness: replaying the migration set WITHOUT 024 (the pre-fix state)')
const pre = replayMigrations(allFiles.filter((f) => !f.startsWith('024_')))
const prePolicies = pre.policies.get('profiles') ?? new Map()
const preRead = prePolicies.get('anyone_can_read_profiles')
check('witness: pre-024 profiles carried "anyone_can_read_profiles"', !!preRead)
check('witness: pre-024 policy was using (true)', norm(preRead?.using) === 'true')
check(
  'witness: pre-024 profiles had NO owner-scoped select policy',
  ![...prePolicies.values()].some((p) => p.cmd === 'select' && /auth\.uid\(\)/i.test(p.using ?? '')),
)
check(
  'witness: pre-024 sensitive columns were already on that table',
  ['stripe_customer_id', 'subscription_tier'].every((c) => (pre.columns.get('profiles') ?? new Set()).has(c)),
)

if (failures > 0) {
  console.error(`\nprofiles-rls: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nprofiles-rls: all checks passed')
