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
    'REFUTED, not merely unapplied. These exact three DROP POLICY statements ran in production on 2026-07-11 as restrict_public_bucket_listing and were rolled back on 2026-07-12: dropping the SELECT policies broke UPLOADS, because Supabase\'s upload does INSERT ... RETURNING and the RETURNING read needs SELECT. Its statements are commented out at the source and the file is kept only as the record of a refuted approach, so there is no DDL left to carry.',
  '029_storage_authenticated_uploads.sql':
    'same posture as 028: unapplied, awaiting sign-off, needs a four-writer smoke test, and rewrites storage.objects RLS — which this blob has never owned.',
  '036_profiles_column_privileges.sql':
    'REVOKE/GRANT only, on public.profiles — the same two grounds 018 (privilege-only) and 021/023/024 (profiles is a migration-006 table this blob never creates) already rest on. A bare REVOKE against a missing relation would abort the whole bootstrap run. Note the consequence honestly: db-init alone does not close this privilege hole on a fresh project, but db-init alone cannot stand up profiles either — a fresh environment needs the numbered migrations regardless, and 006 and 036 are both in that set.',
  '037_feedback_drop_anon_insert.sql':
    'DROP POLICY only, on public.mb_feedback — no object is declared, so there is nothing for SCHEMA_SQL to carry. Same privilege-only ground as 018 and 036. The policy it drops (017 public_feedback_insert) is not in SCHEMA_SQL either, so a fresh bootstrap never creates the hole this removes and the two stay consistent: nothing to create, nothing to drop.',
  '038_storage_scope_uploads_to_owner.sql':
    'Documentation only — every statement is commented out, and it targets storage.objects, which lives in the storage schema this blob does not own (same ground as the 028/029 exclusions). Marked DO NOT APPLY YET: the scoping predicate it describes would break every iOS upload until the iOS storage key is folded, since a flat root key has a NULL first path segment.',
  '034_mix_master_status.sql':
    'a data fix (UPDATE of retired WIP/Mix-Master statuses) plus an ALTER COLUMN SET DEFAULT — no object this parser accounts for. The new default IS carried: the blob\'s mb_versions create table says default \'Mix\', so a fresh bootstrap never mints a retired status, and there is no old data in a fresh database to retrofit.',
  '039_drop_unused_tables.sql':
    'DROP TABLE only — no object is declared, so there is nothing for SCHEMA_SQL to carry. Same ground as 037 (drop-only), and the two halves stay consistent for the same reason: none of the seven tables is created by any migration in this repo (they are untracked pre-ledger schema) and SCHEMA_SQL has never carried one of them, so a fresh bootstrap never creates what this drops. Note the consequence honestly, as the migration header does: migration 006 runs UNGUARDED enable-RLS/create-policy against five of the seven, so once this is applied 006 can no longer be replayed from scratch. That does not touch a fresh bootstrap (this blob does not run 006) but it does mean the numbered-migration replay path loses a step.',
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

// ─────────────────────────────────────────────────────────────────────────────
// BODY PARITY — what the object-name accounting above cannot see.
//
// `artifacts()` answers "does the blob create a thing by this name". That is a
// real question, and it caught a five-migration gap. It is also blind to the
// thing's CONTENTS: SCHEMA_SQL could carry `create table mb_content_reports`
// with the `unique (reporter_id, content_type, content_id)` line deleted and
// every check above would stay green — while POST /api/feed/report, whose
// upsert names exactly those three columns in `onConflict`, dies at runtime with
// PostgreSQL 42P10 ("no unique or exclusion constraint matching the ON CONFLICT
// specification"). Same shape for /api/feed/block and its (blocker_id,
// blocked_id) pair. That was demonstrated against this file, not assumed.
//
// So the rules below compare BODIES. The comparison is fact-based rather than
// textual, for a reason that matters more than it sounds: SCHEMA_SQL is
// explicitly NOT a verbatim copy of the migrations. It reorders statements,
// rewrites their comments, wraps 031/033 in `if exists` / `to_regclass` guards
// the migration files do not have, and adds an explicit deny-all policy where
// 030 relies on "RLS on, no policies". A textual diff would scream on every one
// of those and get switched off within a week. Instead each side is reduced to a
// set of normalized assertions — "this column is NOT NULL", "these columns are
// UNIQUE together", "this policy's USING predicate is X" — and the rule is a
// SUBSET test: every fact a carried migration states must also be stated by the
// blob. Whitespace, indentation, case, comments and `public.` prefixes are
// normalized away first, and a witness at the bottom reformats the blob beyond
// recognition to prove the rule does not cry wolf over any of it.

