#!/usr/bin/env node
// Contract test: /api/db-init's SCHEMA_SQL must not silently fall behind
// supabase/migrations/, and every statement in it must stay idempotent.
//
// Why this matters: SCHEMA_SQL is the advertised bootstrap for a mixBASE
// database. Nothing links it to the migration files, so it drifts by simply
// being forgotten — and it did: on 2026-08-15 it stopped at migration 027 while
// 028–032 existed, so a fresh environment came up without the UGC-moderation
// tables (App Store Guideline 1.2), without mb_visualizers.settings and without
// the five loudness columns. The runtime self-heal in src/lib/schema-heal.ts
// hides part of that class of gap, but only for plain column adds — it does
// nothing for policies, constraints or indexes, so the drift is real for
// everything that isn't a column.
//
// The rule below is deliberately an ACCOUNTING rule, not a diff. Every
// migration above the floor must be in exactly one of two states:
//   • carried  — SCHEMA_SQL contains every public-schema object it creates
//   • excluded — listed in EXCLUDED here, with a written reason
// Neither state → red (a new migration appeared and nobody decided). Both
// states → red (an exclusion went stale because the blob caught up). That is
// what makes a future 033 impossible to add silently: no comment, no marker and
// no good intentions can satisfy it, only the SQL itself or an explicit "no".
//
// Pure source-contract test — no DB / network. Run: node scripts/db-init-migration-parity-test.mjs

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')
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

const stripComments = (sql) => sql.replace(/--[^\n]*/g, '')

// Migrations at or below this number are the base schema and the hosted-project
// setup that db-init has never owned: `profiles`, `mb_usage` and the `sb_*`
// submission tables come from 006/007/013, and the storage BUCKETS are created
// by Step 2 of the route through the Storage API rather than from SQL. Holding
// the blob to those would demand it grow a copy of the whole database, which is
// a different (and much larger) decision than "don't fall behind".
const PARITY_FROM = 13

// Migrations above the floor that SCHEMA_SQL deliberately does NOT carry.
// Every entry needs a reason someone can argue with. An entry that the blob
// later catches up to is reported as stale, so this map cannot rot into a
// silent allow-list.
const EXCLUDED = {
  '014_visualizers.sql':
    'creates mb_visualizers + the mf-video bucket + storage.objects policies. The blob has never carried mb_visualizers (nor any storage DDL); pre-existing gap, not opened by the 028–032 catch-up.',
  '016_final_videos.sql':
    'raises the mf-video bucket ceiling via storage.buckets only — no public-schema object at all. schema-heal.ts (ensureVideoBucketLimit) runs the same statement at runtime.',
  '017_prc_hardening.sql':
    'policies on mb_visualizers and indexes on sb_curators / sb_submissions — all objects this blob does not create. Its mb_feedback half IS carried (the tightened public_feedback_insert).',
  '018_lock_down_public_rpc_execute.sql':
    'REVOKE/GRANT only, and half of it targets handle_new_user — a migration-006 function this blob never defines. The try_increment_usage half is carried inline with the function definition.',
  '021_profile_social_links.sql':
    'adds columns to public.profiles, a table this blob does not create; a bare ALTER against a missing relation would abort the whole bootstrap run. Healed at runtime by ensureProfileSocialColumns.',
  '023_activity_seen.sql':
    'same as 021 — a profiles column. Healed at runtime by ensureActivitySeenColumn.',
  '024_profiles_read_own_only.sql':
    'RLS + policies on public.profiles, which this blob does not create.',
  '028_storage_no_listing.sql':
    'UNAPPLIED and awaiting the owner sign-off, and it is destructive (drops the three live "Public read mf-*" policies; blast radius if the reasoning is wrong is "all audio playback stops"). db-init targets whatever NEXT_PUBLIC_SUPABASE_URL points at and staging shares production\'s Supabase project, so carrying it would apply a pending decision as a side effect of a bootstrap run.',
  '029_storage_authenticated_uploads.sql':
    'same posture as 028: unapplied, awaiting sign-off, needs a four-writer smoke test, and rewrites storage.objects RLS — which this blob has never owned.',
}

// Pull the multi-line `const SCHEMA_SQL = \`...\`` template literal out of source.
// The SQL body contains no backticks, so a non-greedy match to the first one is
// exact. (Keep it that way: an escaped backtick inside the blob would truncate
// this AND the extraction in db-init-rls-test.mjs.)
function schemaSql(src) {
  const m = src.match(/const SCHEMA_SQL\s*=\s*`([\s\S]*?)`/)
  return m ? m[1] : null
}

