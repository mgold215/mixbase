// Stripe billing status for the infra control panel.
//
// Tier distribution comes from the profiles table (always available via the
// service-role client). Actual active-subscription count comes from the Stripe
// API when STRIPE_SECRET_KEY is set; otherwise that field is null. Never throws.

import Stripe from 'stripe'
import { supabaseAdmin } from '@/lib/supabase'

// Monthly price per paid tier, in cents (mirrors TIER_PRICES in src/lib/tier.ts).
const PRICE_CENTS: Record<string, number> = { pro: 899, studio: 1999 }

export interface StripeStatus {
  configured: boolean // STRIPE_SECRET_KEY present
  tierCounts: Record<string, number>
  estimatedMrrCents: number
  activeSubscriptions: number | null
  error?: string
}

export async function getStripeStatus(): Promise<StripeStatus> {
  // Tier distribution from profiles — always available.
  const tierCounts: Record<string, number> = { free: 0, pro: 0, studio: 0, admin: 0 }
  try {
    const { data } = await supabaseAdmin.from('profiles').select('subscription_tier')
    for (const p of data ?? []) {
      const t = (p as { subscription_tier?: string }).subscription_tier ?? 'free'
      tierCounts[t] = (tierCounts[t] ?? 0) + 1
    }
  } catch {
    /* leave zeros */
  }
  const estimatedMrrCents = tierCounts.pro * PRICE_CENTS.pro + tierCounts.studio * PRICE_CENTS.studio

  const key = process.env.STRIPE_SECRET_KEY
  if (!key) {
    return { configured: false, tierCounts, estimatedMrrCents, activeSubscriptions: null }
  }
  try {
    const stripe = new Stripe(key)
    const subs = await stripe.subscriptions.list({ status: 'active', limit: 100 })
    return { configured: true, tierCounts, estimatedMrrCents, activeSubscriptions: subs.data.length }
  } catch (e) {
    return {
      configured: true,
      tierCounts,
      estimatedMrrCents,
      activeSubscriptions: null,
      error: e instanceof Error ? e.message : 'stripe query failed',
    }
  }
}
