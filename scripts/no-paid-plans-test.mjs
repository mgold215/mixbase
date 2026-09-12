#!/usr/bin/env node
// Contract test: mixBase has NO paid plans — on the website, in the apps, anywhere.
//
// Decision 2026-09-12, after App Review's Guideline 2.1(b) business-model
// questions (submission 902f9887) and two 3.1.1 rejections before it: every
// account gets one and the same monthly allowance, nothing is sold on
// mixbase.app, and the only way we would ever charge is Apple's In-App
// Purchase. That answer is only as good as this source tree, so this suite
// pins every surface that used to sell or reference a plan:
//
//   - no Stripe: no routes, no package, no public webhook path, no cancel step
//   - no tiers: the quota library has one allowance and no prices/plan names
//   - no pricing on the homepage, no billing section in the Terms
//   - no tier controls in the admin panel or its chat tools
//   - no "upgrade" flag in AI-route responses (the apps scrub purchase words,
//     but there must be nothing to scrub)
//
// Pure source-contract test — no DB / network.
// Run: node scripts/no-paid-plans-test.mjs (also part of `npm test`)

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { stripComments } from './source-contract.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => stripComments(readFileSync(join(root, p), 'utf8'))
const raw = (p) => readFileSync(join(root, p), 'utf8')

let failures = 0
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

console.log('no-paid-plans: nothing is sold on the website or in the apps\n')

// ── 1. Stripe is gone ────────────────────────────────────────────────────────
for (const gone of ['src/app/api/stripe', 'src/app/api/subscription', 'src/app/api/infra/stripe', 'src/lib/infra/stripe.ts']) {
  check(`${gone} does not exist`, !existsSync(join(root, gone)))
}
const pkg = JSON.parse(raw('package.json'))
check('package.json has no stripe dependency', !('stripe' in (pkg.dependencies ?? {})) && !('stripe' in (pkg.devDependencies ?? {})))
check('proxy has no public Stripe webhook path', !/api\/stripe/.test(read('src/proxy.ts')))
const del = read('src/app/api/auth/delete-account/route.ts')
check('account deletion has no Stripe cancellation step', !/stripe/i.test(del))
check('.env.example documents no Stripe variables', !/STRIPE_/.test(raw('.env.example')))

// ── 2. One allowance, no tiers ───────────────────────────────────────────────
const tier = read('src/lib/tier.ts')
check('tier.ts exports a single MONTHLY_LIMITS allowance', /export const MONTHLY_LIMITS: GenerationLimits = \{ artworkGenerations: \d+, videoGenerations: \d+ \}/.test(tier))
check('tier.ts has no prices', !/TIER_PRICES|\$\d+(\.\d+)?\/mo/.test(tier))
check('tier.ts has no plan names', !/'pro'|'studio'|TIER_LIMITS/.test(tier))
check('tier.ts never reads the profile tier for a quota', !/subscription_tier[^\n]*select|getUserProfile/.test(tier))
check('the gate takes no client kind (everyone is the same)', /export async function checkAndIncrementUsage\(\s*userId: string,\s*feature: 'artwork' \| 'video',?\s*\)/.test(tier))
for (const route of ['src/app/api/generate-artwork/route.ts', 'src/app/api/visualizer/runway/route.ts']) {
  const src = read(route)
  check(`${route} gates without a tier or client kind`, /checkAndIncrementUsage\(userId, '(artwork|video)'\)/.test(src))
  check(`${route} sends no upgrade flag`, !/upgrade/i.test(src))
}

// ── 3. Nothing to buy on the website ─────────────────────────────────────────
const home = read('src/app/page.tsx')
check('homepage has no pricing section', !/pricing|TIER_|\/mo\b|Manage plan|Get Pro|Get Studio/i.test(home))
const terms = read('src/app/terms/page.tsx')
check('terms have no billing section', !/Subscriptions and billing|auto-renew|payment method|charge your|Prices may change/i.test(terms))
check('terms state the service is free', /free to use/i.test(terms))

// ── 4. Admin panel cannot grant a tier ──────────────────────────────────────
for (const file of [
  'src/app/admin/users/page.tsx',
  'src/app/admin/usage/page.tsx',
  'src/app/api/admin/users/route.ts',
  'src/app/api/admin/users/[id]/route.ts',
  'src/app/api/admin/stats/route.ts',
  'src/app/api/admin/chat/route.ts',
]) {
  const src = read(file).replace(/from '@\/lib\/tier'/g, '')
  check(`${file} has no tier controls`, !/subscription_tier|set_user_tier|VALID_TIERS|TIER_COLORS/.test(src))
}

// ── 5. The infra panel no longer models billing ─────────────────────────────
check('infra topology has no Stripe node', !/stripe/i.test(read('src/lib/infra/topology.ts')))
check('infra chat has no billing tool', !/stripe/i.test(read('src/app/api/infra/chat/route.ts')))

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed')
process.exit(failures ? 1 : 0)
