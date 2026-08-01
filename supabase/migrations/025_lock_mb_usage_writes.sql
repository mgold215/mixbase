-- 025_lock_mb_usage_writes.sql
-- Close a direct-PostgREST monetization bypass on the mb_usage table.
--
-- ROOT CAUSE: mb_usage tracks each user's monthly artwork/video generation
-- counts and is the SERVER-SIDE enforcement point for tier limits
-- (src/lib/tier.ts). Migration 007 shipped INSERT and UPDATE policies scoped
-- `user_id = auth.uid()`, and the anon/authenticated roles hold the default
-- INSERT/UPDATE grants every public table gets. Together that let ANY signed-in
-- user write their OWN usage row directly over /rest/v1/rpc-less PostgREST:
--   PATCH /rest/v1/mb_usage?user_id=eq.<self>&month=eq.YYYY-MM
--        { "artwork_generations": 0 }
-- resetting their paid-generation quota at will. There was no `>= 0` guard, so a
-- negative value was a permanent bypass. Verified against the LIVE policies +
-- role grants on 2026-08-01.
--
-- 017/018 closed the RPC door into this table (try_increment_usage /
-- increment_*_usage EXECUTE grants); this closes the table's OWN write door,
-- which those migrations did not touch.
--
-- IMPACT (HIGH — monetization bypass): unlimited paid Replicate artwork for every
-- tier, and unlimited Runway video for `studio`. (Free/pro video is unaffected —
-- tier.ts short-circuits on limit <= 0 before touching the table.) No cross-user
-- data exposure; this is a cost/enforcement bypass, not a leak.
--
-- SAFE + REVERSIBLE (tightening-only): every mb_usage WRITE in the app goes
-- through the service-role key, which bypasses RLS — try_increment_usage and
-- increment_*_usage are SECURITY DEFINER (run as owner), and refundUsage /
-- getMonthUsage use `supabaseAdmin`. No app or iOS path relies on the anon /
-- authenticated INSERT or UPDATE policies (verified: grep of mb_usage access is
-- 100% supabaseAdmin). The own-row SELECT policy stays so a client can still
-- read its own usage. To reverse: recreate the two policies from migration 007.
--
-- Idempotent: DROP POLICY IF EXISTS + a guarded ADD CONSTRAINT.

alter table public.mb_usage enable row level security;

drop policy if exists "Users can insert their own usage" on public.mb_usage;
drop policy if exists "Users can update their own usage" on public.mb_usage;

-- Defence in depth: even if a write policy is ever re-introduced, a counter can
-- never be driven negative into a permanent bypass.
do $$ begin
  alter table public.mb_usage
    add constraint mb_usage_nonneg_counts
    check (artwork_generations >= 0 and video_generations >= 0);
exception when duplicate_object then null; end $$;
