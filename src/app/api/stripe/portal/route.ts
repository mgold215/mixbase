// src/app/api/stripe/portal/route.ts
import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { getUserProfile } from '@/lib/tier'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? 'sk_test_placeholder')

export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const profile = await getUserProfile(userId)
  if (!profile.stripe_customer_id) {
    return NextResponse.json({ error: 'No Stripe subscription found' }, { status: 400 })
  }

  const origin = request.headers.get('origin') ?? 'https://mixbase.app'

  const session = await stripe.billingPortal.sessions.create({
    customer: profile.stripe_customer_id,
    return_url: `${origin}/profile`,
  })

  return NextResponse.json({ url: session.url })
}
