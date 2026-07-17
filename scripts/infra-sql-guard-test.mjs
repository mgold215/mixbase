#!/usr/bin/env node
// Contract test for the infra assistant's ad-hoc SQL guard (src/lib/infra/sql-guard.ts).
//
// POST /api/infra/chat exposes a `run_readonly_sql` tool that runs a statement
// via the Supabase Management API — a superuser-level role that BYPASSES RLS.
// The tool-loop also feeds untrusted data (Sentry issue titles, DB rows) back
// into the model context, and this path has NO confirmation gate (unlike
// /api/infra/actions). So the guard is the only barrier between an injected
// statement and a real side effect.
//
// The guard used to be a bare keyword blocklist: "starts with SELECT + no DML/DDL
// keyword". That let side-effecting *functions* through — e.g.
//   SELECT pg_terminate_backend(pid) FROM pg_stat_activity  (drops every DB conn)
//   SELECT * INTO evil FROM profiles                        (writes a table)
//   SELECT lo_export(...) / pg_read_file('/etc/passwd')     (server-side FS)
// This test locks the hardened behavior AND proves the old guard was exploitable
// (fail-first witness), so a future revert can't silently reopen the hole. It
// also asserts the legitimate read queries the admin tool needs STILL pass, so we
// can't "fix" the leak by over-blocking the tool into uselessness.
//
// Runs on Node native TS type-stripping, same as the other renderer tests.
// Run: node scripts/infra-sql-guard-test.mjs  (also part of `npm run test:renderers`)

import { isReadonlySql } from '../src/lib/infra/sql-guard.ts'

let failures = 0
function check(name, cond) {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    console.error(`  ✗ ${name}`)
    failures++
  }
}
const allow = (name, sql) => check(`ALLOW ${name}`, isReadonlySql(sql) === true)
const deny = (name, sql) => check(`DENY  ${name}`, isReadonlySql(sql) === false)

console.log('infra-sql-guard: read-only means no side effects, not just "starts with SELECT"')

// ── Legit read queries the admin tool relies on MUST still pass ───────────────
// (over-blocking would make run_readonly_sql useless — that's a real regression.)
allow('simple select', 'select 1')
allow('count over app table', 'select count(*) from mb_projects')
allow('join with where', "select p.title, v.version_number from mb_projects p join mb_versions v on v.project_id = p.id where p.user_id = 'x'")
allow('pg_stat_activity (a VIEW, read-only)', 'select pid, state, query from pg_stat_activity')
allow('CTE', 'with recent as (select id from mb_versions order by created_at desc limit 5) select count(*) from recent')
allow('explain', 'explain select * from profiles')
allow('explain analyze (executes a SELECT, read-only)', 'explain analyze select count(*) from mb_feedback')
allow('now()', 'select now()')
allow('uppercase keywords', 'SELECT COUNT(*) FROM MB_USAGE')
allow('trailing semicolon + whitespace stripped', 'select 1;  ')
allow("string literal containing a keyword name", "select 'created a draft' as note")

// ── Writes / DDL / chaining stay blocked (original contract) ─────────────────
deny('insert', "insert into mb_projects (title) values ('x')")
deny('update', "update profiles set subscription_tier = 'admin'")
deny('delete', 'delete from mb_feedback')
deny('drop', 'drop table mb_usage')
deny('alter', 'alter table profiles add column hacked int')
deny('create', 'create table t (id int)')
deny('truncate', 'truncate mb_versions')
deny('grant', 'grant all on profiles to anon')
deny('revoke', 'revoke select on profiles from authenticated')
deny('copy', "copy profiles to '/tmp/x.csv'")
deny('statement chaining', 'select 1; drop table mb_usage')
deny('data-modifying CTE', 'with d as (delete from mb_feedback returning *) select count(*) from d')
deny('does not start with select/with/explain', 'vacuum full mb_versions')
deny('empty', '   ')

// ── THE HARDENING: side-effecting functions inside a SELECT are now blocked ───
const SIDE_EFFECTING = {
  'pg_terminate_backend (kills every other DB connection)':
    'select pg_terminate_backend(pid) from pg_stat_activity where pid <> pg_backend_pid()',
  'pg_cancel_backend': 'select pg_cancel_backend(1234)',
  'setval (mutates a sequence)': "select setval('mb_seq', 1)",
  'nextval (advances a sequence)': "select nextval('mb_seq')",
  'set_config (mutates runtime config)': "select set_config('role', 'postgres', false)",
  'pg_read_file (filesystem read)': "select pg_read_file('/etc/passwd')",
  'pg_ls_dir (filesystem listing)': "select pg_ls_dir('/')",
  'lo_export (writes server-side bytes)': "select lo_export(1, '/tmp/x')",
  'lo_import': "select lo_import('/etc/passwd')",
  'dblink (remote read)': "select * from dblink('host=evil', 'select 1') as t(x int)",
  'dblink_exec (remote exec)': "select dblink_exec('host=evil', 'delete from t')",
  'pg_sleep (backend stall / DoS)': 'select pg_sleep(3600)',
  'pg_reload_conf (server control)': 'select pg_reload_conf()',
  'SELECT INTO (writes a new table)': 'select * into evil from profiles',
  'comment-obfuscated pg_terminate_backend': 'select/**/pg_terminate_backend(1)',
  'uppercase PG_TERMINATE_BACKEND': 'SELECT PG_TERMINATE_BACKEND(1)',
}
for (const [name, sql] of Object.entries(SIDE_EFFECTING)) deny(name, sql)

// ── FAIL-FIRST WITNESS: reconstruct the PRE-HARDENING guard and prove it was
//    exploitable — so this test would have caught the hole, and a revert to the
//    old logic fails loudly. ────────────────────────────────────────────────
function oldGuard(sql) {
  const trimmed = sql.trim().replace(/;\s*$/, '')
  if (trimmed.includes(';')) return false
  if (!/^(select|with|explain)\b/i.test(trimmed)) return false
  if (/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|do)\b/i.test(trimmed)) return false
  return true
}
const witnessKill = 'select pg_terminate_backend(pid) from pg_stat_activity where pid <> pg_backend_pid()'
const witnessInto = 'select * into evil from profiles'
check('witness: OLD guard WRONGLY allowed pg_terminate_backend', oldGuard(witnessKill) === true)
check('witness: OLD guard WRONGLY allowed SELECT INTO', oldGuard(witnessInto) === true)
check('witness: NEW guard blocks pg_terminate_backend', isReadonlySql(witnessKill) === false)
check('witness: NEW guard blocks SELECT INTO', isReadonlySql(witnessInto) === false)

if (failures) {
  console.error(`\ninfra-sql-guard: ${failures} assertion(s) FAILED`)
  process.exit(1)
}
console.log('\ninfra-sql-guard: all assertions passed')
