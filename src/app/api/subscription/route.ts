// GET /api/subscription
// Returns the authenticated user's current tier, limits, and usage.
import { NextRequest, NextResponse } from 'next/server'
import { getUserProfile, getMonthUsage, TIER_LIMITS, TIER_PRICES, NATIVE_APP_LIMITS, clientKind } from '@/lib/tier'

export async function GET(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  // Native apps are subscription-blind (see NATIVE_APP_LIMITS): they get the
  // uniform allowance and never learn about a web subscription.
  if (clientKind(request.headers) === 'native') {
    const usage = await getMonthUsage(userId)
    return NextResponse.json({
      tier: 'free',
      source: null,
      price: TIER_PRICES.free,
      limits: NATIVE_APP_LIMITS,
      usage,
      hasStripeSubscription: false,
    })
  }

  const [profile, usage] = await Promise.all([
    getUserProfile(userId),
    getMonthUsage(userId),
  ])

  const tier = profile.subscription_tier
  const limits = TIER_LIMITS[tier]

  return NextResponse.json({
    tier,
    source: profile.subscription_source,
    price: TIER_PRICES[tier],
    limits,
    usage,
    hasStripeSubscription: !!profile.stripe_subscription_id,
  })
}