// Comment-stripper that respects single-quoted literals, so a '--' inside a
// string is not mistaken for the start of a comment. (The older stripComments
// above is left alone: the sections that use it are working and mutation-tested,
// and swapping their input is a change with no upside.)
function stripSqlComments(sql) {
  let out = ''
  let i = 0
  while (i < sql.length) {
    if (sql[i] === "'") {
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue }
          j++; break
        }
        j++
      }
      out += sql.slice(i, j); i = j; continue
    }
    const two = sql.slice(i, i + 2)
    if (two === '--') { const nl = sql.indexOf('\n', i); i = nl === -1 ? sql.length : nl; out += ' '; continue }
    if (two === '/*') { const e = sql.indexOf('*/', i + 2); i = e === -1 ? sql.length : e + 2; out += ' '; continue }
    out += sql[i]; i++
  }
  return out
}

// Canonical form of a SQL fragment: case-folded, whitespace-collapsed, spaces
// dropped around every non-word character, `public.` removed. String literals
// are lifted out first so their case and spacing survive ('WIP' must not
// silently equal 'wip' — a default value is data, not syntax).
function norm(s) {
  const lits = []
  let out = String(s).replace(/'(?:[^']|'')*'/g, (m) => `${lits.push(m) - 1}`)
  out = out
    .toLowerCase()
    .replace(/\bpublic\s*\./g, '')
    .replace(/\s+/g, ' ')
    .replace(/ ?([^\w ]) ?/g, '$1')
    .trim()
  return out.replace(/(\d+)/g, (_, i) => lits[Number(i)])
}

// Spellings Postgres treats as the same type. Deliberately short: only pairs
// that are genuinely interchangeable, so a real type change stays visible.
const TYPE_ALIASES = {
  int: 'integer', int2: 'smallint', int4: 'integer', int8: 'bigint',
  bool: 'boolean', float4: 'real', float8: 'double precision',
  'timestamp with time zone': 'timestamptz', 'timestamp without time zone': 'timestamp',
}
const normType = (t) => { const n = norm(t); return TYPE_ALIASES[n] ?? n }

// Slice of the balanced parenthesis group whose '(' is at `open`.
function balanced(s, open) {
  let d = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === "'") { i++; while (i < s.length && s[i] !== "'") i++; continue }
    if (s[i] === '(') d++
    else if (s[i] === ')') { d--; if (d === 0) return { inner: s.slice(open + 1, i), end: i } }
  }
  return null
}

// Split on commas at paren-depth 0 — i.e. into a table's column/constraint items
// without cutting `check (a in ('x','y'))` or `numeric(10,2)` in half.
function splitTop(s) {
  const parts = []
  let d = 0
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === "'") { cur += c; i++; while (i < s.length && s[i] !== "'") cur += s[i++]; cur += "'"; continue }
    if (c === '(') d++
    if (c === ')') d--
    if (c === ',' && d === 0) { parts.push(cur); cur = ''; continue }
    cur += c
  }
  if (cur.trim()) parts.push(cur)
  return parts.map((p) => p.trim()).filter(Boolean)
}

// First depth-0 occurrence of `re`. Depth matters: the `unique` inside
// `check (kind in ('unique'))` is not a UNIQUE constraint.
function findTop(s, re) {
  let d = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === "'") { i++; while (i < s.length && s[i] !== "'") i++; continue }
    if (c === '(') { d++; continue }
    if (c === ')') { d--; continue }
    if (d === 0 && re.test(s.slice(i)) && s.slice(i).match(re).index === 0) return i
  }
  return -1
}

// Where a column's type ends and its modifiers begin.
const MODIFIER = /^(not\s+null|null|default|unique|primary\s+key|references|check|generated|collate|constraint)\b/i

