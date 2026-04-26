// src/lib/tier.ts
// Subscription tier helper — single source of truth for limits, usage tracking, and tier management.
// All functions use supabaseAdmin (service-role key) so they bypass RLS and work server-side only.

import { supabaseAdmin } from './supabase'

// The three tiers a user can be on
export type SubscriptionTier = 'free' | 'pro' | 'studio'

// How many generations each tier gets per calendar month
export const TIER_LIMITS: Record<SubscriptionTier, { artworkGenerations: number; videoGenerations: number }> = {
  free:   { artworkGenerations: 0,  videoGenerations: 0  },
  pro:    { artworkGenerations: 25, videoGenerations: 0  },
  studio: { artworkGenerations: 25, videoGenerations: 10 },
}

// Display prices shown in the UI
export const TIER_PRICES: Record<SubscriptionTier, string> = {
  free:   '$0/mo',
  pro:    '$8.99/mo',
  studio: '$19.99/mo',
}

// Returns the current month as 'YYYY-MM' — used as the key in mb_usage rows
export function currentMonth(): string {
  return new Date().toISOString().slice(0, 7)
}

// Fetches the user's subscription fields from the profiles table.
// Falls back to 'free' tier if the row doesn't exist or is missing the field.
export async function getUserProfile(userId: string): Promise<{
  subscription_tier: SubscriptionTier
  subscription_source: string | null
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
}> {
  const { data } = await supabaseAdmin
    .from('profiles')
    .select('subscription_tier, subscription_source, stripe_customer_id, stripe_subscription_id')
    .eq('id', userId)
    .single()
  return {
    subscription_tier: (data?.subscription_tier as SubscriptionTier) ?? 'free',
    subscription_source: data?.subscription_source ?? null,
    stripe_customer_id: data?.stripe_customer_id ?? null,
    stripe_subscription_id: data?.stripe_subscription_id ?? null,
  }
}

// Fetches this month's generation counts from mb_usage.
// Returns zeros if no row exists yet (first use of the month).
export async function getMonthUsage(userId: string): Promise<{ artworkGenerations: number; videoGenerations: number }> {
  const { data } = await supabaseAdmin
    .from('mb_usage')
    .select('artwork_generations, video_generations')
    .eq('user_id', userId)
    .eq('month', currentMonth())
    .single()
  return {
    artworkGenerations: data?.artwork_generations ?? 0,
    videoGenerations: data?.video_generations ?? 0,
  }
}

// Gate function — call this BEFORE hitting any external AI API.
// Checks whether the user is within their monthly limit for the given feature.
// If allowed, atomically increments the usage counter via a Postgres function
// (which has REVOKE'd access from anon/authenticated — only service-role can call it).
// Returns: { allowed, used, limit }
//   allowed = false → user is at or over their limit; show upgrade prompt
//   allowed = true  → generation is permitted; used reflects the new count after increment
export async function checkAndIncrementUsage(
  userId: string,
  feature: 'artwork' | 'video'
): Promise<{ allowed: boolean; used: number; limit: number }> {
  // Fetch profile and usage in parallel to minimise latency
  const [profile, usage] = await Promise.all([
    getUserProfile(userId),
    getMonthUsage(userId),
  ])

  const tier = profile.subscription_tier
  const limits = TIER_LIMITS[tier]
  const limit = feature === 'artwork' ? limits.artworkGenerations : limits.videoGenerations
  const used  = feature === 'artwork' ? usage.artworkGenerations  : usage.videoGenerations

  // Over (or at) the limit — do not increment
  if (used >= limit) {
    return { allowed: false, used, limit }
  }

  // Atomically increment via the Postgres function (creates the mb_usage row if needed)
  const rpcName = feature === 'artwork' ? 'increment_artwork_usage' : 'increment_video_usage'
  await supabaseAdmin.rpc(rpcName, { p_user_id: userId, p_month: currentMonth() })

  return { allowed: true, used: used + 1, limit }
}

// Sets the subscription tier on a user's profile row.
// Called by the Stripe webhook handler and the Apple IAP verify endpoint.
// 'fields' is optional extra data (Stripe IDs, Apple transaction ID, expiry date).
export async function setSubscriptionTier(
  userId: string,
  tier: SubscriptionTier,
  source: 'stripe' | 'apple',
  fields?: {
    stripe_customer_id?: string
    stripe_subscription_id?: string | null
    apple_original_transaction_id?: string
    subscription_expires_at?: string | null
  }
) {
  await supabaseAdmin
    .from('profiles')
    .update({
      subscription_tier: tier,
      subscription_source: source,
      ...fields,
    })
    .eq('id', userId)
}

// Resolves a Stripe subscription ID → user UUID.
// Used by subscription.updated and subscription.deleted webhook events.
export async function getUserByStripeSubscription(subscriptionId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .eq('stripe_subscription_id', subscriptionId)
    .single()
  return data?.id ?? null
}

// Resolves a Stripe customer ID → user UUID.
// Used by checkout.session.completed and invoice.paid webhook events.
export async function getUserByStripeCustomer(customerId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .single()
  return data?.id ?? null
}
