#!/usr/bin/env node
// Contract test: quota-refund integrity on the paid AI-generation routes.
//
// Why this matters: checkAndIncrementUsage reserves a monthly generation slot
// BEFORE the paid provider call (so two concurrent generations can't both pass
// on a user's last credit). The cost of that ordering is that EVERY failure path
// after the reserve must hand the slot back — otherwise a network blip or a
// malformed-JSON response burns a paid generation (studio video = 10/mo, free
// artwork = 3/mo) with nothing to show for it. Two real gaps this locks:
//   1. A throw (fetch reject / .json() parse error) on the create/poll/download
//      call escaped uncaught → 500 with the slot burned, never refunded. The fix
//      wraps those calls so a throw refunds.
//   2. refundUsage recomputed currentMonth() at refund time; a generation that
//      straddles 00:00 UTC on the 1st refunded the NEW month, leaving the
//      reserved (old-month) slot burned. The fix threads the reserved month
//      (gate.month) from reserve to refund.
//
// Two layers:
//   A) Pure unit tests of planUsageRefund (imported from the REAL tier.ts) — the
//      decrement decision, proving it never goes negative and never touches the
//      other feature's counter.
//   B) Source-contract guards on the two paid routes + a fail-first WITNESS that
//      reconstructs the pre-fix code and proves the guards would have caught it.
//
// Pure — no DB/network (importing tier.ts only constructs a client, no I/O).
// Run: node scripts/usage-refund-test.mjs  (also part of `npm run test:renderers`)

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { planUsageRefund } from '../src/lib/usage-refund.ts'

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

console.log('usage-refund: quota-integrity on the paid generation routes')

// ── A) Pure planUsageRefund invariants ───────────────────────────────────────
console.log('\n planUsageRefund — decrement decision (pure):')
check('artwork 3 → decrements artwork to 2',
  JSON.stringify(planUsageRefund('artwork', { artwork_generations: 3, video_generations: 0 })) === '{"artwork_generations":2}')
check('video 10 → decrements video to 9',
  JSON.stringify(planUsageRefund('video', { artwork_generations: 5, video_generations: 10 })) === '{"video_generations":9}')
check('refunding artwork never touches the video counter',
  !('video_generations' in (planUsageRefund('artwork', { artwork_generations: 1, video_generations: 7 }) ?? {})))
check('refunding video never touches the artwork counter',
  !('artwork_generations' in (planUsageRefund('video', { artwork_generations: 4, video_generations: 1 }) ?? {})))
check('current 0 → null (counter can never go negative)',
  planUsageRefund('artwork', { artwork_generations: 0, video_generations: 0 }) === null)
check('video current 0 → null (never negative)',
  planUsageRefund('video', { artwork_generations: 9, video_generations: 0 }) === null)
check('null row (nothing reserved) → null (no-op)',
  planUsageRefund('artwork', null) === null)
check('undefined row → null (no-op)',
  planUsageRefund('video', undefined) === null)
// A double-refund is a no-op once the counter reaches 0 — feeding the planner its
// own decremented output eventually bottoms out at null rather than going negative.
check('repeated refund from 1 bottoms out (1 → 0 → null)', (() => {
  const a = planUsageRefund('artwork', { artwork_generations: 1, video_generations: 0 })
  return JSON.stringify(a) === '{"artwork_generations":0}' &&
    planUsageRefund('artwork', { artwork_generations: 0, video_generations: 0 }) === null
})())

