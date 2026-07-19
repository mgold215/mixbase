#!/usr/bin/env node
// Contract test: the /api/db-init bootstrap SQL must enable RLS + define policies
// for EVERY table it creates — no table may be left with RLS off.
//
// Why this matters: /api/db-init is the advertised "run mixBase database
// migrations" bootstrap path. It creates tables via the Supabase Management API
// (superuser), and Supabase's default grants give the PUBLIC anon/authenticated
// roles full SELECT/INSERT/UPDATE/DELETE on every table in `public`. The ONLY
// thing standing between the embedded anon key and world-read/write of a table
// is Row Level Security being ON. A `create table` with no matching
// `enable row level security` therefore ships a table that anyone holding the
// public anon key can read, forge rows in, and delete from directly via
// PostgREST — invisible to the app itself, which uses the service-role key and
// bypasses RLS either way.
//
// This regressed once: migration 022 added `mb_feed_comments` (with RLS + 3
// policies), but the db-init SCHEMA_SQL copy created the table and forgot both —
// so a fresh environment bootstrapped through db-init got a wide-open comments
// table. This test parses SCHEMA_SQL and fails CI if any created table lacks an
// RLS-enable or a policy, and locks the mb_feed_comments policy set to match the
// canonical migration 022. A self-contained fail-first witness proves the guard
// fires on the pre-fix SQL.
//
// Pure source-contract test — no DB / network. Run: node scripts/db-init-rls-test.mjs
// (also part of `npm run test:renderers`)

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

let failures = 0
function check(name, cond) {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    console.error(`  ✗ ${name}`)
    failures++
  }
}

// Pull the multi-line `const SCHEMA_SQL = \`...\`` template literal out of source.
// The SQL body contains no backticks, so a non-greedy match to the first one is
// exact.
function schemaSql(src) {
  const m = src.match(/const SCHEMA_SQL\s*=\s*`([\s\S]*?)`/)
  return m ? m[1] : null
}

const tablesCreated = (sql) =>
  [...sql.matchAll(/create table if not exists\s+(mb_\w+)/gi)].map((m) => m[1])
const rlsEnabled = (sql, t) =>
  new RegExp(`alter table\\s+${t}\\s+enable row level security`, 'i').test(sql)
const hasPolicy = (sql, t) =>
  new RegExp(`create policy\\s+"[^"]+"\\s+on\\s+${t}\\b`, 'i').test(sql)

console.log('db-init-rls: every table the bootstrap creates must have RLS + a policy')

const src = read('src/app/api/db-init/route.ts')
const SQL = schemaSql(src)
check('SCHEMA_SQL template literal found', SQL !== null)
if (SQL === null) {
  console.error('\ndb-init-rls: could not locate SCHEMA_SQL — aborting')
  process.exit(1)
}

// ── Section A: general invariant across ALL created tables ────────────────────
const tables = [...new Set(tablesCreated(SQL))]
check('db-init creates at least the known tables', tables.length >= 8)
for (const t of tables) {
  check(`table "${t}" enables row level security`, rlsEnabled(SQL, t))
  check(`table "${t}" defines at least one policy`, hasPolicy(SQL, t))
}

// ── Section B: targeted lock on mb_feed_comments (the table that regressed) ────
check('mb_feed_comments is created by db-init', tables.includes('mb_feed_comments'))
check('mb_feed_comments enables RLS', rlsEnabled(SQL, 'mb_feed_comments'))
const FEED_POLICIES = [
  'feed_comments_read_authenticated',
  'feed_comments_insert_own',
  'feed_comments_delete_own',
]
for (const p of FEED_POLICIES) {
  check(
    `mb_feed_comments has policy "${p}"`,
    new RegExp(`create policy\\s+"${p}"\\s+on mb_feed_comments`, 'i').test(SQL),
  )
}
// The read policy must gate on a signed-in user (never `using (true)`), and the
// write policies must scope to the row's own user_id.
check(
  'feed read policy requires an authenticated user',
  /create policy\s+"feed_comments_read_authenticated"\s+on mb_feed_comments\s+for select using \(\s*auth\.uid\(\)\s+is not null\s*\)/i.test(SQL),
)
check(
  'feed insert policy scopes to own user_id',
  /create policy\s+"feed_comments_insert_own"\s+on mb_feed_comments\s+for insert with check \(\s*user_id\s*=\s*auth\.uid\(\)\s*\)/i.test(SQL),
)

// ── Section C: db-init must match the canonical migration 022 policy set ───────
const mig022 = read('supabase/migrations/022_feed_comments.sql')
for (const p of FEED_POLICIES) {
  check(`migration 022 also defines "${p}"`, mig022.includes(`"${p}"`))
}

// ── Section D: fail-first witness ─────────────────────────────────────────────
// Reconstruct the pre-fix SQL (strip mb_feed_comments' RLS-enable + its policies)
// and prove the Section A/B guards would have caught it.
const preFix = SQL
  .replace(/alter table\s+mb_feed_comments\s+enable row level security;/gi, '')
  .replace(/create policy\s+"feed_comments_[^"]+"\s+on mb_feed_comments[\s\S]*?;/gi, '')
check('WITNESS: pre-fix SQL still creates mb_feed_comments', tablesCreated(preFix).includes('mb_feed_comments'))
check('WITNESS: pre-fix SQL has mb_feed_comments RLS OFF (guard would fire)', !rlsEnabled(preFix, 'mb_feed_comments'))
check('WITNESS: pre-fix SQL has NO mb_feed_comments policy (guard would fire)', !hasPolicy(preFix, 'mb_feed_comments'))

if (failures > 0) {
  console.error(`\ndb-init-rls: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\ndb-init-rls: all checks passed')
