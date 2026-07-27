#!/usr/bin/env node
// Contract test: every recent additive `profiles` column must have a runtime
// self-heal, and the routes that read those columns must not mistake a failed
// read for an empty one.
//
// Why this matters: Railway deploys the new code the moment a PR merges, but
// migrations are applied by hand (the backlog has had 017/018 pending for
// weeks). PostgREST rejects the ENTIRE select/update when one referenced column
// is missing, so a deploy that beats its migration doesn't degrade gracefully —
// it fails the whole query. The codebase's answer is the schema-heal pattern:
// catch that specific error, run the idempotent ALTER via the Management API,
// retry once (src/lib/schema-heal.ts).
//
// Migration 021's columns got that treatment. Migration 023's activity_seen_at
// shipped without it, and the notifications route read the cursor with
// `profileRes.data?.activity_seen_at ?? null` while never inspecting
// `profileRes.error` — so on any environment where 023 hadn't run, the unread
// badge silently reported 0 forever and POST 500'd on every bell open. A silent
// zero is the worst failure mode here: it is indistinguishable from "no news",
// so nobody would ever report it.
//
// Pure source-contract test — no DB / network. Run: node scripts/schema-heal-parity-test.mjs
// (also part of `npm run test:renderers`)

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

// Columns added to `profiles` by migrations after 020. Everything earlier
// predates the self-heal pattern and is long since applied everywhere.
const HEAL_FROM = 20
function recentProfileColumns() {
  const cols = new Map()
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    const n = parseInt(file.slice(0, 3), 10)
    if (!Number.isFinite(n) || n <= HEAL_FROM) continue
    const sql = stripComments(readFileSync(join(MIGRATIONS, file), 'utf8'))
    for (const m of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?profiles([\s\S]*?);/gi)) {
      for (const c of m[1].matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?([\w]+)/gi)) {
        cols.set(c[1].toLowerCase(), file)
      }
    }
  }
  return cols
}

console.log('schema-heal-parity: recent profiles columns must self-heal\n')

const healSrc = read('src/lib/schema-heal.ts')
const cols = recentProfileColumns()

check('found recent profiles columns to guard', cols.size > 0, [...cols.keys()].join(', '))

for (const [col, file] of cols) {
  check(`"${col}" (${file}) has a heal in schema-heal.ts`, healSrc.includes(col))
  // The heal must be an idempotent ALTER, not a bare ADD COLUMN that would
  // throw the second time a process runs it.
  const alter = new RegExp(`add\\s+column\\s+if\\s+not\\s+exists\\s+${col}\\b`, 'i')
  check(`"${col}" heal uses "add column if not exists"`, alter.test(healSrc))
}

// The 023 heal must expose the same ensure/isMissing pair every other heal does.
check('exports ensureActivitySeenColumn', /export function ensureActivitySeenColumn\b/.test(healSrc))
check('exports isMissingActivitySeenColumn', /export function isMissingActivitySeenColumn\b/.test(healSrc))
check('isMissingActivitySeenColumn matches on the column name', /activity_seen_at/.test(
  healSrc.slice(healSrc.indexOf('isMissingActivitySeenColumn')),
))

// ── The notifications route must wire the heal and not swallow read errors ───
const notif = read('src/app/api/notifications/route.ts')

check('notifications route imports the heal', /ensureActivitySeenColumn/.test(notif) && /isMissingActivitySeenColumn/.test(notif))

// One wiring per handler: the GET cursor read and the POST cursor write.
const wirings = [...notif.matchAll(/isMissingActivitySeenColumn\([\s\S]{0,40}?\)\s*&&\s*await\s+ensureActivitySeenColumn\(\)/g)]
check('heal is wired on BOTH the GET read and the POST write', wirings.length === 2, `${wirings.length} wiring(s)`)

// The bug this locks: a failed cursor read must not fall through to seenAt=null
// (which yields unread:0 — silently "all read").
const getBody = notif.slice(notif.indexOf('export async function GET'), notif.indexOf('export async function POST'))
check('GET inspects the cursor error before using the cursor', /profileRes\.error/.test(getBody))
const errIdx = getBody.search(/if\s*\(\s*profileRes\.error\s*\)/)
const seenIdx = getBody.indexOf('const seenAt')
check('GET returns on a cursor error BEFORE deriving seenAt', errIdx !== -1 && seenIdx !== -1 && errIdx < seenIdx)

// ── Fail-first witness ───────────────────────────────────────────────────────
// The pre-fix route, reconstructed verbatim from commit fe4fa79. Proves these
// checks fail on the real shipped code rather than passing vacuously.
console.log('\n  witness: the pre-fix notifications route (as shipped in fe4fa79)')
const preFix = `
export async function GET(request: NextRequest) {
  const [itemsRes, profileRes] = await Promise.all([q1, q2])
  if (itemsRes.error) {
    return NextResponse.json({ error: itemsRes.error.message }, { status: 500 })
  }
  const items = (itemsRes.data ?? []) as NotificationItem[]
  const seenAt = profileRes.data?.activity_seen_at ?? null
  return NextResponse.json({ unread, items })
}
export async function POST(request: NextRequest) {
  const { error } = await supabaseAdmin.from('profiles').update({ activity_seen_at: x }).eq('id', userId)
}
`
const preGet = preFix.slice(preFix.indexOf('export async function GET'), preFix.indexOf('export async function POST'))
check('witness: pre-fix route had no heal wiring', ![...preFix.matchAll(/ensureActivitySeenColumn/g)].length)
check('witness: pre-fix GET never inspected the cursor error', !/if\s*\(\s*profileRes\.error\s*\)/.test(preGet))
check('witness: pre-fix GET derived seenAt straight from .data', /profileRes\.data\?\.activity_seen_at \?\? null/.test(preGet))

if (failures > 0) {
  console.error(`\nschema-heal-parity: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nschema-heal-parity: all checks passed')
