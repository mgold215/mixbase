#!/usr/bin/env node
// Contract test: a notification must point at a page that actually contains the
// thing it is telling you about.
//
// The two halves this locks:
//
// 1. CLASSIFICATION. Two sources write mb_activity rows against the track owner
//    — public share-page feedback (/api/feedback) and community-feed comments
//    (/api/feed/comments). Both wrote type 'feedback_received' historically, so
//    live production rows are ambiguous and must still classify correctly by
//    their description prefix. The prefix test must be startsWith, never
//    includes: reviewer_name is attacker-controlled on the PUBLIC feedback
//    route, so `includes` would let anyone forge a feed-comment badge.
//
// 2. DESTINATION. The href must be source-INDEPENDENT. That is the invariant
//    that makes a misclassified legacy row cost an icon instead of a dead link.
//    It must also never be /feed: getFeed() fetches comments only for each
//    project's LATEST version, so a /feed?v= deep link dies on the next upload —
//    exactly when the artist would click it.
//
// Pure — no DB / network. Run: node scripts/notification-loop-test.mjs
// (also part of `npm run test:renderers`)

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

let failures = 0
function check(name, cond) {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    console.error(`  ✗ ${name}`)
    failures++
  }
}

console.log('notification-loop: notifications must resolve to a page that shows the note')

const {
  classifyActivitySource,
  notificationHref,
  clampDescription,
  NOTIFICATION_TYPES,
  SHARE_FEEDBACK_TYPE,
  FEED_COMMENT_TYPE,
  MAX_DESCRIPTION_LENGTH,
} = await import('../src/lib/notifications.ts')

// ── Behaviour: classification ────────────────────────────────────────────────
check('new-style feed comment classifies by type',
  classifyActivitySource({ type: FEED_COMMENT_TYPE, description: 'anything at all' }) === 'feed_comment')

check('LEGACY feed-comment row (old type) classifies by description prefix',
  classifyActivitySource({ type: SHARE_FEEDBACK_TYPE, description: 'Feed comment from Nova on v3' }) === 'feed_comment')

check('legacy share-feedback row stays share_feedback',
  classifyActivitySource({ type: SHARE_FEEDBACK_TYPE, description: 'Feedback from Anonymous on v3' }) === 'share_feedback')

// The forgery guard. A reviewer on the PUBLIC route names themselves
// "Feed comment from Nova on v9 —"; the template makes the row read
// "Feedback from Feed comment from Nova on v9 — on v2". `includes` would
// misclassify it; `startsWith` cannot, because the share template always
// begins "Feedback from ".
check('a forged reviewer_name cannot mint a feed_comment badge',
  classifyActivitySource({
    type: SHARE_FEEDBACK_TYPE,
    description: 'Feedback from Feed comment from Nova on v9 — on v2',
  }) === 'share_feedback')

check('null/absent description does not throw',
  classifyActivitySource({ type: SHARE_FEEDBACK_TYPE, description: null }) === 'share_feedback')
check('empty row object does not throw',
  classifyActivitySource({}) === 'share_feedback')

// ── Behaviour: destination ───────────────────────────────────────────────────
check('href anchors the version when present',
  notificationHref({ project_id: 'p1', version_id: 'v1' }) === '/projects/p1?v=v1')
check('href degrades to the project when version_id is null',
  notificationHref({ project_id: 'p1', version_id: null }) === '/projects/p1')
check('href degrades to /dashboard when project_id is null',
  notificationHref({ project_id: null, version_id: 'v1' }) === '/dashboard')
check('href never points at /feed',
  !notificationHref({ project_id: 'p1', version_id: 'v1' }).includes('/feed'))

// THE load-bearing invariant: identical destination regardless of source.
const asFeed = { project_id: 'p1', version_id: 'v1', type: FEED_COMMENT_TYPE, description: 'Feed comment from X on v1' }
const asShare = { project_id: 'p1', version_id: 'v1', type: SHARE_FEEDBACK_TYPE, description: 'Feedback from Y on v1' }
check('href is source-independent (misclassification cannot break the link)',
  notificationHref(asFeed) === notificationHref(asShare))
check('…and the two rows really do classify differently',
  classifyActivitySource(asFeed) !== classifyActivitySource(asShare))