function referenceFact(table, col, rest, out) {
  const m = rest.match(/\breferences\s+([\w."]+)\s*(\()?/i)
  if (!m) return
  let target = norm(m[1])
  let targetCol = ''
  if (m[2]) {
    const b = balanced(rest, rest.indexOf('(', m.index))
    if (b) targetCol = norm(b.inner)
  }
  const del = rest.match(/\bon\s+delete\s+(cascade|set\s+null|set\s+default|restrict|no\s+action)/i)
  out.add(`fk ${table}.${col} -> ${target}(${targetCol})${del ? ` on delete ${norm(del[1])}` : ''}`)
}

// One column definition → its type, nullability, default, inline constraints.
function columnFacts(table, item, out) {
  const m = item.match(/^\s*"?([\w]+)"?\s*([\s\S]*)$/)
  if (!m) return
  const name = norm(m[1])
  const rest = m[2].trim()
  const modAt = findTop(rest, MODIFIER)
  const type = normType(modAt === -1 ? rest : rest.slice(0, modAt))
  if (type) out.add(`col ${table}.${name} ${type}`)
  if (findTop(rest, /^not\s+null\b/i) !== -1) out.add(`notnull ${table}.${name}`)
  if (findTop(rest, /^unique\b/i) !== -1) out.add(`unique ${table}(${name})`)
  if (findTop(rest, /^primary\s+key\b/i) !== -1) out.add(`pk ${table}(${name})`)
  const dAt = findTop(rest, /^default\b/i)
  if (dAt !== -1) {
    let expr = rest.slice(dAt + 'default'.length)
    const nxt = findTop(expr, /^(not\s+null|unique|primary\s+key|references|check|collate)\b/i)
    if (nxt !== -1) expr = expr.slice(0, nxt)
    out.add(`default ${table}.${name}=${norm(expr)}`)
  }
  const cAt = findTop(rest, /^check\s*\(/i)
  if (cAt !== -1) {
    const b = balanced(rest, rest.indexOf('(', cAt))
    if (b) out.add(`check ${table} ${norm(b.inner)}`)
  }
  referenceFact(table, name, rest, out)
}

// A table-level constraint item (with or without a `constraint <name>` prefix —
// the name itself is already accounted for by artifacts()).
function tableConstraintFacts(table, item, out) {
  const s = item.replace(/^\s*constraint\s+"?[\w]+"?\s*/i, '')
  const open = s.indexOf('(')
  if (/^\s*unique\s*\(/i.test(s)) {
    const b = balanced(s, open); if (b) out.add(`unique ${table}(${norm(b.inner)})`)
    return true
  }
  if (/^\s*primary\s+key\s*\(/i.test(s)) {
    const b = balanced(s, open); if (b) out.add(`pk ${table}(${norm(b.inner)})`)
    return true
  }
  if (/^\s*check\s*\(/i.test(s)) {
    const b = balanced(s, open); if (b) out.add(`check ${table} ${norm(b.inner)}`)
    return true
  }
  if (/^\s*foreign\s+key\s*\(/i.test(s)) {
    const b = balanced(s, open)
    if (b) referenceFact(table, norm(b.inner), s.slice(b.end), out)
    return true
  }
  return false
}

const TABLE_CONSTRAINT = /^\s*(constraint\s+"?[\w]+"?\s+)?(unique|primary\s+key|check|foreign\s+key|exclude)\b/i

// Every runtime-visible assertion a chunk of SQL makes, as a comparable set.
// Storage-schema objects are dropped here for the same reason artifacts() drops
// them — see the 028/029 exclusions.
function facts(rawSql) {
  const sql = stripSqlComments(rawSql)
  const out = new Set()

  for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([\w."]+)\s*\(/gi)) {
    const table = norm(m[1])
    if (table.startsWith('storage.')) continue
    const b = balanced(sql, m.index + m[0].length - 1)
    if (!b) continue
    for (const item of splitTop(b.inner)) {
      if (TABLE_CONSTRAINT.test(item) && tableConstraintFacts(table, item, out)) continue
      columnFacts(table, item, out)
    }
  }

  for (const m of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([\w."]+)([\s\S]*?);/gi)) {
    const table = norm(m[1])
    if (table.startsWith('storage.')) continue
    const body = m[2]
    for (const c of body.matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?/gi)) {
      const tail = body.slice(c.index + c[0].length)
      columnFacts(table, splitTop(tail)[0] ?? tail, out)
    }
    for (const c of body.matchAll(/add\s+constraint\s+"?[\w]+"?\s*/gi)) {
      tableConstraintFacts(table, body.slice(c.index + c[0].length), out)
    }
  }

  // Index SHAPE, not just its name: a unique index quietly downgraded to a plain
  // one, or one column dropped from its list, keeps the name the accounting rule
  // matches on.
  for (const m of sql.matchAll(/create\s+(unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?"?[\w]+"?\s+on\s+([\w."]+)\s*\(/gi)) {
    const table = norm(m[2])
    if (table.startsWith('storage.')) continue
    const b = balanced(sql, m.index + m[0].length - 1)
    if (!b) continue
    out.add(`index${m[1] ? ' unique' : ''} ${table}(${norm(b.inner)})`)
  }

  // Policy PREDICATES. `using (false)` and `using (true)` are the same policy by
  // name and opposite policies in effect.
  for (const m of sql.matchAll(/create\s+policy\s+(?:"([^"]+)"|(\w+))\s+on\s+([\w."]+)([\s\S]*?);/gi)) {
    const table = norm(m[3])
    if (table.startsWith('storage.')) continue
    const body = m[4]
    const cmd = (body.match(/\bfor\s+(all|select|insert|update|delete)\b/i)?.[1] ?? 'all').toLowerCase()
    let using = ''
    let check = ''
    // normPredicate, not norm: `=` is commutative, and different migrations
    // genuinely write the same policy with the operands in either order.
    const uAt = body.search(/\busing\s*\(/i)
    if (uAt !== -1) { const b = balanced(body, body.indexOf('(', uAt)); if (b) using = normPredicate(b.inner) }
    const cAt = body.search(/\bwith\s+check\s*\(/i)
    if (cAt !== -1) { const b = balanced(body, body.indexOf('(', cAt)); if (b) check = normPredicate(b.inner) }
    out.add(`policy ${table}.${norm(m[1] ?? m[2])} for=${cmd} using=${using} check=${check}`)
  }

  // Function signature + body. try_increment_usage is the tier-limit enforcement
  // point; "a function by that name exists" is not the property that matters.
  for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+([\w."]+)\s*\(/gi)) {
    const b = balanced(sql, m.index + m[0].length - 1)
    if (!b) continue
    const open = sql.indexOf('$$', b.end)
    const close = open === -1 ? -1 : sql.indexOf('$$', open + 2)
    const head = open === -1 ? sql.slice(b.end + 1) : sql.slice(b.end + 1, open)
    const body = close === -1 ? '' : sql.slice(open + 2, close)
    out.add(`function ${norm(m[1])}(${norm(b.inner)}) ${norm(head)} :: ${norm(body)}`)
  }

  return out
}

// Final RLS state per table — LAST statement wins, because that is what the
// database ends up with. SCHEMA_SQL genuinely disables RLS on several tables
// early and re-enables them later; only the end state is a fact about the
// bootstrapped database, and a stray `disable` appended at the tail would leave
// a table world-readable through the anon key with every name-level check green.
function rlsFinalState(rawSql) {
  const state = new Map()
  for (const m of stripSqlComments(rawSql)
    .matchAll(/alter\s+table\s+(?:if\s+exists\s+)?([\w."]+)\s+(enable|disable)\s+row\s+level\s+security/gi)) {
    const t = norm(m[1])
    if (!t.startsWith('storage.')) state.set(t, m[2].toLowerCase())
  }
  return state
}

// The body rule, pure so the witnesses can run it against a mutated blob.
// Scope: migrations Section A already classifies as the blob's responsibility —
// i.e. everything above the floor that is NOT a documented exclusion. Excluded
// migrations are skipped entirely, which is what keeps 028/029 (and 014/016/017-
// hardening/018/021/023/024) exactly as deliberate as they were before.
function bodyProblems(schema, entries, excluded) {
  const have = facts(schema)
  const haveRls = rlsFinalState(schema)
  const problems = []
  for (const { file, sql } of entries) {
    if (excluded[file]) continue
    for (const f of [...facts(sql)].sort()) {
      if (!have.has(f)) problems.push(`${file}: SCHEMA_SQL does not state — ${f}`)
    }
    for (const [table, want] of rlsFinalState(sql)) {
      const got = haveRls.get(table)
      if (got !== want) {
        problems.push(`${file}: RLS on ${table} should end ${want}d in SCHEMA_SQL, got ${got ? `${got}d` : 'no statement at all'}`)
      }
    }
  }
  return problems
}

// Body facts with no migration above the floor to derive them from, pinned by
// hand because they are load-bearing at runtime. Two sources feed this list:
//
//   • the base schema (migrations 001–013, below PARITY_FROM). Those files are
//     out of scope for the accounting rule for good reasons — 004 and 005 have
//     genuinely diverged from the blob, so fact-checking them wholesale WOULD
//     cry wolf — but a handful of their assertions still decide whether the app
//     works, and nothing else in this suite would notice them going missing.
//   • the two ON CONFLICT targets. 030 covers them today; pinning them means the
//     guard survives an edit to the migration file itself, which is the one
//     thing a migration-relative subset test can never catch.
//
// Each entry names the code that breaks when the fact goes away.
const CRITICAL_FACTS = {
  'unique mb_content_reports(reporter_id,content_type,content_id)':
    "POST /api/feed/report upserts with onConflict: 'reporter_id,content_type,content_id'. Without the constraint every report request fails with 42P10 — the exact regression that motivated this section.",
  'unique mb_user_blocks(blocker_id,blocked_id)':
    "POST /api/feed/block upserts with onConflict: 'blocker_id,blocked_id'. Same 42P10 failure mode.",
  'notnull mb_versions.audio_url':
    'a version row with no audio has nothing to play, seek or measure; every player path dereferences it.',
  'fk mb_versions.project_id -> mb_projects(id) on delete cascade':
    'deleting a project must take its versions with it. Downgraded to SET NULL, orphaned versions survive with no owner — and no RLS policy matches them, so they become invisible AND undeletable.',
  'unique mb_versions(share_token)':
    '/share/[token] resolves one version by token. Duplicates make the lookup non-deterministic.',
  'unique mb_projects(share_token)': '/share project links resolve by this token (migration 012).',
  'unique mb_collections(share_token)': '/share/album/<token> resolves by this token (migration 019).',
  'index unique mb_versions(project_id,version_number)':
    'migration 017 renumbers versions and relies on this to stop two v3 rows appearing under one project.',
  'check mb_feedback rating>=1 and rating<=5':
    'the share page renders the rating as stars; an out-of-range value from a forged PostgREST insert breaks the UI.',
  'fk mb_feed_comments.version_id -> mb_versions(id) on delete cascade':
    'a deleted mix must take its feed comments with it, or /feed renders comments against a missing track.',
  'col mb_activity.user_id uuid':
    'migration 006 adds it and every activity insert in the app writes it (/api/projects, /api/versions, /api/feedback, /api/releases). Without the column a db-init-bootstrapped database rejects every activity write with PGRST204 — and the users_own_activity policy, which reads user_id, fails to create and aborts the whole bootstrap.',
}

// ─────────────────────────────────────────────────────────────────────────────
// SUPERSEDED DEFINITIONS — "carried" must mean "matches the LATEST definition".
//
// The subset rule above compares SCHEMA_SQL against each migration file
// independently, which has a hole: when several migrations define the SAME
// object, matching ANY of them passes. Policies are redefined constantly here —
// 005 → 006 → 017_prc_hardening all rewrite the same policy names — so "matches
// some migration" is a much weaker claim than it reads as.
//
// It was not hypothetical. SCHEMA_SQL carried migration 005's definition of
// users_own_activity, which 006 superseded and which production actually runs.
// Because the blob's `drop policy if exists` / `create policy` pair is
// unconditional, a single db-init run against production would have replaced the
// live 006 policy with the older 005 one — a genuine weakening, since the 005
// predicate constrains only project_id and never mentions the row's own user_id.
//
// This rule reads ALL migrations (including below PARITY_FROM — supersession
// does not respect the floor: 006 is the authority here and it is migration 6),
// takes the last definition of each policy in filename order, and requires
// SCHEMA_SQL to match it. It is scoped to policies SCHEMA_SQL actually creates,
// so it never demands the blob grow policies it deliberately does not own.

// Predicate normalization that additionally knows `=` is commutative, so
// `auth.uid() = user_id` and `user_id = auth.uid()` — which appear in different
// migrations for the same policy — are correctly read as the SAME predicate.
// Without this the rule would flag four harmless policies and get switched off.
// It is deliberately narrow: only a whole predicate of the form `a = b`, with no
// spaces left in either operand after normalization.
function normPredicate(s) {
  const n = norm(s)
  const m = n.match(/^([\w.()]+)=([\w.()]+)$/)
  return m ? [m[1], m[2]].sort().join('=') : n
}

// policy key → normalized definition, for one chunk of SQL.
function policyDefs(rawSql) {
  const sql = stripSqlComments(rawSql)
  const out = new Map()
  for (const m of sql.matchAll(/create\s+policy\s+(?:"([^"]+)"|(\w+))\s+on\s+([\w."]+)([\s\S]*?);/gi)) {
    const table = norm(m[3])
    if (table.startsWith('storage.')) continue
    const body = m[4]
    const cmd = (body.match(/\bfor\s+(all|select|insert|update|delete)\b/i)?.[1] ?? 'all').toLowerCase()
    let using = ''
    let check = ''
    const uAt = body.search(/\busing\s*\(/i)
    if (uAt !== -1) { const b = balanced(body, body.indexOf('(', uAt)); if (b) using = normPredicate(b.inner) }
    const cAt = body.search(/\bwith\s+check\s*\(/i)
    if (cAt !== -1) { const b = balanced(body, body.indexOf('(', cAt)); if (b) check = normPredicate(b.inner) }
    out.set(`${table}.${norm(m[1] ?? m[2])}`, `for=${cmd} using=${using} check=${check}`)
  }
  return out
}

// Last writer wins, in filename order.
function latestPolicyDefs(allMigrations) {
  const latest = new Map()
  for (const { file, sql } of allMigrations) {
    for (const [key, def] of policyDefs(sql)) latest.set(key, { file, def })
  }
  return latest
}

function supersededPolicyProblems(schema, allMigrations) {
  const latest = latestPolicyDefs(allMigrations)
  const problems = []
  for (const [key, def] of policyDefs(schema)) {
    const win = latest.get(key)
    // No migration defines it → SCHEMA_SQL is the sole author. That is true and
    // intentional for the two 030 deny-all policies, whose reasoning is written
    // out in route.ts; nothing to compare against.
    if (!win) continue
    if (win.def !== def) {
      problems.push(`${key}: SCHEMA_SQL carries a definition that ${win.file} superseded — blob has [${def}], ${win.file} has [${win.def}]`)
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

// Every migration, floor included — supersession does not respect PARITY_FROM.
function readAllMigrations() {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => ({ file, sql: readFileSync(join(MIGRATIONS, file), 'utf8') }))
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

// ── Section F: body parity ────────────────────────────────────────────────────
// Names are Section A's job. This is the contents.
const bodies = bodyProblems(SQL, entries, EXCLUDED)
check('every carried migration\'s SQL body is fully stated by SCHEMA_SQL', bodies.length === 0, bodies.join(' | '))

const haveFacts = facts(SQL)
for (const [fact, why] of Object.entries(CRITICAL_FACTS)) {
  check(`SCHEMA_SQL states: ${fact}`, haveFacts.has(fact), haveFacts.has(fact) ? '' : why)
}

// ── Section G: fail-first witnesses for the body rule ─────────────────────────
// Same discipline as Section E: break the blob in-process, prove the rule goes
// red, and — where it is the whole point — prove the OLD name-only rule stays
// green through the same break.
console.log('\n  witness: body drift the name-level accounting cannot see')
{
  // Each entry mutates SCHEMA_SQL and names the fact that must go missing.
  const mutations = [
    ['unique constraint deleted (the 42P10 regression)',
      (s) => s.replace(',\n  unique (reporter_id, content_type, content_id)\n', '\n'),
      /unique mb_content_reports/],
    ['NOT NULL dropped from a column',
      (s) => s.replace('reporter_id uuid not null references auth.users(id)', 'reporter_id uuid references auth.users(id)'),
      /notnull mb_content_reports\.reporter_id/],
    ['foreign key on-delete weakened',
      (s) => s.replace('version_id uuid not null references mb_versions(id) on delete cascade',
                       'version_id uuid not null references mb_versions(id) on delete set null'),
      /fk mb_feed_comments\.version_id/],
    ['column default changed',
      (s) => s.replace("release_type     text not null default 'single'", "release_type     text not null default 'album'"),
      /default mb_releases\.release_type/],
    ['column type changed',
      (s) => s.replace('add column if not exists loudness_lufs            real', 'add column if not exists loudness_lufs            text'),
      /col mb_versions\.loudness_lufs real/],
    ['RLS policy predicate weakened to a blanket allow',
      (s) => s.replace('for insert with check (user_id = auth.uid());', 'for insert with check (true);'),
      /policy mb_feed_comments\.feed_comments_insert_own/],
    ['unique index quietly downgraded to a plain one',
      (s) => s.replace('create unique index if not exists mb_visualizers_video_url_uidx', 'create index if not exists mb_visualizers_video_url_uidx'),
      /index unique mb_visualizers/],
    ['a column dropped from an index',
      (s) => s.replace('on mb_library_tracks(user_id, isrc)', 'on mb_library_tracks(user_id)'),
      /index mb_library_tracks\(user_id,isrc\)/],
    ['the tier-limit function body gutted',
      (s) => s.replace('if v_used >= p_limit then', 'if false then'),
      /function try_increment_usage/],
    ['RLS switched back off at the tail',
      (s) => `${s}\nalter table mb_feed_comments disable row level security;\n`,
      /RLS on mb_feed_comments should end enabled/],
  ]
  for (const [label, mutate, expect] of mutations) {
    const broken = mutate(SQL)
    check(`witness: the "${label}" mutation actually changed SCHEMA_SQL`, broken !== SQL)
    const found = bodyProblems(broken, entries, EXCLUDED)
    check(`witness: body rule goes red on ${label}`, found.some((p) => expect.test(p)),
      found.length ? found.slice(0, 2).join(' | ') : 'rule reported NOTHING')
  }

  // The load-bearing contrast: the pre-existing name-level rules sail straight
  // through the two mutations that keep every object name intact. If this ever
  // fails, Section F has stopped being the thing that catches them.
  const gutted = SQL.replace(',\n  unique (reporter_id, content_type, content_id)\n', '\n')
  check('witness: the gutted-unique blob still passes the NAME-level accounting rule',
    accountingProblems(gutted, entries, EXCLUDED).length === 0)
  check('witness: the gutted-unique blob still passes the idempotency rule',
    idempotencyProblems(gutted).length === 0)
  const downgraded = SQL.replace('create unique index if not exists mb_visualizers_video_url_uidx', 'create index if not exists mb_visualizers_video_url_uidx')
  check('witness: the downgraded-index blob still passes the NAME-level accounting rule',
    accountingProblems(downgraded, entries, EXCLUDED).length === 0)

  // …and a CRITICAL_FACTS anchor fires for the same break, independent of
  // whether migration 030 still declares it.
  check('witness: the CRITICAL_FACTS anchor also fires on the gutted unique',
    !facts(gutted).has('unique mb_content_reports(reporter_id,content_type,content_id)'))
}

// G-last — the anti-wolf witness. A rule that flags harmless reformatting gets
// deleted, and then the gap above is back with interest. Reformat SCHEMA_SQL as
// brutally as a human plausibly might — collapse a table onto one line, re-indent
// everything, uppercase the keywords, inject comments, add a `public.` prefix,
// blank lines — and require the body rule to stay SILENT.
console.log('\n  witness: harmless reformatting does NOT go red')
{
  const reformatted = SQL
    .replace(
      /create table if not exists mb_content_reports \([\s\S]*?\n\);/,
      "CREATE TABLE IF NOT EXISTS public.mb_content_reports ( id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reporter_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE, content_type text NOT NULL CHECK (content_type IN ('version', 'comment')), content_id uuid NOT NULL, reason text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (reporter_id, content_type, content_id) ); -- reflowed onto one line",
    )
    .replace(
      'create policy "feed_comments_read_authenticated" on mb_feed_comments\n  for select using (auth.uid() is not null);',
      '/* block comment */\nCREATE POLICY "feed_comments_read_authenticated"\n\tON public.mb_feed_comments\n\tFOR SELECT\n\tUSING (   auth.uid()   IS NOT NULL   );   -- trailing note',
    )
    .replace(
      'alter table mb_versions add column if not exists loudness_lufs            real;',
      'ALTER TABLE public.mb_versions\n\n  ADD COLUMN IF NOT EXISTS loudness_lufs float4;   -- float4 is the same type as real',
    )
  check('witness: the reformatting actually changed SCHEMA_SQL', reformatted !== SQL)
  // Set equality, not just size: reformatting must leave the fact set IDENTICAL.
  // This is what proves the normalizer earns its keep — with normalization
  // removed, every reflowed statement reads as a different fact and this fires.
  const after = facts(reformatted)
  const drifted = [...after].filter((f) => !haveFacts.has(f)).concat([...haveFacts].filter((f) => !after.has(f)))
  check('witness: reformatting alone changed no fact', drifted.length === 0, drifted.slice(0, 3).join(' | '))
  const noise = bodyProblems(reformatted, entries, EXCLUDED)
  check('witness: body rule stays silent through reformatting', noise.length === 0, noise.join(' | '))
  check('witness: the same rule is clean on the current blob', bodyProblems(SQL, entries, EXCLUDED).length === 0)
}

// ── Section H: no policy may carry a superseded definition ────────────────────
const allMigrations = readAllMigrations()
check('all migrations readable for the supersession rule', allMigrations.length > entries.length,
  `${allMigrations.length} total, ${entries.length} above the floor`)

const superseded = supersededPolicyProblems(SQL, allMigrations)
check('no SCHEMA_SQL policy carries a definition a later migration superseded',
  superseded.length === 0, superseded.join(' | '))

// The specific one this rule was built for, pinned so a revert is loud.
check('users_own_activity carries migration 006\'s predicate, not 005\'s',
  facts(SQL).has('policy mb_activity.users_own_activity for=all using=auth.uid()=user_id check=auth.uid()=user_id'))
check('migration 006 is the source of that shape',
  /create policy "users_own_activity" on mb_activity\s+for all using \(user_id = auth\.uid\(\)\)/i
    .test(read('supabase/migrations/006_multi_user_auth.sql')))
check('migration 005 is the superseded source it must NOT match',
  /CREATE POLICY "users_own_activity" ON mb_activity\s+USING \(\s*project_id IN/i
    .test(read('supabase/migrations/005_multi_user.sql')))

console.log('\n  witness: the supersession rule')
{
  // H1 — the exact pre-fix blob. Put migration 005's predicate back and prove
  // the rule fires. This is the drift that was LIVE in this file, not a
  // fabricated one, so it is the strongest witness in this suite.
  const preFix = SQL.replace(
    'create policy "users_own_activity" on mb_activity\n  using (user_id = auth.uid()) with check (user_id = auth.uid());',
    'create policy "users_own_activity" on mb_activity\n' +
    '  using (project_id in (select id from mb_projects where user_id = auth.uid()))\n' +
    '  with check (project_id in (select id from mb_projects where user_id = auth.uid()));',
  )
  check('witness: reconstructed the pre-fix users_own_activity', preFix !== SQL)
  const found = supersededPolicyProblems(preFix, allMigrations)
  check('witness: rule reports the superseded users_own_activity',
    found.some((p) => p.startsWith('mb_activity.users_own_activity')), found.join(' | ') || 'rule reported NOTHING')
  check('witness: and it names 006 as the authority', found.some((p) => p.includes('006_multi_user_auth.sql')))

  // The load-bearing contrast, exactly as for the body rule: every pre-existing
  // check sails straight through the pre-fix policy, because the object name
  // never changed.
  check('witness: the pre-fix blob still passes the NAME-level accounting rule',
    accountingProblems(preFix, entries, EXCLUDED).length === 0)
  check('witness: the pre-fix blob still passes the idempotency rule', idempotencyProblems(preFix).length === 0)
  check('witness: the pre-fix blob still passes the body-subset rule',
    bodyProblems(preFix, entries, EXCLUDED).length === 0)

  // H2 — normalization must NOT paper over the difference. Compare the two
  // predicates directly rather than trusting that the rule above proves it.
  const p005 = normPredicate('project_id in (select id from mb_projects where user_id = auth.uid())')
  const p006 = normPredicate('user_id = auth.uid()')
  check('witness: the 005 and 006 predicates normalize UNEQUAL', p005 !== p006, `${p005} vs ${p006}`)

  // H3 — but the commutative case, which is genuinely the same policy written
  // two ways, must normalize EQUAL. This is what stops the rule crying wolf on
  // users_own_projects / _releases / _collections, where the blob and 006
  // disagree only on operand order.
  check('witness: `a = b` and `b = a` normalize EQUAL',
    normPredicate('auth.uid() = user_id') === normPredicate('user_id = auth.uid()'))
  check('witness: commutative folding is narrow — a subquery predicate is untouched',
    normPredicate('project_id in (select id from mb_projects where user_id = auth.uid())')
      === 'project_id in(select id from mb_projects where user_id=auth.uid())')

  // H4 — the rule must not be vacuous: prove it actually compares something by
  // fabricating a later migration that redefines a policy the blob carries.
  const fake = { file: '999_fabricated_supersession.sql', sql: 'create policy "users_own_projects" on mb_projects using (true) with check (true);' }
  const withFake = supersededPolicyProblems(SQL, [...allMigrations, fake])
  check('witness: rule reports a policy a fabricated later migration redefines',
    withFake.some((p) => p.startsWith('mb_projects.users_own_projects')))
  check('witness: the same rule is clean on the current blob', supersededPolicyProblems(SQL, allMigrations).length === 0)
}

if (failures > 0) {
  console.error(`\ndb-init-migration-parity: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\ndb-init-migration-parity: all checks passed')
