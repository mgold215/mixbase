#!/usr/bin/env node
// Contract + behaviour test for the schema-heal missing-relation matchers.
//
// WHY THIS SUITE EXISTS
// A heal can be wired into every one of its consumers and still be unreachable,
// because the guard in FRONT of each call site is what decides whether it runs:
//
//   if (res.error && isMissingUgcModerationTable(res.error) && await ensureUgcModerationTables())
//
// If that predicate is wrong, the heal is dead and nothing anywhere reports it.
// That is what happened to UGC moderation (App Store Guideline 1.2). The guard
// required /does not exist|relation/, but PostgREST answers an unknown table
// with PGRST205 — "Could not find the table 'public.mb_user_blocks' in the
// schema cache" — which contains NEITHER phrase. So mb_content_reports and
// mb_user_blocks were still absent from production weeks after shipping, iOS's
// Report button returned 500 on every tap, and Sentry stayed green throughout
// because the feed degrades to "no filtering" instead of failing.
//
// The same bug was fixed once for mb_library_tracks (d702c23) and not
// backported to its two siblings, so this suite pins the CLASS, not the case:
//   1. the real captured wire payloads must match (behaviour, real predicate)
//   2. every table matcher must delegate to the shared predicate (contract)
//   3. every table-creating heal must nudge PostgREST's schema cache (contract)
//
// Pure: loads the real import-free predicate under type stripping. No network.
// Run: node scripts/schema-heal-matcher-test.mjs  (also part of `npm test`)

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { isMissingRelationError } from '../src/lib/heal-errors.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const healSrc = readFileSync(join(root, 'src/lib/schema-heal.ts'), 'utf8')

let failures = 0
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`)
  else { console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); failures++ }
}

// ── Section A — REAL wire payloads, captured from production PostgREST ───────
// Verbatim response body from
//   GET /rest/v1/mb_user_blocks?select=blocked_id&limit=1
// against mdefkqaawrusoaojstpq on 2026-08-29 while the tables were absent.
// DO NOT paraphrase these. The whole defect was a guess about their wording.
const PGRST205_TABLE = {
  code: 'PGRST205',
  details: null,
  hint: "Perhaps you meant the table 'public.mb_versions'",
  message: "Could not find the table 'public.mb_user_blocks' in the schema cache",
}
const PGRST205_REPORTS = {
  code: 'PGRST205',
  message: "Could not find the table 'public.mb_content_reports' in the schema cache",
}
const PGRST204_COLUMN = {
  code: 'PGRST204',
  message: "Could not find the 'instrumental_url' column of 'mb_projects' in the schema cache",
}
const PG_42P01 = {
  code: '42P01',
  message: 'relation "mb_content_reports" does not exist',
}

console.log('\nA. real PostgREST/Postgres payloads are recognised')
check('PGRST205 (missing table) matches', isMissingRelationError(PGRST205_TABLE, /mb_content_reports|mb_user_blocks/))
check('PGRST205 for the sibling table matches', isMissingRelationError(PGRST205_REPORTS, /mb_content_reports|mb_user_blocks/))
check('PGRST204 (missing column) matches', isMissingRelationError(PGRST204_COLUMN, /instrumental_url/))
check('42P01 raw Postgres matches', isMissingRelationError(PG_42P01, /mb_content_reports/))
check('feed-comments payload matches', isMissingRelationError(
  { code: 'PGRST205', message: "Could not find the table 'public.mb_feed_comments' in the schema cache" }, /mb_feed_comments/))
check('library-tracks payload matches', isMissingRelationError(
  { code: 'PGRST205', message: "Could not find the table 'public.mb_library_tracks' in the schema cache" }, /mb_library_tracks/))

console.log('\nB. it does not over-match')
check('null error is not a missing relation', !isMissingRelationError(null, /mb_user_blocks/))
check('undefined error is not a missing relation', !isMissingRelationError(undefined, /mb_user_blocks/))
check('another table\'s absence does not trigger this heal',
  !isMissingRelationError(PGRST205_TABLE, /mb_library_tracks/),
  'a mb_user_blocks error must not authorise the library-tracks heal')
check('an unrelated failure is not a missing relation',
  !isMissingRelationError({ code: '23505', message: 'duplicate key value violates unique constraint' }, /mb_user_blocks/))
check('an RLS denial naming the table is not a missing relation',
  !isMissingRelationError({ code: '42501', message: 'new row violates row-level security policy for table "mb_user_blocks"' }, /mb_user_blocks/),
  'RLS denial must not be healed away as a missing table')

// ── Section C — FAIL-FIRST WITNESS ───────────────────────────────────────────
// Reconstruct the predicate exactly as it was shipped and prove it is blind to
// the real payload. Without this, Section A only shows the new code agrees with
// itself; this is what shows the old code did not.
console.log('\nC. fail-first witness — the shipped predicate was blind to PGRST205')
const shippedUgcPredicate = (error) =>
  !!error.message && /mb_content_reports|mb_user_blocks/.test(error.message) && /does not exist|relation/.test(error.message)
check('the OLD predicate returns false on the real payload (this is the bug)',
  shippedUgcPredicate(PGRST205_TABLE) === false,
  'if this now passes, PostgREST changed its wording and this suite needs rereading')
check('the NEW predicate returns true on that same payload',
  isMissingRelationError(PGRST205_TABLE, /mb_content_reports|mb_user_blocks/) === true)
check('the OLD predicate did work on 42P01 (why it looked correct in review)',
  shippedUgcPredicate(PG_42P01) === true)

// ── Section D — contract: no hand-rolled table matchers ──────────────────────
// A future heal must not re-derive the wire formats from memory. Every matcher
// that guards a table-creating heal has to delegate to the shared predicate.
console.log('\nD. every table matcher delegates to the shared predicate')
const TABLE_MATCHERS = ['isMissingFeedCommentsTable', 'isMissingUgcModerationTable', 'isMissingLibraryTracksTable']
for (const fn of TABLE_MATCHERS) {
  const m = healSrc.match(new RegExp(`export function ${fn}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\}`))
  check(`${fn} exists`, !!m)
  if (!m) continue
  const body = m[1]
  check(`${fn} delegates to isMissingRelationError`, /isMissingRelationError\(/.test(body),
    `body was: ${body.trim().slice(0, 120)}`)
  check(`${fn} does not hand-roll a phrase list`, !/does not exist/.test(body),
    'a local /does not exist|relation/ test is the exact defect this suite pins')
}

// ── Section E — contract: table-creating heals nudge the schema cache ────────
// Second, INDEPENDENT defect. Fixing the matcher alone is not enough: PostgREST
// caches the schema, so the retry immediately after a SUCCESSFUL create still
// reads a stale cache and fails with the very PGRST205 that triggered the heal.
console.log('\nE. every table-creating heal reloads the PostgREST schema cache')
const sqlBlocks = [...healSrc.matchAll(/const (\w+_SQL) = `([\s\S]*?)`/g)]
check('found heal SQL blocks to inspect', sqlBlocks.length > 0, `found ${sqlBlocks.length}`)
for (const [, name, sql] of sqlBlocks) {
  if (!/create table if not exists/i.test(sql)) continue
  check(`${name} ends with a 'notify pgrst, reload schema' nudge`,
    /notify\s+pgrst\s*,\s*'reload schema'/.test(sql),
    'without it the first retry after a successful create still 404s on a stale cache')
}

console.log(failures === 0
  ? '\n✅ schema-heal matcher suite passed\n'
  : `\n❌ ${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