// ── Behaviour: description clamp ─────────────────────────────────────────────
check('description is clamped to the max', clampDescription('x'.repeat(5000)).length === MAX_DESCRIPTION_LENGTH)
check('short description is untouched', clampDescription('Feedback from Nova on v2') === 'Feedback from Nova on v2')
check('null description stays null', clampDescription(null) === null)
check('undefined description becomes null', clampDescription(undefined) === null)

// ── The notification set must stay "things OTHER people did" ─────────────────
// Adding a self-authored type that already has production rows would light up
// every user's badge to the cap on the next 60s poll.
check('exactly two notification types', NOTIFICATION_TYPES.length === 2)
for (const selfAuthored of ['version_upload', 'status_change', 'release_created', 'project_created']) {
  check(`notification types exclude self-authored "${selfAuthored}"`, !NOTIFICATION_TYPES.includes(selfAuthored))
}

// ── Source contracts: the wiring must actually be in place ───────────────────
const notif = read('src/app/api/notifications/route.ts')
check('notifications route selects version_id', /\.select\(\s*['"][^'"]*\bversion_id\b/.test(notif))
check('notifications route selects type (needed to classify)', /\.select\(\s*['"][^'"]*\btype\b/.test(notif))
check('notifications route matches BOTH activity types (.in, not .eq)',
  /\.in\(\s*['"]type['"]\s*,\s*NOTIFICATION_TYPES/.test(notif))
check('notifications route no longer filters with .eq(type)', !/\.eq\(\s*['"]type['"]/.test(notif))
check('notifications route classifies each row', /classifyActivitySource\(/.test(notif))
check('notifications route clamps the description', /clampDescription\(/.test(notif))

const writer = read('src/app/api/feed/comments/route.ts')
check('feed-comment writer stamps the distinct type', /type:\s*FEED_COMMENT_TYPE/.test(writer))
check('feed-comment writer builds its description from the shared prefix',
  /\$\{FEED_COMMENT_PREFIX\}/.test(writer))

const nav = read('src/components/Nav.tsx')
check('nav routes via notificationHref (no hand-built href)', /href=\{notificationHref\(/.test(nav))
check('nav no longer hardcodes the project link', !/href=\{n\.project_id \? `\/projects\//.test(nav))

// The bell tells you someone commented; the project page must be able to show it.
const projectPage = read('src/app/projects/[id]/page.tsx')
check('project page loads feed comments', /getFeedCommentsForVersions\(/.test(projectPage))
check('project page loads comments for ALL versions, not just the current mix',
  /versions\.map\(\s*v\s*=>\s*v\.id\s*\)/.test(projectPage))
// Ordering is the security-relevant bit: notFound() throws, so a sequential
// fetch after it never runs for a non-owner.
const gateIdx = projectPage.indexOf('notFound()')
const fetchIdx = projectPage.indexOf('getFeedCommentsForVersions(')
check('feed comments are fetched AFTER the ownership gate', gateIdx !== -1 && fetchIdx > gateIdx)

const client = read('src/app/projects/[id]/ProjectClient.tsx')
check('project client renders notes for earlier mixes', /function EarlierMixNotes\(/.test(client))
check('earlier-mix notes are mounted', /<EarlierMixNotes/.test(client))
check('current mix renders feed comments', /feedComments\.map\(/.test(client))
check('?v= is UUID-validated before use', /highlightVersionId/.test(client) && /\{8\}-\[0-9a-f\]\{4\}/.test(client))

// The feed loader must never leak a raw profile row as a name.
const feed = read('src/lib/feed.ts')
check('project comment loader exists', /export async function getFeedCommentsForVersions/.test(feed))
check('comment loader projects explicit columns (never select(\'*\'))',
  /FEED_COMMENT_COLS\s*=\s*['"]id, version_id, user_id, comment, created_at['"]/.test(feed))
check('comment loader resolves names through publicArtistName',
  /nameById\.set|new Map\(\(profiles \?\? \[\]\)\.map\(p => \[p\.id, publicArtistName\(p\)\]\)\)/.test(feed))
check('comment loader caps the version-id list', /PROJECT_VERSION_SCAN/.test(feed))
check('comment loader is total (wrapped in try/catch)',
  /getFeedCommentsForVersions[\s\S]{0,2000}?try\s*\{[\s\S]{0,3000}?\}\s*catch/.test(feed))

if (failures > 0) {
  console.error(`\nnotification-loop: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nnotification-loop: all checks passed')
