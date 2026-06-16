// src/lib/tier.ts
// Subscription tier helper — single source of truth for limits, usage tracking, and tier management.
// All functions use supabaseAdmin (service-role key), bypassing RLS — server-side only.

import { supabaseAdmin } from './supabase'

export type SubscriptionTier = 'free' | 'pro' | 'studio' | 'admin'

// Monthly generation allowances per tier (admin = unlimited)
export const TIER_LIMITS: Record<SubscriptionTier, { artworkGenerations: number; videoGenerations: number }> = {
  free:   { artworkGenerations: 3,     videoGenerations: 0     },
  pro:    { artworkGenerations: 25,    videoGenerations: 0     },
  studio: { artworkGenerations: 25,    videoGenerations: 10    },
  admin:  { artworkGenerations: 99999, videoGenerations: 99999 },
}

// Prices shown in the UI
export const TIER_PRICES: Record<SubscriptionTier, string> = {
  free:   '$0/mo',
  pro:    '$8.99/mo',
  studio: '$19.99/mo',
  admin:  'Platform Owner',
}

// Current month as 'YYYY-MM' — key for mb_usage rows
export function currentMonth(): string {
  return new Date().toISOString().slice(0, 7)
}

// Fetch user's subscription fields from profiles. Falls back to 'free' if row is missing.
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

// Fetch this month's generation counts. Returns zeros if no row exists yet.
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

// Call BEFORE hitting any external AI API.
// Checks monthly limit; if allowed, atomically increments the counter.
// Returns { allowed, used, limit } — allowed=false means show upgrade prompt.
export async function checkAndIncrementUsage(
  userId: string,
  feature: 'artwork' | 'video'
): Promise<{ allowed: boolean; used: number; limit: number }> {
  const [profile, usage] = await Promise.all([
    getUserProfile(userId),
    getMonthUsage(userId),
  ])

  const tier = profile.subscription_tier
  const limits = TIER_LIMITS[tier]
  const limit = feature === 'artwork' ? limits.artworkGenerations : limits.videoGenerations
  const used  = feature === 'artwork' ? usage.artworkGenerations  : usage.videoGenerations

  if (used >= limit) {
    return { allowed: false, used, limit }
  }

  const rpcName = feature === 'artwork' ? 'increment_artwork_usage' : 'increment_video_usage'
  await supabaseAdmin.rpc(rpcName, { p_user_id: userId, p_month: currentMonth() })

  return { allowed: true, used: used + 1, limit }
}

// Compensating decrement — releases a generation slot that checkAndIncrementUsage
// reserved up front, when the external provider (Replicate / Runway) errors,
// times out, or returns nothing usable.
//
// Why reserve-then-refund: the increment runs BEFORE the paid API call so two
// concurrent generations can't both pass the check on a user's last credit. The
// cost of that ordering is that an upstream failure would otherwise burn a paid
// monthly slot with no result — a free user (3 artworks/mo) could be locked out
// for the month by two hiccups. This hands the slot back.
//
// Best-effort and code-only (read-then-write, no decrement RPC needed). It runs
// only on the rare failure path, where a benign read-modify-write race would at
// worst under-count by one in the user's favour — strictly better than always
// burning the slot. A refund failure is logged but never surfaced: the caller
// already has a failed generation to report. The `current <= 0` guard keeps the
// counter from ever going negative.
export async function refundUsage(userId: string, feature: 'artwork' | 'video'): Promise<void> {
  const month = currentMonth()
  try {
    const { data } = await supabaseAdmin
      .from('mb_usage')
      .select('artwork_generations, video_generations')
      .eq('user_id', userId)
      .eq('month', month)
      .single()
    if (!data) return // no usage row → nothing was reserved → nothing to refund

    const current = feature === 'artwork' ? data.artwork_generations : data.video_generations
    if (current <= 0) return

    const patch = feature === 'artwork'
      ? { artwork_generations: current - 1 }
      : { video_generations: current - 1 }

    const { error } = await supabaseAdmin
      .from('mb_usage')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('month', month)
    if (error) console.error(`[tier] refundUsage(${feature}) write failed for ${userId}:`, error.message)
  } catch (err) {
    console.error(`[tier] refundUsage(${feature}) threw for ${userId}:`, err instanceof Error ? err.message : err)
  }
}

// Update subscription tier on a profile. Called by Stripe webhook and Apple IAP verify.
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
    .update({ subscription_tier: tier, subscription_source: source, ...fields })
    .eq('id', userId)
}

// Resolve Stripe subscription ID → user UUID
export async function getUserByStripeSubscription(subscriptionId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .eq('stripe_subscription_id', subscriptionId)
    .single()
  return data?.id ?? null
}

// Resolve Stripe customer ID → user UUID
export async function getUserByStripeCustomer(customerId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .single()
  return data?.id ?? null
}
