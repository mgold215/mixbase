// src/app/api/stripe/create-checkout/route.ts
import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { supabaseAdmin } from '@/lib/supabase'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? 'sk_test_placeholder')

const PLAN_PRICE_MAP: Record<string, string | undefined> = {
  pro:    process.env.STRIPE_PRO_PRICE_ID,
  studio: process.env.STRIPE_STUDIO_PRICE_ID,
}

export async function POST(request: NextRequest) {
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
    subscription_data: {
      metadata: { userId },
    },
  })

  return NextResponse.json({ url: session.url })
}
