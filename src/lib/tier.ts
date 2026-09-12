// src/lib/tier.ts
// Monthly AI-generation allowance — single source of truth for limits and usage tracking.
// All functions use supabaseAdmin (service-role key), bypassing RLS — server-side only.
//
// mixBase has NO paid plans (decision 2026-09-12, after App Review's 2.1(b)
// business-model questions): every account gets the same allowance below, on
// every platform, and nothing is sold on the website or in the apps. If we
// ever charge, it will be through the App Store's In-App Purchase only. The
// only exception is the platform owner/admin (an identity, not a purchase —
// see isPlatformOwner), who is unlimited.

import { supabaseAdmin } from './supabase'
import { ensureUsageRpc, isMissingUsageRpc, ensureUsageRpcGrants, ensureUsageTableWriteLock } from './schema-heal'
import { planUsageRefund } from './usage-refund'
import { isAdminIdentity } from './admin-identity'

export type GenerationLimits = { artworkGenerations: number; videoGenerations: number }

// The one allowance every account gets. Cloud video (Runway) stays owner-only:
// it is metered per generation and has no free lane; the apps and the web
// FreeStudio render visualizers locally/for free instead.
export const MONTHLY_LIMITS: GenerationLimits = { artworkGenerations: 3, videoGenerations: 0 }
export const ADMIN_LIMITS: GenerationLimits = { artworkGenerations: 99999, videoGenerations: 99999 }

// Current month as 'YYYY-MM' — key for mb_usage rows
export function currentMonth(): string {
  return new Date().toISOString().slice(0, 7)
}

// ── Platform owner exemption ──────────────────────────────────────────────────
// The owner's account is exempt from every monthly quota and per-user rate
// limit.
//
// Identity comes from isAdminIdentity() (auth.users email / ADMIN_USER_IDS), NOT
// from subscription_tier. Trusting the tier here was the same self-grant hole the
// admin gates had, with a bill attached: ADMIN_LIMITS is 99999 artwork and
// 99999 video generations, so one PATCH of your own profile bought unmetered
// Replicate and Runway spend on our account. See src/lib/admin-identity.ts.
//
// The profile heal stays. It is now a CONSEQUENCE of having been recognised as
// the owner rather than the thing that proves it, which keeps the tier column
// (and everything that displays it) agreeing with reality.
// Cached per process — one lookup per user per deploy.
const ownerCache = new Map<string, boolean>()

export async function isPlatformOwner(userId: string): Promise<boolean> {
  const cached = ownerCache.get(userId)
  if (cached !== undefined) return cached

  let owner = false
  try {
    owner = await isAdminIdentity(userId)
    if (owner) {
      // Persist so the profiles row agrees with reality (subscription_tier is
      // informational now — 'admin' or 'free'). Fire-and-forget: the exemption
      // must not block. Cheap and idempotent — a no-op once the row says 'admin'.
      void supabaseAdmin
        .from('profiles')
        .update({ subscription_tier: 'admin' })
        .eq('id', userId)
        .neq('subscription_tier', 'admin')
        .then(({ error }) => {
          if (error) console.error('[tier] owner profile heal failed:', error.message)
        })
    }
  } catch (err) {
    // Lookup failed — apply normal limits this request, don't cache the failure.
    console.error('[tier] isPlatformOwner lookup failed:', err instanceof Error ? err.message : err)
    return false
  }

  ownerCache.set(userId, owner)
  return owner
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
// Checks the monthly allowance; if allowed, atomically increments the counter.
// Returns { allowed, used, limit } — allowed=false means the allowance is used
// up until next month (there is nothing to buy; never show purchase copy).
export async function checkAndIncrementUsage(
  userId: string,
  feature: 'artwork' | 'video',
): Promise<{ allowed: boolean; used: number; limit: number; error?: boolean; month: string }> {
  const limit = feature === 'artwork' ? MONTHLY_LIMITS.artworkGenerations : MONTHLY_LIMITS.videoGenerations
  // Capture the reserved month and hand it back so the caller can refund the
  // SAME month it reserved. A generation that spans 00:00 UTC on the 1st would
  // otherwise refund currentMonth() (the new month) and leave the reserved slot
  // (old month) burned. Callers thread this into refundUsage(..., gate.month).
  const month = currentMonth()

  // Platform owner / admin: unlimited. Skip the quota reservation entirely so
  // even a usage-RPC outage can never block the owner's generations. Checked
  // BEFORE the zero-limit reject so the owner passes for video too.
  if (await isPlatformOwner(userId)) {
    return {
      allowed: true,
      used: 0,
      limit: feature === 'artwork' ? ADMIN_LIMITS.artworkGenerations : ADMIN_LIMITS.videoGenerations,
      month,
    }
  }

  // Zero-limit feature (cloud video for everyone but the owner) — reject
  // without touching the DB.
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
// cost of that ordering is that an upstream failure would otherwise burn a
// monthly slot with no result — a user (3 artworks/mo) could be locked out
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
