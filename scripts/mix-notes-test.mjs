#!/usr/bin/env node
// Contract test: POST /api/mix-notes — the owner's quick-note route into
// mb_feedback — must stay authenticated, owner-scoped, input-bounded, and
// quieter than its public sibling.
//
// Why this matters. The route writes the SAME table as the public
// POST /api/feedback, so the two can drift toward each other in either
// direction and both drifts are bugs:
//   • drift PUBLIC-ward: identity read from the body, or the route added to
//     PUBLIC_PATHS, turns "my notes on my mix" into "anyone writes notes onto
//     anyone's mix" (danger-zones: identity comes from X-User-Id, never the
//     body).
//   • drift FEEDBACK-ward: copying that route's mb_activity insert makes every
//     self-note ring the owner's own notification bell — 20 rows of "Feedback
//     from My notes" in Nav.tsx, re-polled every 60s, drowning real feedback.
// Plus the same free-text discipline public-input-caps-test.mjs pins there:
// typeof-checked comment, bounded length, validated timestamp — this text
// renders in the project page, the punch-list export and the AI summary prompt.
//
// Pure source-contract test — no DB / network.
// Run: node scripts/mix-notes-test.mjs (also part of `npm run test:renderers`)

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const readRaw = (p) => readFileSync(join(root, p), 'utf8')

// Strip // and /* */ comments before scanning — the route documents the very
// anti-patterns it must not contain (e.g. the mb_activity rationale), so
// scanning raw source would flag the explanation as the bug.
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
const read = (p) => stripComments(readRaw(p))

let failures = 0
function check(name, cond) {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    console.error(`  ✗ ${name}`)
    failures++
  }
}

console.log('mix-notes: owner quick-note route stays authenticated, scoped and bounded')

const src = read('src/app/api/mix-notes/route.ts')

// ── Identity: header-injected, never body-supplied ──────────────────────────
check('identity comes from the X-User-Id header',
  /request\.headers\.get\(\s*['"]X-User-Id['"]\s*\)/.test(src))
check('missing identity is a 401',
  /status:\s*401/.test(src))
check('no user id is ever read from the body',
  !/body\s*\.\s*user_?id/i.test(src) && !/\buser_?id\b[^\n]*=\s*body/i.test(src))

// ── Route stays authenticated ───────────────────────────────────────────────
const proxy = read('src/proxy.ts')
check('route is NOT in PUBLIC_PATHS (middleware must gate it)',
  !/mix-notes/.test(proxy))

// ── Free-text discipline (same class public-input-caps-test.mjs pins) ───────
check('body shape is isJsonObject-guarded', /isJsonObject\(\s*body\s*\)/.test(src))
check('comment is typeof-checked, not optional-chained',
  /typeof\s+comment\s*===\s*['"]string['"]/.test(src))
check('no bare comment?.trim() remains', !/comment\?\.\s*trim\(\)/.test(src))
const capMatch = src.match(/const\s+MAX_NOTE_LENGTH\s*=\s*(\d+)/)
check('MAX_NOTE_LENGTH is defined and bounded (<= 5000)',
  capMatch !== null && Number(capMatch[1]) > 0 && Number(capMatch[1]) <= 5000)
check('note length is enforced against the cap',
  /commentText\.length\s*>\s*MAX_NOTE_LENGTH/.test(src))

// ── Ids and timestamps validated before any query ───────────────────────────
check('version_id is isUuid-validated', /isUuid\(\s*version_id\s*\)/.test(src))
check('timestamp is typeof-number-checked',
  /typeof\s+timestamp_seconds\s*!==\s*['"]number['"]/.test(src))
check('timestamp must be finite', /Number\.isFinite\(\s*timestamp_seconds\s*\)/.test(src))
check('timestamp must be non-negative', /timestamp_seconds\s*<\s*0/.test(src))
check('timestamp is capped at 24h (scrubber-marker bound)',
  /Math\.min\(\s*Math\.floor\(\s*timestamp_seconds\s*\)\s*,\s*86400\s*\)/.test(src))

// ── Ownership: version must belong to the caller's project ──────────────────
check('ownership joins through mb_projects!inner(user_id)',
  /mb_projects!inner\(user_id\)/.test(src))
check('ownership filters on the header identity',
  /\.eq\(\s*['"]mb_projects\.user_id['"]\s*,\s*userId\s*\)/.test(src))

// ── Rate limit: user-keyed, held before the query, refunded on 404 ──────────
check('rate limit goes through checkUserLimit (owner-exempt, user-keyed)',
  /checkUserLimit\(\s*mixNoteLimiter\s*,\s*userId\s*\)/.test(src))
check('a rejected ownership check refunds the credit',
  /mixNoteLimiter\.rollback\(\s*userId\s*\)/.test(src))
check('429 carries rate-limit headers', /rateLimitHeaders\(\s*rl\s*\)/.test(src))

// ── Quieter than the public sibling ─────────────────────────────────────────
check('no mb_activity insert (a self-note must not ring your own bell)',
  !/mb_activity/.test(src))
check('reviewer_name is the shared constant, never caller-supplied',
  /reviewer_name:\s*MIX_NOTE_AUTHOR/.test(src) && !/reviewer_name[^:\n]*body/.test(src))
check('rating is never set by this route', /rating:\s*null/.test(src))

// The constant itself lives in the shared lib (importing it from the route
// file into the player would drag supabaseAdmin into the client bundle).
// RAW scan, not read(): supabase.ts contains `/api/*` inside a line comment,
// which the naive block-comment stripper treats as an opener — it swallows the
// rest of the file, including this export. An existence check anchored to the
// start of a line is safe against comment text without any stripping.
const lib = readRaw('src/lib/supabase.ts')
check('MIX_NOTE_AUTHOR is exported from src/lib/supabase.ts',
  /^export const MIX_NOTE_AUTHOR\s*=/m.test(lib))

if (failures > 0) {
  console.error(`\n✗ ${failures} mix-notes contract check(s) failed`)
  process.exit(1)
}
console.log('\n✓ all mix-notes contract checks passed')
