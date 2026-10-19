// Web ↔ app parity register — every server route the website calls must also
// be called by the native app (iOS + macOS share ios/mixBase), or be listed
// below with the reason it isn't.
//
// Run: node scripts/ios-parity-test.mjs
//
// WHY THIS EXISTS
// The owner kept finding web features that never reached the app — most
// recently Finalize Artwork (2026-10-19), which had been on the web for months.
// Nothing noticed, because nothing compared the two clients. The rule now is
// ONE STACK: a feature's logic lives in a server route, and both clients call
// that route. This suite is the machine half of the rule:
//
//   - a web route the app neither calls nor lists below FAILS the build, so a
//     new web feature can't silently skip the app — build the app side too, or
//     add it to KNOWN with an honest status;
//   - a KNOWN entry the app now calls, or the web no longer calls, FAILS as
//     stale, so the register shrinks as gaps close and never lies;
//   - the same holds in reverse for routes only the app calls (APP_ONLY).
//
// LIMITS (read before trusting a green run)
// Matching is per PATH, not per method or body field: /api/versions/* counts as
// shared because the app sets mix status through it, even though the web also
// edits mix notes through it and the app can't. Features with no route at all
// (forgot password, BPM/key detection, copying a punch list) are invisible here.
// Green means "no NEW route-level gap", not "the apps are identical".
//
// STATUSES in KNOWN
//   missing   the app doesn't have this feature yet
//   direct    the app has it, but writes to Supabase itself instead of calling
//             the route — so it skips whatever the route adds (activity rows,
//             ownership checks, validation). Drift risk: move it onto the route.
//   native    the app does the same job its own way, by design
//   web-only  not applicable to the app (admin console, anonymous share pages)

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from './source-contract.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const KNOWN = {
  // ── missing: the app doesn't have it yet ────────────────────────────────────
  '/api/auth/change-password': { status: 'missing', note: 'Change password (web /profile)' },
  '/api/chat/summarize-feedback': { status: 'missing', note: 'AI summary of listener feedback (project page)' },
  '/api/notifications': { status: 'missing', note: 'Notifications bell — unread count + mark seen (app shows Recent Activity only)' },
  '/api/projects/*/artwork-history': { status: 'missing', note: 'Artwork history + restore (project Artwork tab)' },
  '/api/releases/waterfall': { status: 'missing', note: 'Waterfall release planner (/pipeline)' },
  '/api/sb-curators/*': { status: 'missing', note: 'Edit / delete your own curators (/submit)' },
  '/api/visualizer/recover': { status: 'missing', note: 'Recover unsaved visualizer renders (/media)' },
  '/api/audio': { status: 'missing', note: 'Download the original mix file (web links /api/audio/…?download=1)' },

  // ── direct: the app writes to Supabase itself, skipping the route's rules ──
  '/api/projects': { status: 'direct', note: 'Create project — app skips the project_created activity row' },
  '/api/releases': { status: 'direct', note: 'Create release — app skips activity row + ownership checks' },
  '/api/releases/*': { status: 'direct', note: 'Edit release — app skips validation, and its checklist labels differ from the web (release-plan.ts)' },
  '/api/collections': { status: 'direct', note: 'Create collection' },
  '/api/collections/*/items': { status: 'direct', note: 'Add / remove / reorder collection items — app skips ownership check + updated_at bump' },
  '/api/sb-curators': { status: 'direct', note: 'List / add curators — app insert omits user_id' },
  '/api/sb-submissions': { status: 'direct', note: 'Log a curator submission — app skips rate limit + last_contacted' },
  '/api/sb-submissions/*': { status: 'direct', note: 'Update submission status — app sets sent_at from the phone clock' },
  '/api/media': { status: 'direct', note: 'Media library listing (read-only)' },
  '/api/tracks': { status: 'direct', note: 'Player track list (read-only)' },
  '/api/upload-url': { status: 'direct', note: 'Uploads — app PUTs to Storage itself, at the bucket root, skipping rate limit + ownership' },

  // ── native: same job, the app's own way by design ───────────────────────────
  '/api/auth': { status: 'native', note: 'Sign-in — app uses Supabase Auth directly (email + Apple)' },
  '/api/auth/signup': { status: 'native', note: 'Sign-up — Supabase Auth directly' },
  '/api/auth/logout': { status: 'native', note: 'Sign-out — app clears its own session' },
  '/api/auth/refresh': { status: 'native', note: 'Token refresh — AuthService refreshes with Supabase' },
  '/api/tus': { status: 'native', note: 'Browser large-file chunking proxy; the app uploads directly (see /api/upload-url)' },
  '/api/visualizer/save': { status: 'native', note: 'Browser-rendered visualizer save; the app renders server-side via /api/visualizer/free' },
  '/api/visualizer/finalize': { status: 'native', note: 'Browser-rendered visualizer finalize; see /api/visualizer/save' },
  '/api/audio/*': { status: 'native', note: 'Range-request proxy for <audio>; AVPlayer streams Storage URLs directly' },
  '/api/artwork/*': { status: 'native', note: 'Cookie-less artwork proxy for the browser; the app loads Storage URLs directly' },

  // ── web-only: not applicable to the app ─────────────────────────────────────
  '/api/admin/chat': { status: 'web-only', note: 'Admin console' },
  '/api/admin/users': { status: 'web-only', note: 'Admin console' },
  '/api/admin/users/*': { status: 'web-only', note: 'Admin console' },
  '/api/infra/*': { status: 'web-only', note: 'Infra control panel (its own macOS client, MixbaseInfra)' },
  '/api/feedback': { status: 'web-only', note: 'Anonymous listener feedback on public share pages' },
  '/api/share/*/duration': { status: 'web-only', note: 'Anonymous share-page duration backfill' },
}

