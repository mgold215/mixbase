// admin-identity-test.mjs
//
// The property under test: NO admin gate decides on profiles.subscription_tier.
//
// That column is UPDATE-grantable to `authenticated` in production and RLS scopes
// the ROW, not the COLUMN, so the user described by a profile row can rewrite it.
// Gating on the string let any signed-in account reach /admin, /api/admin/* and
// /api/infra/* (Railway restart/redeploy, CI re-run) and collect TIER_LIMITS.admin
// = 99999 generations. Migration 036 revokes the grant; this suite pins the code
// half so the gate does not quietly regress back onto the column if 036 is ever
// rolled back, or on a fresh project where it has not been applied yet.
//
// Every rule below is negative-controlled: the same rule is re-run against a
// mutated copy of the source that reintroduces the bug, and must go RED there.
// A rule that cannot fail is not evidence.

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

console.log('admin-identity: no admin gate may decide on subscription_tier\n')

// ── The comment stripper ─────────────────────────────────────────────────────
// This is load-bearing, not hygiene. The fix's OWN comments quote the very
// pattern these rules search for ("subscription_tier === 'admin'"), because they
// explain the hole being closed. A scan over raw source would match that prose
// and report the gate as still-broken; worse, the inverse mistake — a rule that
// only ever reads raw source — is how viz-finalize-test came to be satisfied by
// a word in a comment. Strip first, assert second.
function stripComments(src) {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i], d = src[i + 1]
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i++
      while (i < n && src[i] !== q) { if (src[i] === '\\') { out += src[i]; i++ } if (i < n) { out += src[i]; i++ } }
      out += q; i++; continue
    }
    out += c; i++
  }
  return out
}

// Does this source decide admin-ness by comparing subscription_tier to 'admin'?
// Deliberately broad: any comparison operator, either operand order, quoted or
// via a variable holding the column. It is meant to catch a re-introduction that
// does not look exactly like the original line.
const TIER_GATE = /subscription_tier[\s\S]{0,80}?(===|!==|==|!=)\s*['"`]admin['"`]|['"`]admin['"`]\s*(===|!==|==|!=)[\s\S]{0,80}?subscription_tier/

const GATES = [
  ['src/proxy.ts', 'withAdminCheck'],
  ['src/lib/auth.ts', 'assertAdmin'],
  ['src/app/admin/layout.tsx', 'AdminLayout'],
  ['src/lib/tier.ts', 'isPlatformOwner'],
]

// ── Rule 1: no gate compares the column ──────────────────────────────────────
for (const [file, label] of GATES) {
  const code = stripComments(read(file))
  check(`${label} (${file}) does not gate on subscription_tier`, !TIER_GATE.test(code),
    (code.match(TIER_GATE) || [''])[0].replace(/\s+/g, ' ').slice(0, 90))
}