// Every public-schema object a chunk of SQL CREATES, as a comparable set of
// `kind:name` strings. Anything in the `storage` schema is dropped on the floor
// by construction — db-init creates buckets through the Storage API in Step 2
// of the route and carries no storage statement, which is exactly the line the
// 028/029 exclusions rest on (asserted separately below).
function artifacts(rawSql) {
  const sql = stripComments(rawSql)
  const found = []
  const add = (kind, name, target) => {
    if (target && target.startsWith('storage.')) return
    found.push(`${kind}:${name}`)
  }

  for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([\w.]+)/gi)) {
    add('table', m[1].toLowerCase(), m[1].toLowerCase())
  }
  // One pass per ALTER statement: its body carries both the added columns and
  // any named constraint (including the ones nested inside a do-block).
  for (const m of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?([\w.]+)([\s\S]*?);/gi)) {
    const table = m[1].toLowerCase()
    for (const c of m[2].matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?(\w+)/gi)) {
      add('column', `${table}.${c[1].toLowerCase()}`, table)
    }
    for (const c of m[2].matchAll(/add\s+constraint\s+(\w+)/gi)) {
      add('constraint', c[1].toLowerCase(), table)
    }
  }
  for (const m of sql.matchAll(/create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(\w+)/gi)) {
    add('index', m[1].toLowerCase())
  }
  // Policy names are quoted in most files and bare in others (029), so accept both.
  for (const m of sql.matchAll(/create\s+policy\s+(?:"([^"]+)"|(\w+))\s+on\s+(?:public\.)?([\w.]+)/gi)) {
    const table = m[3].toLowerCase()
    add('policy', `${table}.${(m[1] ?? m[2]).toLowerCase()}`, table)
  }
  for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?(\w+)/gi)) {
    add('function', m[1].toLowerCase())
  }
  return [...new Set(found)]
}

// One migration's verdict against a SCHEMA_SQL body.
//   carried — declares at least one public-schema object and the blob has all of them
//   partial — declares objects the blob is missing
//   empty   — declares no public-schema object at all (grants, storage-only, data fixes)
// `empty` never counts as carried: a migration the blob provably cannot express
// still has to be argued for in EXCLUDED rather than passing by default.
function coverage(schemaArtifacts, migrationSql) {
  const arts = artifacts(migrationSql)
  if (arts.length === 0) return { state: 'empty', missing: [] }
  const missing = arts.filter((a) => !schemaArtifacts.has(a))
  return { state: missing.length === 0 ? 'carried' : 'partial', missing }
}

// The accounting rule, as a pure function so the witnesses below can run the
// SAME rule against a mutated blob and a fabricated future migration.
function accountingProblems(schema, entries, excluded) {
  const have = new Set(artifacts(schema))
  const problems = []
  for (const { file, sql } of entries) {
    const { state, missing } = coverage(have, sql)
    const reason = excluded[file]
    if (reason && state === 'carried') {
      problems.push(`${file}: recorded as a deliberate exclusion, but SCHEMA_SQL now carries all of it — delete the exclusion`)
    } else if (!reason && state !== 'carried') {
      problems.push(
        `${file}: neither carried by SCHEMA_SQL nor a documented exclusion` +
        (missing.length ? ` — missing ${missing.join(', ')}` : ' (declares no public-schema object)'),
      )
    }
  }
  const known = new Set(entries.map((e) => e.file))
  for (const file of Object.keys(excluded)) {
    if (!known.has(file)) problems.push(`${file}: exclusion refers to a migration that is not above the floor (or no longer exists)`)
    else if (!excluded[file].trim()) problems.push(`${file}: exclusion has no reason`)
  }
  return problems
}

