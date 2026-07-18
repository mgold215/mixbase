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
  guardedByTryRefund(artworkSrc, 'fetch(outputUrl)'))
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

if (failures > 0) {
  console.error(`\nusage-refund: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nusage-refund: all checks passed')
