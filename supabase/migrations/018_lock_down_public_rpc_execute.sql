-- 018_lock_down_public_rpc_execute.sql
-- Close an anon/authenticated EXECUTE exposure on two SECURITY DEFINER RPCs.
--
-- ROOT CAUSE: a newly created Postgres function carries a DEFAULT `EXECUTE`
-- grant to PUBLIC. Earlier hardening revoked EXECUTE `FROM anon, authenticated`
-- only — which does NOT remove the PUBLIC grant, so both roles kept EXECUTE via
-- PUBLIC and stayed callable over `/rest/v1/rpc`.
--
-- Verified against the LIVE ACLs on 2026-07-09 (Supabase advisor +
-- pg_proc.proacl): `try_increment_usage` and `handle_new_user` still carried the
-- `=X` (PUBLIC) grant, while `increment_artwork_usage` / `increment_video_usage`
-- — which 017_prc_hardening revoked `FROM PUBLIC` — did not. That contrast is
-- the proof this pattern is both the bug and the fix.
--
-- IMPACT (MEDIUM — quota-griefing DoS): with the public anon key, anyone could
--   POST /rest/v1/rpc/try_increment_usage
--        { p_user_id: <victim>, p_month: 'YYYY-MM', p_feature: 'artwork', p_limit: N }
-- to atomically inflate any user's monthly generation counter and lock them out
-- of artwork/video generation (free tier caps at 3). `handle_new_user` is a
-- profile-provisioning trigger function that was never meant to be client-callable.
--
-- SAFE + REVERSIBLE (tightening-only):
--   * The app calls these ONLY via the service-role key — verified: src/lib/tier.ts
--     uses `supabaseAdmin` exclusively for try_increment_usage / increment_*_usage.
--     service_role retains EXECUTE below, so no app path breaks.
--   * `handle_new_user` runs as an AFTER INSERT trigger on `auth.users`
--     (SECURITY DEFINER — fires as the definer regardless of the caller's grant),
--     so revoking public EXECUTE does not affect signup.
--   * To reverse: GRANT EXECUTE ... TO anon, authenticated; (do not — this is the fix).
--
-- Idempotent: re-running REVOKE/GRANT to the same end-state is a no-op.

REVOKE EXECUTE ON FUNCTION public.try_increment_usage(uuid, text, text, int) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.try_increment_usage(uuid, text, text, int) TO service_role;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
-- (No service_role GRANT for handle_new_user: it is only ever invoked by its
--  auth.users trigger, never called directly by the server.)