// Idempotency: this blob runs against databases that already hold some of these
// objects, so a single non-idempotent statement makes the second bootstrap run
// fail — and takes every statement after it down with it, since the Management
// API executes the whole body as one query.
function idempotencyProblems(rawSchema) {
  const sql = stripComments(rawSchema)
  const problems = []
  for (const m of sql.matchAll(/create\s+table\s+(?!if\s+not\s+exists)(\S+)/gi)) {
    problems.push(`create table ${m[1]} is not "if not exists"`)
  }
  for (const m of sql.matchAll(/create\s+(?:unique\s+)?index\s+(?!(?:concurrently\s+)?if\s+not\s+exists)(\S+)/gi)) {
    problems.push(`create index ${m[1]} is not "if not exists"`)
  }
  for (const m of sql.matchAll(/add\s+column\s+(?!if\s+not\s+exists)(\S+)/gi)) {
    problems.push(`add column ${m[1]} is not "if not exists"`)
  }
  for (const m of sql.matchAll(/create\s+function\s+(\S+)/gi)) {
    problems.push(`create function ${m[1]} is not "create or replace"`)
  }
  // CREATE POLICY has no IF NOT EXISTS, so each one needs a DROP ... IF EXISTS
  // ahead of it. Ahead, not merely present: a drop that lands after the create
  // deletes the policy it was meant to protect.
  for (const m of sql.matchAll(/create\s+policy\s+(?:"([^"]+)"|(\w+))\s+on\s+(?:public\.)?([\w.]+)/gi)) {
    const name = m[1] ?? m[2]
    const table = m[3]
    const drop = sql.search(new RegExp(`drop\\s+policy\\s+if\\s+exists\\s+"?${name}"?\\s+on\\s+(?:public\\.)?${table}\\b`, 'i'))
    if (drop === -1) problems.push(`policy "${name}" on ${table} has no "drop policy if exists"`)
    else if (drop > m.index) problems.push(`policy "${name}" on ${table} is dropped AFTER it is created`)
  }
  // ADD CONSTRAINT has no IF NOT EXISTS either; the house pattern is a do-block
  // that swallows duplicate_object.
  const guards = [...sql.matchAll(/do\s+\$\$([\s\S]*?)end\s*\$\$/gi)]
    .filter((g) => /duplicate_object/i.test(g[1]))
    .map((g) => [g.index, g.index + g[0].length])
  for (const m of sql.matchAll(/add\s+constraint\s+(\w+)/gi)) {
    if (!guards.some(([s, e]) => m.index > s && m.index < e)) {
      problems.push(`add constraint ${m[1]} is not inside a duplicate_object-guarded do block`)
    }
  }
  return problems
}

function readMigrations() {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ file: f, n: parseInt(f.slice(0, 3), 10) }))
    .filter((m) => Number.isFinite(m.n) && m.n > PARITY_FROM)
    .map((m) => ({ ...m, sql: readFileSync(join(MIGRATIONS, m.file), 'utf8') }))
}

console.log('db-init-migration-parity: SCHEMA_SQL must account for every migration\n')

const src = read('src/app/api/db-init/route.ts')
const SQL = schemaSql(src)
check('SCHEMA_SQL template literal found', SQL !== null)
if (SQL === null) {
  console.error('\ndb-init-migration-parity: could not locate SCHEMA_SQL — aborting')
  process.exit(1)
}

const entries = readMigrations()
check(`found migrations above ${String(PARITY_FROM).padStart(3, '0')}`, entries.length > 0, `${entries.length} files`)

// ── Section A: the accounting rule ────────────────────────────────────────────
const problems = accountingProblems(SQL, entries, EXCLUDED)
check('every migration above the floor is carried or explicitly excluded', problems.length === 0, problems.join(' | '))

// ── Section B: anti-vacuity anchors ───────────────────────────────────────────
// Pin the migrations this run folded in, so a later revert fails loudly instead
// of going quietly green, and pin the storage line the 028/029 call rests on.
const have = new Set(artifacts(SQL))
const FOLDED_IN = [
  '030_ugc_moderation.sql',
  '031_visualizer_recipes.sql',
  '032_version_loudness.sql',
  // 033 did not exist when this catch-up started; it landed mid-run and Section
  // A above is what caught it. Pinned here so that stays true.
  '033_visualizer_video_url_unique.sql',
]
for (const file of FOLDED_IN) {
  const entry = entries.find((e) => e.file === file)
  const verdict = entry ? coverage(have, entry.sql) : { state: 'absent', missing: ['file not found'] }
  check(`${file} is fully carried by SCHEMA_SQL`, verdict.state === 'carried', verdict.missing.join(', '))
}
check('SCHEMA_SQL carries no storage.objects statement', !/storage\.objects/i.test(stripComments(SQL)))
check('028 + 029 are recorded as deliberate exclusions',
  !!EXCLUDED['028_storage_no_listing.sql'] && !!EXCLUDED['029_storage_authenticated_uploads.sql'])
// The 027 policy is the last thing the pre-fix blob contained; if the new tail
// were dropped the anchors above would fire, but this keeps the older coverage
// honest too.
check('SCHEMA_SQL still carries the 027 library-tracks policy', have.has('policy:mb_library_tracks.users_own_library_tracks'))

// ── Section C: idempotency ────────────────────────────────────────────────────
const idem = idempotencyProblems(SQL)
check('every statement in SCHEMA_SQL is idempotent', idem.length === 0, idem.join(' | '))

