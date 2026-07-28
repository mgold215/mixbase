#!/usr/bin/env node
// Contract test: free-text fields on PUBLIC, unauthenticated routes must be
// type-checked and length-capped before they are stored.
//
// Why this matters. POST /api/feedback is in PUBLIC_PATHS (src/proxy.ts) — no
// auth, no session, 20 requests/hr per IP. It writes TWO rows:
//   • mb_feedback.reviewer_name  (unbounded `text`, 001_initial.sql)
//   • mb_activity.description    (unbounded `text`) — which embeds the name
// and that mb_activity row is what the notifications bell renders. Nav.tsx
// re-polls /api/notifications every 60 seconds on every authenticated page and
// returns all 20 rows in full. So an uncapped `reviewer_name` is not a cosmetic
// problem: it is an attacker-planted payload that the victim's browser
// re-downloads forever and cannot clear from the UI. Version UUIDs are not
// secret either — GET /api/feed hands them out for every recent upload.
//
// Separately, `comment?.trim()` / `reviewer_name?.trim()` guard only
// null/undefined. A JSON number or array reaches `.trim` as undefined and
// throws an uncaught TypeError — a 500 on a public endpoint from a one-line
// request body.
//
// Pure source-contract test — no DB / network.
// Run: node scripts/public-input-caps-test.mjs (also part of `npm run test:renderers`)

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const readRaw = (p) => readFileSync(join(root, p), 'utf8')

// Strip // and /* */ comments before scanning. These files DOCUMENT the very
// anti-patterns they must not contain ("`comment?.trim()` only guards
// null/undefined…"), so scanning raw source flags the explanation as the bug.
// Naive but sufficient here: no regex literal or string in these files contains
// a // or /* sequence.
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

/** Value of a `const NAME = <number>` declaration. */
function numConst(src, name) {
  const m = src.match(new RegExp(`const\\s+${name}\\s*=\\s*(\\d+)`))
  return m ? Number(m[1]) : null
}

console.log('public-input-caps: unauthenticated free text must be typed and bounded')

// ── POST /api/feedback ───────────────────────────────────────────────────────
const fb = read('src/app/api/feedback/route.ts')

const nameCap = numConst(fb, 'MAX_REVIEWER_NAME_LENGTH')
const commentCap = numConst(fb, 'MAX_COMMENT_LENGTH')
check('feedback: MAX_REVIEWER_NAME_LENGTH is defined', nameCap !== null)
check('feedback: reviewer-name cap is a sane display length (1-200)', nameCap !== null && nameCap > 0 && nameCap <= 200)
check('feedback: MAX_COMMENT_LENGTH is defined', commentCap !== null)
check('feedback: comment cap is bounded (<= 5000)', commentCap !== null && commentCap > 0 && commentCap <= 5000)

// Type checks — the fix for the 500-on-non-string class.
check('feedback: reviewer_name is typeof-checked, not optional-chained',
  /typeof\s+reviewer_name\s*===\s*['"]string['"]/.test(fb))
check('feedback: comment is typeof-checked, not optional-chained',
  /typeof\s+comment\s*===\s*['"]string['"]/.test(fb))
check('feedback: no bare reviewer_name?.trim() remains', !/reviewer_name\?\.\s*trim\(\)/.test(fb))
check('feedback: no bare comment?.trim() remains', !/comment\?\.\s*trim\(\)/.test(fb))

// The name is actually truncated...
check('feedback: reviewer name is sliced to the cap',
  /\.slice\(\s*0\s*,\s*MAX_REVIEWER_NAME_LENGTH\s*\)/.test(fb))
// ...and the comment length is actually rejected.
check('feedback: comment length is enforced against the cap',
  /length\s*>\s*MAX_COMMENT_LENGTH/.test(fb))

// ONE sanitized name, used at BOTH write sites. These previously disagreed:
// the insert used `reviewer_name?.trim() || 'Anonymous'` while the activity
// description interpolated the RAW `reviewer_name`, so the capped value could
// be stored while the uncapped one still reached the bell.
const safeNameDecl = /const\s+safeName\s*=/.test(fb)
check('feedback: a single sanitized name constant exists', safeNameDecl)
check('feedback: mb_feedback insert stores the sanitized name', /reviewer_name:\s*safeName/.test(fb))
check('feedback: activity description uses the sanitized name', /Feedback from \$\{safeName\}/.test(fb))
check('feedback: activity description does NOT interpolate raw reviewer_name',
  !/Feedback from \$\{reviewer_name/.test(fb))

// ── The client form should agree with the server (defence in depth only) ─────
const form = read('src/components/FeedbackForm.tsx')
check('feedback form: name input has a maxLength', /maxLength=\{\s*\d+\s*\}[\s\S]{0,400}?placeholder="What do you think/.test(form) || /placeholder="Your name[\s\S]{0,400}?maxLength=\{\s*\d+\s*\}/.test(form))

// ── Read-side defence: the bell must not render an unbounded description ─────
// Caps at the write site protect future rows; rows already in production keep
// whatever length they were written with, so the reader truncates too.
const notif = read('src/app/api/notifications/route.ts')
check('notifications: description is truncated on read',
  /description:\s*clampDescription\(/.test(notif))

// And the clamp itself must actually bound the string.
const { clampDescription, MAX_DESCRIPTION_LENGTH } = await import('../src/lib/notifications.ts')
check('notifications: clamp bounds an oversized description',
  clampDescription('x'.repeat(50_000)).length === MAX_DESCRIPTION_LENGTH)
check('notifications: clamp length is sane (<= 500)', MAX_DESCRIPTION_LENGTH > 0 && MAX_DESCRIPTION_LENGTH <= 500)

const nav = read('src/components/Nav.tsx')
check('nav: notification text is clamped/wrapped so one row cannot fill the panel',
  /line-clamp-\d/.test(nav) && /break-words/.test(nav))

if (failures > 0) {
  console.error(`\npublic-input-caps: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\npublic-input-caps: all checks passed')