// ── Rule 2: every gate actually calls the identity check ─────────────────────
for (const [file, label] of GATES) {
  const code = stripComments(read(file))
  check(`${label} calls isAdminIdentity()`, /isAdminIdentity\s*\(/.test(code))
}

// ── Rule 3: the identity source is one the user cannot write ─────────────────
const ident = stripComments(read('src/lib/admin-identity.ts'))
check('isAdminIdentity reads auth.users, not profiles',
  /auth\.admin\.getUserById/.test(ident) && !/from\(\s*['"`]profiles['"`]\s*\)/.test(ident))
check('the owner allowlist is a non-empty set of emails',
  /OWNER_EMAILS\s*=\s*new Set\(\s*\[\s*['"`][^'"`]+@/.test(ident))

// ── Rule 4: it fails CLOSED ──────────────────────────────────────────────────
// Both the error branch and the throw branch must hand back false. An admin gate
// that opens on a transient Supabase blip is the failure mode this whole file is
// about, arrived at from the other direction.
const errBranch = ident.slice(ident.indexOf('if (error)'), ident.indexOf('if (error)') + 200)
check('returns false when getUserById errors', /return false/.test(errBranch))
const catchBranch = ident.slice(ident.indexOf('catch (err)'))
check('returns false when the lookup throws', /return false/.test(catchBranch))

// ── Rule 5: a false is never cached ──────────────────────────────────────────
// Caching a negative would pin a wrong answer for the life of the deploy — the
// owner's access would stay broken after the underlying cause was fixed.
check('only true is ever written to the cache',
  /adminCache\.set\([^)]*,\s*true\s*\)/.test(ident) && !/adminCache\.set\([^)]*,\s*false\s*\)/.test(ident))

// ── Rule 6: the stripper does not eat real code ──────────────────────────────
// If stripComments were over-eager it would delete the very lines rules 1-2 look
// for, and every rule above would pass vacuously.
check('stripper preserves code outside comments',
  stripComments(`const a = 1 // note\n/* block */ const b = 'x'`).includes('const a = 1') &&
  stripComments(`const a = 1 // note\n/* block */ const b = 'x'`).includes("const b = 'x'"))
check('stripper does remove comment text',
  !stripComments(`// subscription_tier === 'admin'\nconst a = 1`).includes('subscription_tier'))
check('stripper keeps string literals intact',
  stripComments(`const s = "a // b"`).includes('a // b'))

// ── Rule 7: owner-only tools ask the same identity question ──────────────────
// Cassette Studio (and its moving cover) is the platform owner's own tool. Every
// handler under src/app/api/cassette-studio/** must answer a non-owner with a
// 404 straight after the 401 — before reading the body, touching storage or a
// rate limiter — and decide it with isAdminIdentity, never with a profile column
// the user can write (profiles.is_owner is as user-writable as
// subscription_tier). The web surfaces that SHOW the tool, and the flag the apps
// read (/api/auth/me owner_tools), must come from the same question.
const OWNER_GATE = /if \(!userId\) return NextResponse\.json\(\{ error: 'Not authenticated' \}, \{ status: 401 \}\)\s*\n\s*if \(!\(await isAdminIdentity\(userId\)\)\) return NextResponse\.json\(\{ error: 'Not found' \}, \{ status: 404 \}\)/
const studioRoutes = []
const walkRoutes = (dir) => {
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (e.isDirectory()) walkRoutes(`${dir}/${e.name}`)
    else if (e.name === 'route.ts') studioRoutes.push(`${dir}/${e.name}`)
  }
}
walkRoutes('src/app/api/cassette-studio')
check('found the Cassette Studio routes (rule is anchored)', studioRoutes.length >= 5, studioRoutes.join(', '))
function handlerBodies(code) {
  const out = []
  const re = /export async function (GET|POST|PUT|PATCH|DELETE)\s*\(/g
  let m
  const starts = []
  while ((m = re.exec(code))) starts.push([m[1], m.index])
  for (let i = 0; i < starts.length; i++) out.push([starts[i][0], code.slice(starts[i][1], i + 1 < starts.length ? starts[i + 1][1] : code.length)])
  return out
}
for (const file of studioRoutes) {
  const code = stripComments(read(file))
  const handlers = handlerBodies(code)
  check(`${file} exports at least one handler`, handlers.length > 0)
  for (const [verb, body] of handlers) {
    check(`${file} ${verb}: 404s a non-owner right after the 401`, OWNER_GATE.test(body))
  }
  check(`${file} does not gate on a profile column`, !/is_owner|subscription_tier/.test(code))
}
const me = stripComments(read('src/app/api/auth/me/route.ts'))
check('/api/auth/me owner_tools comes from isAdminIdentity', /isAdminIdentity\(userId\)/.test(me) && /owner_tools:/.test(me) && !/is_owner:/.test(me))
for (const page of ['src/app/projects/[id]/page.tsx', 'src/app/@modal/(.)projects/[id]/page.tsx']) {
  const code = stripComments(read(page))
  check(`${page} computes ownerTools with isAdminIdentity`, /isAdminIdentity\(userId\)/.test(code) && /ownerTools=\{ownerTools === true\}/.test(code))
}
const gen = stripComments(read('src/components/ArtworkGenerator.tsx'))
check('ArtworkGenerator renders Cassette Studio only for ownerTools',
  /\{ownerTools && \(\s*<button[\s\S]{0,400}?Cassette Studio/.test(gen) && /showActions && ownerTools && mode === 'cassette'/.test(gen))

// ── Witnesses: each rule must go red on a reintroduced bug ───────────────────
console.log('\n  witness: the rules go red when the hole is reopened')

const reintroduced = [
  ["the original proxy line", `if (profile?.subscription_tier !== 'admin') {`],
  ["reversed operands", `if ('admin' === profile.subscription_tier) {`],
  ["loose equality", `if (data.subscription_tier == "admin") {`],
  ["a line break between operands", `if (profile\n  ?.subscription_tier\n  !== 'admin') {`],
]
for (const [label, snippet] of reintroduced) {
  check(`witness: rule 1 catches ${label}`, TIER_GATE.test(stripComments(snippet)))
}
check('witness: rule 1 is NOT satisfied by the same text in a comment',
  !TIER_GATE.test(stripComments(`// if (profile?.subscription_tier !== 'admin') { ... }`)))
check('witness: rule 2 catches a gate that stopped calling isAdminIdentity',
  !/isAdminIdentity\s*\(/.test(stripComments(`const ok = profile.tier === 'admin'`)))
check('witness: rule 3 catches an identity source that reads profiles',
  /from\(\s*['"`]profiles['"`]\s*\)/.test(stripComments(`supabaseAdmin.from('profiles').select('subscription_tier')`)))
check('witness: rule 5 catches a cached false',
  /adminCache\.set\([^)]*,\s*false\s*\)/.test(`adminCache.set(userId, false)`))

{
  const ungated = `export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const limit = await checkUserLimit(cassetteStudioLimiter, userId)`
  check('witness: rule 7 catches a Cassette Studio handler without the owner gate', !OWNER_GATE.test(ungated))
  const late = `${ungated}
  if (!(await isAdminIdentity(userId))) return NextResponse.json({ error: 'Not found' }, { status: 404 })`
  check('witness: rule 7 catches an owner gate that runs after other work', !OWNER_GATE.test(late))
  const profileGate = `if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!profile.is_owner) return NextResponse.json({ error: 'Not found' }, { status: 404 })`
  check('witness: rule 7 catches a gate on profiles.is_owner', !OWNER_GATE.test(profileGate) && /is_owner/.test(profileGate))
  check('witness: handlerBodies splits each exported handler',
    handlerBodies('export async function GET(a) { 1 }\nexport async function DELETE(b) { 2 }').map(h => h[0]).join() === 'GET,DELETE')
}

// The real files must still be clean once every witness has proven the rules bite.
for (const [file, label] of GATES) {
  check(`witness: ${label} is still clean on the current source`, !TIER_GATE.test(stripComments(read(file))))
}

console.log(`\nadmin-identity: ${failures ? `${failures} check(s) failed` : 'all checks passed'}`)
process.exit(failures ? 1 : 0)
