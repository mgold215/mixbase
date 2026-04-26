// src/app/api/stripe/portal/route.ts
import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { getUserProfile } from '@/lib/tier'

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null

export async function POST(request: NextRequest) {
  if (!stripe) return NextResponse.json({ error: 'Stripe not configured' }, { status: 503 })

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
