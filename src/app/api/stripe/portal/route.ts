// POST /api/stripe/portal
// Creates a Stripe Billing Portal session for managing subscriptions.
// Requires auth — X-User-Id injected by middleware.
import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { getUserProfile } from '@/lib/tier'

export async function POST(request: NextRequest) {
  const secretKey = process.env.STRIPE_SECRET_KEY
  if (!secretKey) return NextResponse.json({ error: 'Stripe not configured' }, { status: 500 })

  const stripe = new Stripe(secretKey)

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