// ── Section D: the mb_feedback policy must not out-rank its own migration ─────
// 017_prc_hardening tightened public_feedback_insert away from `with check
// (true)`, but the blob kept the permissive form — and its drop/create pair is
// unconditional, so running db-init against a hardened database REVERTED the
// hardening. Lock the tightened shape.
check('public_feedback_insert requires an existing version_id',
  /create policy\s+"public_feedback_insert"\s+on mb_feedback\s+for insert with check \(\s*version_id is not null\s+and exists\s*\(\s*select 1 from mb_versions/i.test(SQL))
check('public_feedback_insert is no longer "with check (true)"',
  !/create policy\s+"public_feedback_insert"\s+on mb_feedback\s+for insert with check \(\s*true\s*\)/i.test(SQL))
const prc = read('supabase/migrations/017_prc_hardening.sql')
check('migration 017_prc_hardening is the source of that shape', /EXISTS \(SELECT 1 FROM mb_versions v WHERE v\.id = version_id\)/i.test(prc))

// ── Section E: fail-first witnesses ───────────────────────────────────────────
// E1 — the real regression. Reconstruct the pre-fix blob by cutting everything
// from the 028/029 note onward (the 027 policy was its last statement) and run
// the SAME accounting rule against it.
console.log('\n  witness: the pre-fix SCHEMA_SQL (stopped at migration 027)')
{
  const cut = SQL.indexOf('-- ── 028 + 029')
  check('witness: located the pre-fix cut point', cut > 0)
  const preFix = cut > 0 ? SQL.slice(0, cut) : SQL
  const preProblems = accountingProblems(preFix, entries, EXCLUDED)
  for (const file of FOLDED_IN) {
    check(`witness: rule reports ${file} unaccounted for on the pre-fix blob`,
      preProblems.some((p) => p.startsWith(file)))
  }
  check('witness: the same rule is clean on the current blob', accountingProblems(SQL, entries, EXCLUDED).length === 0)
}

// E2 — a FUTURE migration. The whole point of the rule is that 033 cannot land
// unnoticed, so fabricate one (a named unique constraint, the shape flagged as
// likely) and prove the rule catches it while nothing else in the suite would.
console.log('\n  witness: a future migration appears and is not folded in')
{
  const fake = {
    file: '033_fabricated_for_this_test.sql',
    n: 33,
    sql: 'alter table mb_projects add constraint mb_projects_user_title_uniq unique (user_id, title);\n' +
         'create index if not exists idx_fabricated_for_this_test on mb_projects(user_id);',
  }
  check('witness: the fabricated migration declares objects the blob lacks',
    coverage(new Set(artifacts(SQL)), fake.sql).state === 'partial')
  const withFake = accountingProblems(SQL, [...entries, fake], EXCLUDED)
  check('witness: rule reports the unaccounted 033', withFake.some((p) => p.startsWith(fake.file)))
  // …and that adding it to EXCLUDED is a real decision, not a rubber stamp:
  // an exclusion with an empty reason is rejected.
  const rubberStamped = accountingProblems(SQL, [...entries, fake], { ...EXCLUDED, [fake.file]: '   ' })
  check('witness: a reasonless exclusion is still reported', rubberStamped.some((p) => p.startsWith(fake.file)))
}

// E3 — the idempotency rule itself.
console.log('\n  witness: the idempotency rule goes red on a non-idempotent statement')
{
  const bareTable = SQL.replace('create table if not exists mb_content_reports', 'create table mb_content_reports')
  check('witness: stubbing actually changed the source', bareTable !== SQL)
  check('witness: rule reports the bare create table', idempotencyProblems(bareTable).some((p) => /create table/.test(p)))
  const orphanPolicy = SQL.replace('drop policy if exists "user_blocks_server_only" on mb_user_blocks;', '')
  check('witness: rule reports a policy created without a drop',
    idempotencyProblems(orphanPolicy).some((p) => /user_blocks_server_only/.test(p)))
  const bareConstraint = SQL.replace(/do \$\$ begin\n(\s*alter table public\.mb_usage)/, '$1')
  check('witness: rule reports an unguarded add constraint',
    idempotencyProblems(bareConstraint).some((p) => /add constraint/.test(p)))
  check('witness: the same rule is clean on the current blob', idempotencyProblems(SQL).length === 0)
}

if (failures > 0) {
  console.error(`\ndb-init-migration-parity: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\ndb-init-migration-parity: all checks passed')
