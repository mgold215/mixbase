// src/lib/admin-identity.ts
// Who is allowed through an admin gate.
//
// ── Why this exists ───────────────────────────────────────────────────────────
// Every admin gate used to ask exactly one question: is profiles.subscription_tier
// equal to 'admin'? That string is not a safe thing to ask, because the user can
// write it themselves. Verified in production 2026-09-01:
//
//   select has_column_privilege('authenticated','public.profiles','subscription_tier','UPDATE');
//   -> true      (same for 'anon', and for is_owner and id)
//
// RLS on profiles is enabled, but users_update_own_profile scopes the ROW
// (id = auth.uid()), not the COLUMN — so the policy happily authorises a user
// rewriting their OWN row. There are no triggers on the table, and the check
// constraint profiles_subscription_tier_check explicitly lists 'admin' as a
// permitted value. So one PATCH of your own profile promoted you to admin, which
// src/proxy.ts gates /admin, /api/admin/* and /api/infra/* on — the last of those
// being Railway restart/redeploy and CI re-run.
//
// Migration 036 REVOKEs that column privilege and is the proper fix, but it has
// to be applied by hand and has been outstanding for four days. This module
// closes the hole in code instead, and is worth keeping even after 036 lands:
// defence in depth, and the DB grant is no longer the only thing standing
// between a free account and the infra panel.
//
// ── The fix ───────────────────────────────────────────────────────────────────
// Ask an identity question the user cannot answer for themselves. An account's
// email lives in auth.users, not in a table the client can write, and a user
// cannot take an address that already belongs to another account. That list
// already existed (it drove the quota exemption in tier.ts); the admin gates
// simply never consulted it. subscription_tier is now a CONSEQUENCE of being an
// admin, never the PROOF of it.
//
// ADMIN_USER_IDS is the escape hatch: a comma-separated list of user UUIDs, so a
// second admin can be added by setting an env var rather than editing this file.
// Unset is the normal case and means "owner emails only".

import { supabaseAdmin } from './supabase'

// Addresses that own the platform. Not configurable by design — an env var here
// would be one more thing that, if it went missing on a deploy, silently widens
// the gate. Adding an admin is a code change or ADMIN_USER_IDS.
//
// ⚠️ VERIFY AGAINST auth.users BEFORE EDITING THIS SET. It is the only thing
// standing between the owner and a locked admin panel, and it was wrong until
// 2026-09-01: the set held ONLY moodmixformat@icloud.com, and no account with
// that address has ever existed. The real owner account is the gmail one below
// (id 51c90f09-…, 53 projects / 317 versions, tier 'admin' since 2026-04-24).
//
// That mattered more than a stale constant usually does, because of what this
// set was previously used for. tier.ts documented an "owner email bootstrap"
// that self-heals the profile row to 'admin' — it has never once fired in
// production, because it was matching an address nobody owns. The owner's
// exemption worked only via the subscription_tier fallback that this change
// removes, so shipping the gate without checking this set would have taken away
// both his admin panel and his unlimited quota in the same commit.
//
// The icloud address is kept deliberately: it is the owner's other address, and
// an account created with it later should not be locked out.
export const OWNER_EMAILS = new Set([
  'moodmixformat@gmail.com',
  'moodmixformat@icloud.com',
])

// Optional additional allowlist, by user id.
function extraAdminIds(): Set<string> {
  const raw = process.env.ADMIN_USER_IDS
  if (!raw) return new Set()
  return new Set(
    raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  )
}

// Cached per process — an admin request would otherwise cost an extra auth
// lookup every time, including inside middleware. Only TRUE results are cached.
// A false is never cached: it is the answer we would most regret pinning, since
// it would survive the owner's profile being repaired for the rest of the deploy.
const adminCache = new Map<string, true>()

// The single question every admin gate should ask.
//
// Fails CLOSED. If the auth lookup errors we return false and let the caller
// deny — an admin surface that opens on a transient Supabase blip is worth less
// than one that occasionally makes the owner retry. (Contrast isPlatformOwner in
// tier.ts, which fails OPEN on purpose: applying normal quota limits for one
// request is a much smaller harm than blocking a generation.)
export async function isAdminIdentity(userId: string): Promise<boolean> {
  if (!userId) return false
  if (adminCache.has(userId)) return true

  if (extraAdminIds().has(userId.toLowerCase())) {
    adminCache.set(userId, true)
    return true
  }

  try {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId)
    if (error) {
      console.error('[admin-identity] getUserById failed:', error.message)
      return false
    }
    const email = data?.user?.email?.toLowerCase()
    if (email && OWNER_EMAILS.has(email)) {
      adminCache.set(userId, true)
      return true
    }
    return false
  } catch (err) {
    console.error('[admin-identity] lookup threw:', err instanceof Error ? err.message : err)
    return false
  }
}
