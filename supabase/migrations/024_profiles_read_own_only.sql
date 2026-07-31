-- ============================================================================
-- Migration 024: profiles are readable only by their owner
--
-- Migration 006 created `profiles` with
--     create policy "anyone_can_read_profiles" on profiles for select using (true);
-- and no later migration ever narrowed it. RLS on this table is the ONLY gate
-- in front of the anon role — 005's own header says as much ("Service-role key
-- ... bypasses RLS entirely, so no data-access policies are needed — this just
-- blocks direct anon-key access"), and the anon role does hold a plain SELECT
-- grant on public tables. A `using (true)` select policy therefore makes the
-- whole table world-readable to anyone holding NEXT_PUBLIC_SUPABASE_ANON_KEY,
-- which ships in the client bundle by design.
--
-- Since 006, `profiles` has accumulated columns that must never be public:
--   • stripe_customer_id / stripe_subscription_id / apple_original_transaction_id
--   • subscription_tier / subscription_source / subscription_expires_at
--   • is_owner
-- subscription_tier is also the admin gate (src/proxy.ts checks
-- `profile.subscription_tier !== 'admin'` before allowing /admin, /api/admin
-- and /api/infra), so a world-readable profiles table lets anyone enumerate
-- which account is the administrator — reconnaissance for the one surface that
-- can restart Railway services and run SQL.
--
-- PRODUCTION IS ALREADY CORRECT: the live database carries
-- `users_read_own_profile` (select, `id = auth.uid()`) and no permissive
-- policy — that fix was applied out-of-band and never made it back into this
-- migration set. This migration makes the repository match verified-live
-- production so that every FRESH environment built from these files (and the
-- self-heal / bootstrap paths) is closed by construction rather than by memory.
--
-- Applying this to production is a no-op re-assertion of the current state.
-- Tightening-only, idempotent, and safe to re-run.
-- ============================================================================

alter table profiles enable row level security;

-- The permissive policy from 006. Absent on production (already remediated);
-- present on any environment built from this migration set.
drop policy if exists "anyone_can_read_profiles" on profiles;

-- Owner-only read. Matches the live production policy exactly.
drop policy if exists "users_read_own_profile" on profiles;
create policy "users_read_own_profile" on profiles
  for select using (id = auth.uid());

-- Unchanged from 006 — restated so a fresh environment gets the full policy
-- set from this file alone.
drop policy if exists "users_update_own_profile" on profiles;
create policy "users_update_own_profile" on profiles
  for update using (id = auth.uid())
  with check (id = auth.uid());
