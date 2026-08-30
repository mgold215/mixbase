-- 036: revoke client UPDATE on the billing and privilege columns of profiles
--      (2026-08-29)
--
-- THE HOLE. The RLS policy on profiles is:
--
--   users_update_own_profile | UPDATE | using (id = auth.uid()) with check (id = auth.uid())
--
-- That constrains WHICH ROW a signed-in user may update. It says nothing about
-- WHICH COLUMNS — and `authenticated` (and `anon`) held column-level UPDATE on
-- every column of the table, with no trigger anywhere to second-guess a write.
--
-- So any signed-in user could send the same request the iOS Settings screen
-- sends to save an artist name, with a different body:
--
--   PATCH /rest/v1/profiles?id=eq.<their own uid>
--   {"subscription_tier":"admin"}
--
-- and src/proxy.ts:222 gates /admin, /api/admin AND /api/infra on exactly that
-- one column. The escalation therefore granted the paid tiers' quotas AND the
-- infra control panel, whose POST /api/infra/actions can restart and redeploy
-- Railway services and re-run CI.
--
-- WHY THIS IS SAFE TO REVOKE. Every writer of these columns in the application
-- goes through supabaseAdmin (service_role): the Stripe webhook, the admin
-- routes, admin chat, and PATCH /api/auth/me. service_role has its own grants
-- and bypasses RLS, so none of them is affected. The only client-side profile
-- write in the product is iOS updateArtistName (SupabaseService.swift), which
-- touches artist_name alone — deliberately still granted below, along with the
-- rest of the genuinely user-owned profile fields.
--
-- `id` is included because a client that can rewrite its own primary key can
-- move its row onto another account's id, which the with-check clause evaluates
-- AFTER the change and would therefore permit.
--
-- Reversible: `grant update (<column>) on profiles to authenticated;` restores
-- any single column if a future client legitimately needs to write it. Prefer
-- routing that write through a server route instead.

revoke update (
  subscription_tier,
  subscription_source,
  subscription_expires_at,
  stripe_customer_id,
  stripe_subscription_id,
  apple_original_transaction_id,
  is_owner,
  id
) on profiles from authenticated, anon;

-- Belt and braces: make the intent explicit rather than relying on the absence
-- of a grant. These are the columns a client legitimately owns.
grant update (
  artist_name,
  display_name,
  avatar_url,
  spotify_url,
  youtube_url,
  activity_seen_at
) on profiles to authenticated;
