// POST /api/stripe/create-checkout
// Creates a Stripe Checkout session for a subscription plan.
// Requires auth — X-User-Id injected by middleware.
import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { supabaseAdmin } from '@/lib/supabase'

export async function POST(request: NextRequest) {
  const secretKey = process.env.STRIPE_SECRET_KEY
  if (!secretKey) return NextResponse.json({ error: 'Stripe not configured' }, { status: 500 })

  const stripe = new Stripe(secretKey)

  const PLAN_PRICE_MAP: Record<string, string | undefined> = {
    pro:    process.env.STRIPE_PRO_PRICE_ID,
    studio: process.env.STRIPE_STUDIO_PRICE_ID,
  }

  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { plan } = await request.json()
  const priceId = PLAN_PRICE_MAP[plan]
  if (!priceId) return NextResponse.json({ error: 'Invalid plan' }, { status: 400 })

  const { data: { user } } = await supabaseAdmin.auth.admin.getUserById(userId)
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const origin = request.headers.get('origin') ?? 'https://mixbase.app'

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    customer_email: user.email,
    client_reference_id: userId,
    success_url: `${origin}/profile?subscribed=1`,
    cancel_url: `${origin}/upgrade`,
    subscription_data: { metadata: { userId } },
  })

  return NextResponse.json({ url: session.url })
}