// Routes only the app calls — the reverse gap.
const APP_ONLY = {
  '/api/feed': 'Feed listing — the web page loads it server-side',
  '/api/feed/report': 'Report a post (App Store 1.2) — the web has no report UI yet',
  '/api/feed/block': 'Block a user (App Store 1.2) — the web has no block UI yet',
  '/api/visualizer/free': "The app's server-side free visualizer (the web renders in the browser)",
}

// ── Extraction ────────────────────────────────────────────────────────────────

function walk(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, exts, out)
    else if (exts.some(e => name.endsWith(e))) out.push(p)
  }
  return out
}

// Index just past the bracket that closes the one at `i`.
function skipBalanced(s, i, open, close) {
  let depth = 0
  for (; i < s.length; i++) {
    if (s[i] === open) depth++
    else if (s[i] === close && --depth === 0) return i + 1
  }
  return s.length
}

// Every string literal starting with /api/, interpolations collapsed to `*`
// (JS `${…}`, Swift `\(…)`), query string and trailing slash dropped.
function apiRoutes(src) {
  const routes = []
  for (const m of src.matchAll(/(['"`])\/api\//g)) {
    const quote = m[1]
    let i = m.index + 1
    let route = ''
    while (i < src.length && src[i] !== quote && src[i] !== '\n') {
      if (src.startsWith('${', i)) { i = skipBalanced(src, i + 1, '{', '}'); route += '*'; continue }
      if (src.startsWith('\\(', i)) { i = skipBalanced(src, i + 1, '(', ')'); route += '*'; continue }
      route += src[i++]
    }
    route = route.replace(/[?#].*$/, '').replace(/\/+$/, '')
    if (route.length > '/api/'.length) routes.push(route)
  }
  return routes
}

function collect(files) {
  const found = new Map()
  for (const f of files) {
    for (const r of apiRoutes(stripComments(readFileSync(f, 'utf8')))) {
      if (!found.has(r)) found.set(r, new Set())
      found.get(r).add(relative(repoRoot, f))
    }
  }
  return found
}

const src = (d) => join(repoRoot, 'src', d)
const webFiles = [
  ...walk(src('app'), ['.ts', '.tsx']).filter(f => !f.includes(`${join('src', 'app', 'api')}`)),
  ...walk(src('components'), ['.ts', '.tsx']),
  ...walk(src('contexts'), ['.ts', '.tsx']),
  ...walk(src('lib'), ['.ts', '.tsx']),
]
const web = collect(webFiles)
const app = collect(walk(join(repoRoot, 'ios', 'mixBase'), ['.swift']))

// ── Checks ────────────────────────────────────────────────────────────────────

let failures = 0
function fail(msg) { failures++; console.error(`  ✗ ${msg}`) }

console.log(`web calls ${web.size} routes, the app calls ${app.size}\n`)

const shared = []
for (const [route, files] of [...web].sort()) {
  if (app.has(route)) {
    shared.push(route)
    if (KNOWN[route]) fail(`${route} is listed as "${KNOWN[route].status}" but the app now calls it — remove it from KNOWN`)
  } else if (!KNOWN[route]) {
    fail(`${route} is called by the web (${[...files].join(', ')}) but not by the app.\n` +
      `      Build the app side on the same route, or list it in KNOWN with an honest status and note.`)
  }
}
for (const route of Object.keys(KNOWN)) {
  if (!web.has(route)) fail(`KNOWN lists ${route}, but the web no longer calls it — remove the stale entry`)
}
for (const [route, files] of [...app].sort()) {
  if (web.has(route)) continue
  if (!APP_ONLY[route]) {
    fail(`${route} is called by the app (${[...files].join(', ')}) but not by the web — list it in APP_ONLY with why`)
  }
}
for (const route of Object.keys(APP_ONLY)) {
  if (!app.has(route)) fail(`APP_ONLY lists ${route}, but the app no longer calls it — remove the stale entry`)
  if (web.has(route)) fail(`APP_ONLY lists ${route}, but the web calls it too now — remove it from APP_ONLY`)
}
for (const [route, { status }] of Object.entries(KNOWN)) {
  if (!['missing', 'direct', 'native', 'web-only'].includes(status)) fail(`${route}: unknown status "${status}"`)
}

// The register, printed every run so the gap list is visible in CI logs.
const byStatus = (s) => Object.entries(KNOWN).filter(([, k]) => k.status === s)
console.log(`  same route on both: ${shared.length}`)
for (const status of ['missing', 'direct', 'native', 'web-only']) {
  const rows = byStatus(status)
  console.log(`  ${status}: ${rows.length}`)
  if (status === 'missing' || status === 'direct') {
    for (const [route, { note }] of rows) console.log(`      ${route.padEnd(34)} ${note}`)
  }
}
console.log(`  app-only: ${Object.keys(APP_ONLY).length}`)

if (failures) {
  console.error(`\n${failures} parity check(s) failed`)
  process.exit(1)
}
console.log('\nparity register is complete and current')
