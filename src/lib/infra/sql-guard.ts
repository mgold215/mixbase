// src/lib/infra/sql-guard.ts
// Guard for the infra assistant's ad-hoc SQL tool (POST /api/infra/chat →
// run_readonly_sql). The statement is executed via the Supabase Management API,
// which runs at a superuser-level role that BYPASSES RLS — so "read-only" must
// mean "no side effects", not merely "starts with SELECT".
//
// Why this is not just cosmetic: the chat tool-loop feeds untrusted tool-result
// data (Sentry issue titles, Railway error strings, prior DB rows) back into the
// model context. A prompt-injection there could make the model emit a statement
// that *starts* with SELECT but still mutates state — e.g.
//   SELECT pg_terminate_backend(pid) FROM pg_stat_activity  → drops every other
//     DB connection = production outage
//   SELECT * INTO evil FROM profiles                        → writes a new table
//   SELECT lo_export(...) / pg_read_file('/etc/passwd')     → server-side FS access
// Unlike /api/infra/actions (which is confirmation-gated), this path has no
// confirm step, so the guard is the only thing standing between the model and a
// side effect.
//
// This is DEFENSE-IN-DEPTH, not a complete sandbox — a keyword/function blocklist
// can never be provably exhaustive. The robust fix is to run ad-hoc SQL through a
// dedicated Postgres role holding only SELECT grants (a DB migration; queued as
// the attended follow-up). Until then this rejects the known side-effecting
// escapes a bare "starts-with-SELECT" check let through, and the fail-first
// contract test (scripts/infra-sql-guard-test.mjs) locks each one.
//
// Pure function, zero deps — imported by the chat route AND unit-tested directly.

// Functions that have side effects (mutate a sequence, control the server, read
// the filesystem, open large-object channels) or exhaust resources, yet can sit
// inside a statement that still begins with SELECT. None appear in a legitimate
// read query against the app's tables/views (note: pg_stat_activity is a VIEW and
// stays allowed — only the connection-killing *functions* are blocked).
const DANGEROUS_FUNCTIONS = [
  // connection / server control
  'pg_terminate_backend', 'pg_cancel_backend', 'pg_reload_conf',
  'pg_rotate_logfile', 'pg_switch_wal', 'pg_create_restore_point', 'pg_promote',
  'pg_log_backend_memory_contexts',
  // sequence mutation
  'setval', 'nextval',
  // session/global configuration mutation
  'set_config',
  // filesystem access
  'pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'pg_stat_file',
  'pg_ls_waldir', 'pg_ls_logdir',
  // large objects (read/write server-side bytes)
  'lo_import', 'lo_export', 'lo_unlink', 'lo_put', 'lo_get', 'lo_from_bytea',
  // cross-database / remote execution
  'dblink', 'dblink_exec',
  // resource exhaustion (stall a backend for the full statement timeout)
  'pg_sleep', 'pg_sleep_for', 'pg_sleep_until',
]

const DANGEROUS_FUNCTION_RE = new RegExp(`\\b(${DANGEROUS_FUNCTIONS.join('|')})\\b`, 'i')

// DML / DDL / permission verbs — plus INTO, which turns a SELECT into a table
// write (SELECT ... INTO newtbl). Data-modifying CTEs (WITH x AS (DELETE ...))
// are caught here too because the inner verb still matches.
const WRITE_KEYWORD_RE = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|do|into)\b/i

// True only for a single statement that begins with SELECT/WITH/EXPLAIN, chains
// nothing, and contains no write verb or side-effecting function. Rejects
// everything else (fail-closed) — including empty input and leading comments,
// which is safe: a rejected legitimate query can just be rephrased.
export function isReadonlySql(sql: string): boolean {
  const trimmed = sql.trim().replace(/;\s*$/, '')
  if (!trimmed) return false
  if (trimmed.includes(';')) return false // no statement chaining
  if (!/^(select|with|explain)\b/i.test(trimmed)) return false
  if (WRITE_KEYWORD_RE.test(trimmed)) return false
  if (DANGEROUS_FUNCTION_RE.test(trimmed)) return false
  return true
}
