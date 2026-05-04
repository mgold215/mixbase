// POST /api/stripe/webhook
// Handles Stripe subscription lifecycle events.
// Public route — Stripe sends these without user cookies.
// Integrity verified by STRIPE_WEBHOOK_SECRET signature check.
import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import {
  setSubscriptionTier,
  getUserByStripeSubscription,
  getUserByStripeCustomer,
  type SubscriptionTier,
} from '@/lib/tier'

function tierFromPriceId(priceId: string): SubscriptionTier {
  if (priceId === process.env.STRIPE_PRO_PRICE_ID) return 'pro'
  if (priceId === process.env.STRIPE_STUDIO_PRICE_ID) return 'studio'
  return 'free'
}

export async function POST(req: NextRequest) {
  const secretKey = process.env.STRIPE_SECRET_KEY
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secretKey || !webhookSecret) {
    return NextResponse.json({ error: 'Stripe not configured' }, { status: 500 })
  }

  const stripe = new Stripe(secretKey)

  const rawBody = await req.text()
  const sig = req.headers.get('stripe-signature')

  if (!sig) return NextResponse.json({ error: 'Missing stripe-signature' }, { status: 400 })

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret)
  } catch {
    return NextResponse.json({ error: 'Webhook signature verification failed' }, { status: 400 })
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session
      if (session.mode !== 'subscription') break

      const userId = session.client_reference_id
      if (!userId) break

      const subscription = await stripe.subscriptions.retrieve(session.subscription as string, {
        expand: ['items.data.price'],
      })
      const priceId = subscription.items.data[0]?.price.id ?? ''
      const tier = tierFromPriceId(priceId)

      await setSubscriptionTier(userId, tier, 'stripe', {
        stripe_customer_id: session.customer as string,
        stripe_subscription_id: session.subscription as string,
      })
      break
    }

    case 'customer.subscription.updated': {
      const subscription = event.data.object as Stripe.Subscription
      const userId = await getUserByStripeSubscription(subscription.id)
        ?? await getUserByStripeCustomer(subscription.customer as string)
      if (!userId) break

      const priceId = subscription.items.data[0]?.price.id ?? ''
      const tier = tierFromPriceId(priceId)

      await setSubscriptionTier(userId, tier, 'stripe', {
        stripe_customer_id: subscription.customer as string,
        stripe_subscription_id: subscription.id,
      })
      break
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription
      const userId = await getUserByStripeSubscription(subscription.id)
        ?? await getUserByStripeCustomer(subscription.customer as string)
      if (!userId) break

      await setSubscriptionTier(userId, 'free', 'stripe', {
        stripe_subscription_id: null,
      })
      break
    }
  }

  return NextResponse.json({ received: true })
}
