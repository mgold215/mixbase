// src/app/api/stripe/create-checkout/route.ts
import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { supabaseAdmin } from '@/lib/supabase'
import { getUserProfile } from '@/lib/tier'

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null

const PLAN_PRICE_MAP: Record<string, string | undefined> = {
  pro:    process.env.STRIPE_PRO_PRICE_ID,
  studio: process.env.STRIPE_STUDIO_PRICE_ID,
}

export async function POST(request: NextRequest) {
  if (!stripe) return NextResponse.json({ error: 'Stripe not configured' }, { status: 503 })

  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { plan } = await request.json()
  const priceId = PLAN_PRICE_MAP[plan]
  if (!priceId) return NextResponse.json({ error: 'Invalid plan' }, { status: 400 })

  const [{ data: { user } }, profile] = await Promise.all([
    supabaseAdmin.auth.admin.getUserById(userId),
    getUserProfile(userId),
  ])
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const origin = request.headers.get('origin') ?? 'https://mixbase.app'

  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: userId,
    success_url: `${origin}/profile?subscribed=1`,
    cancel_url: `${origin}/upgrade`,
    subscription_data: { metadata: { userId } },
  }
  // Reuse existing Stripe customer if available, otherwise pass email for new customer
  if (profile.stripe_customer_id) {
    sessionParams.customer = profile.stripe_customer_id
  } else {
    sessionParams.customer_email = user.email
  }

  const session = await stripe.checkout.sessions.create(sessionParams)

  return NextResponse.json({ url: session.url })
}