// ── B) Source-contract guards on the paid routes ─────────────────────────────
// A refund-worthy provider call is "guarded" when it sits inside a try{} whose
// catch calls refund(). We check a window around the call anchor.
function guardedByTryRefund(src, anchor, win = 1400) {
  const idx = src.indexOf(anchor)
  if (idx < 0) return false
  const before = src.slice(Math.max(0, idx - 600), idx)
  const after = src.slice(idx, idx + win)
  return /try\s*\{/.test(before) && /catch\s*\(/.test(after) && /refund\(\)/.test(after)
}
// Runway's outer catch is far below the create call, so verify the tail block.
function runwayOuterCatchRefunds(src) {
  const tail = src.slice(src.indexOf('timed out'))
  return /catch\s*\([\s\S]{0,240}?refund\(\)/.test(tail)
}

const artworkSrc = read('src/app/api/generate-artwork/route.ts')
const runwaySrc = read('src/app/api/visualizer/runway/route.ts')
const tierSrc = read('src/lib/tier.ts')

console.log('\n generate-artwork route — download guarded + month threaded:')
check('image download fetch(outputUrl) is inside try/catch that refunds',
  // Anchor without the closing paren: the call now carries an AbortSignal arg.
  guardedByTryRefund(artworkSrc, 'fetch(outputUrl'))
check("refund threads the reserved month: refundUsage(userId, 'artwork', gate.month)",
  /refundUsage\(\s*userId\s*,\s*'artwork'\s*,\s*gate\.month\s*\)/.test(artworkSrc))
check('artwork refund is NOT the old month-blind 2-arg form',
  !/refundUsage\(\s*userId\s*,\s*'artwork'\s*\)/.test(artworkSrc))

console.log('\n runway route — create+poll guarded + month threaded:')
check('create fetch (image_to_video) is inside a try{}',
  /try\s*\{/.test(runwaySrc.slice(runwaySrc.indexOf('const refund'), runwaySrc.indexOf('image_to_video'))))
check('the region-wrapping catch calls refund()', runwayOuterCatchRefunds(runwaySrc))
check("refund threads the reserved month: refundUsage(userId, 'video', gate.month)",
  /refundUsage\(\s*userId\s*,\s*'video'\s*,\s*gate\.month\s*\)/.test(runwaySrc))
check('runway refund is NOT the old month-blind 2-arg form',
  !/refundUsage\(\s*userId\s*,\s*'video'\s*\)/.test(runwaySrc))

// ── The SUCCEEDED-but-unsaved burn (found 2026-08-31) ────────────────────────
// Runway could succeed while persistence to mf-video failed or was skipped, and
// the route returned 200 {saved:false} having spent the slot. That is not a
// partial win: the Runway URL expires within hours, AiGeneratorCard gates its
// pin button on `saved`, and finalize-video requires a PINNED visualizer — so
// an unsaved clip can never enter the pipeline. The quota bought nothing.
//
// The two halves are one fix and neither is safe alone: refunding on !saved
// without requiring an owned project up front would let anyone farm unlimited
// free generations by passing a bogus projectId.
console.log('\n runway route — a generation that could not be persisted is refunded:')
check('an unsaved (unpersisted) generation refunds the video slot',
  /if \(!saved\)\s*\{[\s\S]{0,600}?await refund\(\)/.test(runwaySrc))
check('projectId is REQUIRED, not optional-with-a-skip',
  /if \(!isUuid\(projectId\)\)[\s\S]{0,160}?status: 400/.test(runwaySrc))
check('project ownership is verified and rejected with a status, not silently skipped',
  /if \(!\(await userOwnsProject\(userId, projectId\)\)\)[\s\S]{0,160}?status: 404/.test(runwaySrc))
// Ordering is the whole loophole guard: validate BEFORE the slot is reserved.
check('ownership is settled BEFORE the quota slot is reserved',
  runwaySrc.indexOf('await userOwnsProject(userId, projectId)') <
  runwaySrc.indexOf('await checkAndIncrementUsage(userId'))
// The old shape gated persistence on ownership inline, which is what made the
// skip silent. It must not come back.
check('persistence is no longer gated on an inline ownership check',
  !/if \(isUuid\(projectId\) && \(await userOwnsProject/.test(runwaySrc))
// WITNESS, run not assumed: the shape that shipped before today returns the
// response with saved:false and no refund anywhere between.
const OLD_RUNWAY_UNSAVED = `
        if (isUuid(projectId) && (await userOwnsProject(userId, projectId))) {
          try { /* persist */ } catch (e) {}
        }
        return NextResponse.json({ videoUrl, model: modelCfg.label, saved, visualizerId })`
check('WITNESS: pre-fix unsaved path had no refund and skipped silently',
  !/if \(!saved\)/.test(OLD_RUNWAY_UNSAVED)
  && /if \(isUuid\(projectId\) && \(await userOwnsProject/.test(OLD_RUNWAY_UNSAVED))

console.log('\n tier.ts — month reserved & threaded (not recomputed at refund):')
check('checkAndIncrementUsage return type carries month',
  /Promise<\{[^}]*month:\s*string[^}]*\}>/.test(tierSrc))
check('refundUsage accepts an explicit month param (defaulting to currentMonth)',
  /export async function refundUsage\([\s\S]{0,200}month:\s*string\s*=\s*currentMonth\(\)/.test(tierSrc))
check('refundUsage no longer recomputes its own month (const month = currentMonth removed from its body)',
  !/export async function refundUsage\([\s\S]{0,260}const month = currentMonth\(\)/.test(tierSrc))

// ── Fail-first WITNESS — the guards must reject the pre-fix code ──────────────
// Self-contained reconstructions of the exact pre-fix shapes (from git 1f9df10),
// proving these checks would have FAILED before this commit, not that they pass
// vacuously.
console.log('\n fail-first witness — guards catch the pre-fix code:')
const OLD_ARTWORK = `
  const imageRes = await fetch(outputUrl)
  if (!imageRes.ok) {
    await refund()
    return NextResponse.json({ error: 'Failed to download generated image' }, { status: 500 })
  }
  const imageBytes = Buffer.from(await imageRes.arrayBuffer())
  const contentType = imageRes.headers.get('content-type') ?? 'image/jpeg'
`
check('WITNESS: pre-fix artwork download was NOT try/catch-guarded',
  guardedByTryRefund(OLD_ARTWORK, 'fetch(outputUrl)') === false)
const OLD_ARTWORK_REFUND = `  const refund = () => refundUsage(userId, 'artwork')`
check('WITNESS: pre-fix artwork refund used the month-blind 2-arg form',
  /refundUsage\(\s*userId\s*,\s*'artwork'\s*\)/.test(OLD_ARTWORK_REFUND) &&
  !/gate\.month/.test(OLD_ARTWORK_REFUND))
const OLD_REFUND_FN = `export async function refundUsage(userId: string, feature: 'artwork' | 'video'): Promise<void> {
  const month = currentMonth()`
check('WITNESS: pre-fix refundUsage recomputed its own month (no month param)',
  /export async function refundUsage\([\s\S]{0,260}const month = currentMonth\(\)/.test(OLD_REFUND_FN) &&
  !/month:\s*string\s*=\s*currentMonth\(\)/.test(OLD_REFUND_FN))

// ── C) The double-refund guard (added 2026-08-05) ────────────────────────────
// `planUsageRefund` above proves refundUsage is NOT idempotent: 1 → 0 is a real
// decrement, so two calls for one reservation hand the user a free paid
// generation. The route used to rely on the claim that "every inner failure
// path refunds and RETURNS, so it never reaches the outer catch". That was
// false for exactly one branch: `!createRes.ok` refunds, then calls
// `createRes.text()` OUTSIDE the inner try — a connection reset while reading
// the error body unwinds to the outer catch and refunds a second time.
console.log('\n runway route — refund is idempotent by construction:')
check('refund() is latched behind a `refunded` flag',
  /let refunded = false/.test(runwaySrc) &&
  /const refund = async \(\) => \{[\s\S]{0,200}?if \(refunded\) return[\s\S]{0,200}?refunded = true/.test(runwaySrc))
check('the latch is set BEFORE the await, so concurrent calls cannot both pass',
  (() => {
    const fn = runwaySrc.slice(runwaySrc.indexOf('const refund = async'), runwaySrc.indexOf('const refund = async') + 260)
    return fn.indexOf('refunded = true') < fn.indexOf('await refundUsage')
  })())
// WITNESS, run not assumed: the shape that shipped before today would let the
// error-body read escape the inner try and reach the outer catch.
const OLD_RUNWAY_REFUND = `  const refund = () => refundUsage(userId, 'video', gate.month)`
check('WITNESS: pre-fix runway refund had no latch',
  !/refunded/.test(OLD_RUNWAY_REFUND))

// ── D) Every paid outbound call is bounded (added 2026-08-05) ────────────────
// undici enforces NO response timeout — only a connect timeout — so a provider
// that accepts the socket and then answers slowly (or drips one byte at a time)
// pins the handler and the reserved quota slot indefinitely. The refund paths
// all exist; the gap was that nothing ever aborted the request, so the refund
// could not run. Each of these anchors is a call that spends or holds quota.
console.log('\n paid provider calls all carry a deadline:')
function fetchAtHasSignal(src, anchor, win = 900) {
  const idx = src.indexOf(anchor)
  if (idx < 0) return false
  return /signal:\s*AbortSignal\.timeout\(/.test(src.slice(idx, idx + win))
}
check('artwork: Replicate create carries a deadline',
  fetchAtHasSignal(artworkSrc, 'Prefer: '))
check('artwork: image download carries a deadline',
  fetchAtHasSignal(artworkSrc, 'fetch(outputUrl'))
check('artwork: poll probe still carries a deadline (no regression)',
  /signal:\s*AbortSignal\.timeout\(POLL_TIMEOUT_MS\)/.test(artworkSrc))
check('runway: create carries a deadline',
  fetchAtHasSignal(runwaySrc, 'image_to_video'))
check('runway: poll probe carries a deadline',
  fetchAtHasSignal(runwaySrc, '/tasks/$'))
check('runway: video download carries a deadline',
  fetchAtHasSignal(runwaySrc, 'fetch(runwayUrl'))

// The poll loop must be bounded by WALL CLOCK, not attempt count. With a fixed
// 100 attempts and a 3s sleep, a provider answering in ~20s ran the loop for
// ~38 minutes holding a studio user's 1-of-10 slot, then reported "timed out
// (5 min)" — a message that was false.
check('runway: poll loop is bounded by wall clock, not attempt count',
  /const deadline = Date\.now\(\) \+ POLL_BUDGET_MS/.test(runwaySrc) &&
  /while \(Date\.now\(\) < deadline\)/.test(runwaySrc))
check('runway: the old attempt-count bound is gone',
  // Matches the declaration only — the rationale comment above the loop still
  // names maxAttempts, and should, so a bare /maxAttempts/ would be wrong.
  !/const maxAttempts\s*=/.test(runwaySrc))
check('runway: a permanently-rejected poll (401/403/404) bails instead of burning the budget',
  /pollRes\.status === 401 \|\| pollRes\.status === 403 \|\| pollRes\.status === 404/.test(runwaySrc))
check('runway: a missing task id fails fast rather than polling /tasks/undefined',
  /if \(!taskId\)/.test(runwaySrc))
check('runway: the timeout message is derived from the enforced budget',
  /POLL_BUDGET_MS \/ 60_000/.test(runwaySrc))
// WITNESS: the pre-fix loop shape, proving these checks discriminate.
const OLD_RUNWAY_POLL = `    const maxAttempts = 100
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 3000))
      const pollRes = await fetch(\`\${RUNWAY_BASE}/tasks/\${taskId}\`, { headers: {} })`
check('WITNESS: pre-fix runway poll was attempt-bounded with no deadline',
  /maxAttempts/.test(OLD_RUNWAY_POLL) &&
  !/Date\.now\(\) \+ POLL_BUDGET_MS/.test(OLD_RUNWAY_POLL) &&
  !/AbortSignal\.timeout/.test(OLD_RUNWAY_POLL))

if (failures > 0) {
  console.error(`\nusage-refund: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nusage-refund: all checks passed')
