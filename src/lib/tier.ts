// src/lib/tier.ts
// Subscription tier helper — single source of truth for limits, usage tracking, and tier management.
// All functions use supabaseAdmin (service-role key), bypassing RLS — server-side only.

import { supabaseAdmin } from './supabase'
import { ensureUsageRpc, isMissingUsageRpc, ensureUsageRpcGrants, ensureUsageTableWriteLock } from './schema-heal'
import { planUsageRefund } from './usage-refund'

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

// ── Platform owner exemption ──────────────────────────────────────────────────
// The owner's account is exempt from every monthly quota and per-user rate
// limit. Identified by subscription_tier 'admin', or by the owner email as a
// bootstrap: the email path self-heals the profile row to 'admin' so the
// exemption (and the admin-gated infra panel) works without any manual DB step.
// Cached per process — one lookup per user per deploy.
const OWNER_EMAILS = new Set(['moodmixformat@icloud.com'])
const ownerCache = new Map<string, boolean>()

export async function isPlatformOwner(userId: string): Promise<boolean> {
  const cached = ownerCache.get(userId)
  if (cached !== undefined) return cached

  let owner = false
  try {
    const { data } = await supabaseAdmin
      .from('profiles')
      .select('subscription_tier')
      .eq('id', userId)
      .single()
    if (data?.subscription_tier === 'admin') {
      owner = true
    } else {
      const { data: userData } = await supabaseAdmin.auth.admin.getUserById(userId)
      const email = userData?.user?.email?.toLowerCase()
      if (email && OWNER_EMAILS.has(email)) {
        owner = true
        // Persist so every other admin gate (assertAdmin, /api/subscription)
        // agrees from now on. Fire-and-forget: the exemption must not block.
        void supabaseAdmin
          .from('profiles')
          .update({ subscription_tier: 'admin' })
          .eq('id', userId)
          .then(({ error }) => {
            if (error) console.error('[tier] owner profile heal failed:', error.message)
          })
      }
    }
  } catch (err) {
    // Lookup failed — apply normal limits this request, don't cache the failure.
    console.error('[tier] isPlatformOwner lookup failed:', err instanceof Error ? err.message : err)
    return false
  }

  ownerCache.set(userId, owner)
  return owner
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
): Promise<{ allowed: boolean; used: number; limit: number; error?: boolean; month: string }> {
  const profile = await getUserProfile(userId)
  const tier = profile.subscription_tier
  const limits = TIER_LIMITS[tier]
  const limit = feature === 'artwork' ? limits.artworkGenerations : limits.videoGenerations
  // Capture the reserved month and hand it back so the caller can refund the
  // SAME month it reserved. A generation that spans 00:00 UTC on the 1st would
  // otherwise refund currentMonth() (the new month) and leave the reserved slot
  // (old month) burned. Callers thread this into refundUsage(..., gate.month).
  const month = currentMonth()

  // Platform owner / admin: unlimited. Skip the quota reservation entirely so
  // even a usage-RPC outage can never block the owner's generations. Checked
  // BEFORE the zero-limit reject so the owner passes even on a 'free' profile
  // (isPlatformOwner then heals the profile to 'admin').
  if (tier === 'admin' || await isPlatformOwner(userId)) {
    const adminLimits = TIER_LIMITS.admin
    return {
      allowed: true,
      used: 0,
      limit: feature === 'artwork' ? adminLimits.artworkGenerations : adminLimits.videoGenerations,
      month,
    }
  }

  // Zero-limit feature (e.g. free/pro video) — reject without touching the DB.
  if (limit <= 0) return { allowed: false, used: 0, limit, month }

  // Atomic reserve: try_increment_usage takes a row lock so the limit check and
  // the increment are a single step — two concurrent generations on a user's
  // last credit cannot both pass (the old read-then-increment could).
  let res = await supabaseAdmin
    .rpc('try_increment_usage', { p_user_id: userId, p_month: month, p_feature: feature, p_limit: limit })
    .single<{ allowed: boolean; used: number }>()

  // Deploy may have raced migration 017 — heal the function and retry once.
  if (res.error && isMissingUsageRpc(res.error)) {
    await ensureUsageRpc()
    res = await supabaseAdmin
      .rpc('try_increment_usage', { p_user_id: userId, p_month: month, p_feature: feature, p_limit: limit })
      .single<{ allowed: boolean; used: number }>()
  }

  if (res.error) {
    // RPC still unavailable — fall back to the legacy (non-atomic) reserve so a
    // missing function degrades to previous behaviour rather than hard-blocking.
    console.error(`[tier] try_increment_usage failed for ${userId}:`, res.error.message)
    return legacyCheckAndIncrement(userId, feature, limit, month)
  }

  // The RPC answered, so the function exists on this environment. Re-assert the
  // two usage-write lockdowns once per process — both bypass the app entirely
  // via direct PostgREST: the RPC's default PUBLIC execute grant (migration 018)
  // and mb_usage's own client INSERT/UPDATE policies (migration 025), either of
  // which lets a signed-in user inflate or reset their quota. Fire-and-forget:
  // the reserve already succeeded and these are pure hardening, so they must not
  // block the caller.
  void ensureUsageRpcGrants()
  void ensureUsageTableWriteLock()

  if (!res.data) return { allowed: false, used: 0, limit, error: true, month }
  return { allowed: res.data.allowed, used: res.data.used, limit, month }
}

// Legacy read-check-then-increment path. Only reached if try_increment_usage is
// unavailable (never deployed and heal failed). Preserves the pre-017 behaviour
// including its fail-closed handling, so we never regress below what shipped.
async function legacyCheckAndIncrement(
  userId: string,
  feature: 'artwork' | 'video',
  limit: number,
  month: string,
): Promise<{ allowed: boolean; used: number; limit: number; error?: boolean; month: string }> {
  const usage = await getMonthUsage(userId)
  const used = feature === 'artwork' ? usage.artworkGenerations : usage.videoGenerations
  if (used >= limit) return { allowed: false, used, limit, month }

  const rpcName = feature === 'artwork' ? 'increment_artwork_usage' : 'increment_video_usage'
  const { error: rpcError } = await supabaseAdmin.rpc(rpcName, { p_user_id: userId, p_month: month })
  if (rpcError) {
    console.error(`[tier] ${rpcName} failed for ${userId}:`, rpcError.message)
    return { allowed: false, used, limit, error: true, month }
  }
  return { allowed: true, used: used + 1, limit, month }
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
// Pass the SAME `month` checkAndIncrementUsage returned (gate.month). Defaults to
// currentMonth() for back-compat, but a generation that straddles a UTC month
// boundary must refund the reserved month, not the new one — otherwise the
// reserved slot stays burned and the new month is spuriously credited.
//
// Best-effort and code-only (read-then-write, no decrement RPC needed). It runs
// only on the rare failure path, where a benign read-modify-write race would at
// worst under-count by one in the user's favour — strictly better than always
// burning the slot. A refund failure is logged but never surfaced: the caller
// already has a failed generation to report.
export async function refundUsage(
  userId: string,
  feature: 'artwork' | 'video',
  month: string = currentMonth(),
): Promise<void> {
  try {
    const { data } = await supabaseAdmin
      .from('mb_usage')
      .select('artwork_generations, video_generations')
      .eq('user_id', userId)
      .eq('month', month)
      .single()

    const patch = planUsageRefund(feature, data)
    if (!patch) return // no row, or already at 0 → nothing to hand back

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
