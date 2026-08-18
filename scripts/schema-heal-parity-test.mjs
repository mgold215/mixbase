#!/usr/bin/env node
// Contract test: every recent additive column — on ANY table — must have a
// runtime self-heal, and the routes that read those columns must not mistake a
// failed read for an empty one.
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

// Columns added by migrations after 020, on ANY table. The floor stays:
// everything earlier predates the self-heal pattern and is long since applied
// everywhere, so demanding heals for those would be noise.
//
// The TABLE restriction is gone, and that is the point of this rewrite. The
// scan used to be hard-bound to `alter table … profiles`, which made the whole
// suite vacuous for every other table — so migration 031's
// `alter table mb_visualizers add column if not exists settings jsonb` was
// simply invisible to it, and the suite stayed green while enforcing nothing
// for the column the FX engine now writes on every visualizer save. (That gap
// was predicted on 2026-08-04 and shipped for real on 2026-08-13.) The rule
// this file exists to enforce was never profiles-specific: every additive
// column above the floor needs a heal, because Railway deploys the code the
// moment a PR merges and migrations are applied by hand.
const HEAL_FROM = 20

function recentAdditiveColumns() {
  const cols = new Map()
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    const n = parseInt(file.slice(0, 3), 10)
    if (!Number.isFinite(n) || n <= HEAL_FROM) continue
    const sql = stripComments(readFileSync(join(MIGRATIONS, file), 'utf8'))
    // Tables born in this same migration are healed by their own
    // `create table if not exists` block, not by a separate ALTER.
    const born = new Set(
      [...sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?(\w+)/gi)]
        .map((m) => m[1].toLowerCase()),
    )
    for (const m of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?(\w+)([\s\S]*?);/gi)) {
      const table = m[1].toLowerCase()
      for (const c of m[2].matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?(\w+)/gi)) {
        const column = c[1].toLowerCase()
        cols.set(`${table}.${column}`, { table, column, file, born: born.has(table) })
      }
    }
  }
  return cols
}

// One column's verdict against a heal source: null = healed properly, else the
// reason it isn't. Extracted as a pure function so the witness at the bottom can
// run the SAME rule against a deliberately broken heal file — a parity rule that
// can't be shown failing is exactly the vacuum this suite exists to prevent.
function healProblem(healSrc, { table, column, born }) {
  if (!healSrc.includes(column)) return 'column is never mentioned in schema-heal.ts'
  // The heal must be an idempotent ALTER, not a bare ADD COLUMN that would
  // throw the second time a process runs it.
  if (new RegExp(`add\\s+column\\s+if\\s+not\\s+exists\\s+${column}\\b`, 'i').test(healSrc)) return null
  // …unless the table itself is created by the heal, in which case the column
  // rides along inside an equally idempotent `create table if not exists`.
  if (born && new RegExp(`create\\s+table\\s+if\\s+not\\s+exists\\s+(?:public\\.)?${table}\\b[\\s\\S]*?\\b${column}\\b`, 'i').test(healSrc)) return null
  return 'no idempotent "add column if not exists" for it'
}

console.log('schema-heal-parity: recent additive columns must self-heal\n')

const healSrc = read('src/lib/schema-heal.ts')
const cols = recentAdditiveColumns()
const tables = new Set([...cols.values()].map((c) => c.table))

check('found recent additive columns to guard', cols.size > 0, [...cols.keys()].join(', '))
// Anti-vacuity anchors. The scan reaching more than one table is the whole fix;
// naming 031 explicitly pins the specific regression that motivated it, so a
// future re-narrowing fails loudly instead of going quietly green.
check('scan reaches past `profiles`', tables.size > 1, `${tables.size} tables: ${[...tables].join(', ')}`)
check('scan sees migration 031 mb_visualizers.settings', cols.has('mb_visualizers.settings'))

for (const [key, col] of cols) {
  const problem = healProblem(healSrc, col)
  check(`${key} (${col.file}) has an idempotent heal in schema-heal.ts`, problem === null, problem ?? '')
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

// ── Fail-first witness: the parity rule itself ───────────────────────────────
// Run the rule against a COPY of schema-heal.ts with the mb_visualizers.settings
// ALTER cut out. It must come back red. This is what the old profiles-only scan
// could never do: it reported "all checks passed" for a column it wasn't even
// looking at, and nothing in the suite could tell that apart from a real pass.
console.log('\n  witness: the parity rule goes red when a heal is removed')
{
  const settings = cols.get('mb_visualizers.settings')
  const stubbed = healSrc.replace(/alter table mb_visualizers add column if not exists settings jsonb;?/gi, '')
  check('witness: stubbing the heal actually changed the source', stubbed !== healSrc)
  const problem = settings ? healProblem(stubbed, settings) : 'column not found by the scan'
  check('witness: rule reports mb_visualizers.settings unhealed', problem !== null, problem ?? 'reported healed')
  check('witness: the same rule passes on the real source',
    !!settings && healProblem(healSrc, settings) === null)
}

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
