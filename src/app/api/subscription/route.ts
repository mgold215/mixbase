// src/app/api/subscription/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { getUserProfile, getMonthUsage, TIER_LIMITS, TIER_PRICES } from '@/lib/tier'

export async function GET(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

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
