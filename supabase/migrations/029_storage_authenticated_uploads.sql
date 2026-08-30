-- 029: require a signed-in user to write objects into the three app buckets.
--
-- ✅ APPLIED TO PRODUCTION 2026-08-21 (ledger: 20260821004123). Re-verified
-- 2026-08-30 — pg_policies shows all three policies live with roles={authenticated}.
--
-- ⚠️ THE ROLLBACK BLOCK AT THE BOTTOM IS NOT A SAFE "RESTORE BASELINE" STEP.
-- It recreates these policies with NO role restriction, which hands anonymous
-- upload rights back to the public anon key. This header used to read "WRITTEN
-- BUT NOT APPLIED" long after the migration had in fact been applied; anyone
-- trusting that and running the rollback as a no-op would have re-opened the
-- exact hole this file closes. Run it only as a deliberate, announced revert.
--
-- Companion to 028 (anonymous *listing*), which is genuinely NOT applied and
-- carries its own DO-NOT-APPLY banner — a previous attempt caused an outage.
--
-- THE HOLE
-- Migrations 009 and 014 created the INSERT policies with no auth predicate:
--
--   create policy allow_uploads_mf_audio on storage.objects
--     for insert with check (bucket_id = 'mf-audio');
--
-- Verified live against production `pg_policies` on 2026-08-05 — all three are
-- still cmd=INSERT, roles={public}, with_check = `bucket_id = '<name>'`:
--   allow_uploads_mf_audio · allow_uploads_mf_artwork · allow_uploads_mf_video
--
-- `roles={public}` means the anon key — which ships inside our own JS bundle —
-- can POST objects into all three buckets. mf-audio accepts 2 GB per file. That
-- is unmetered storage billing and arbitrary bytes hosted under the trusted
-- supabase.co domain. (UPDATE/DELETE are already service-role only, so this is
-- an abuse/billing hole, not defacement of existing files.)
--
-- WHY THIS SAT UNSHIPPED FOR FOUR RUNS, AND WHY IT IS NOW SAFE
-- The blocker was always: "does requiring `authenticated` break the ≤50 MB
-- signed-URL browser PUT?" Migration 009's own header asserts that the signed
-- URL's embedded token carries role `anon`, which would mean this change breaks
-- every small upload. THAT ASSERTION IS WRONG.
--
-- @supabase/storage-js documents the RLS requirements of each upload method in
-- its own JSDoc. For `uploadToSignedUrl` — the exact call our browser PUT hits:
--     RLS policy permissions required:
--       `buckets` table permissions: none
--       `objects` table permissions: none
-- Compare plain `upload()` in the same file, which requires `insert` (and
-- `select`+`update` for upsert). The distinction is deliberate: Storage
-- validates the signed token itself and performs the insert with elevated
-- privilege, so RLS is never consulted on that path.
--
-- Every writer to these buckets was enumerated and all four survive:
--   1. Web signed-URL PUT (ProjectClient / NewProjectForm / ArtworkGenerator) —
--      a raw XHR PUT carrying NO Authorization or apikey header, only the
--      `token` query param. RLS not consulted.
--   2. TUS chunked upload (/api/tus) — proxied server-side with the
--      service-role key. Bypasses RLS.
--   3. All server-side writes (artwork, finalize, visualizer, video) —
--      supabaseAdmin, service role. Bypasses RLS.
--   4. iOS direct upload — sends `Authorization: Bearer <user access token>`,
--      so it evaluates as `authenticated`. Passes. ← the only path that
--      actually depends on this policy.
-- There is no client-side `supabase.storage.from(...).upload()` anywhere in
-- src/; the browser Supabase client is used only for auth.
--
-- ⚠️ SHIP THE iOS GUARD IN THE SAME RELEASE. SupabaseService.swift's upload
-- helper reads `let bearerToken = accessToken ?? supabaseKey`, falling back to
-- the ANON key when no session is loaded. After this migration that request
-- fails, and the auto-retry only fires on 401 while an RLS denial returns
-- 400/403 — so it will not self-heal. Make the iOS upload require a non-nil
-- accessToken.

begin;

drop policy if exists allow_uploads_mf_audio on storage.objects;
create policy allow_uploads_mf_audio on storage.objects
  for insert to authenticated
  with check (bucket_id = 'mf-audio');

drop policy if exists allow_uploads_mf_artwork on storage.objects;
create policy allow_uploads_mf_artwork on storage.objects
  for insert to authenticated
  with check (bucket_id = 'mf-artwork');

drop policy if exists allow_uploads_mf_video on storage.objects;
create policy allow_uploads_mf_video on storage.objects
  for insert to authenticated
  with check (bucket_id = 'mf-video');

commit;

-- VERIFY (expect roles={authenticated} on all three):
--   select policyname, cmd, roles::text, with_check
--   from pg_policies
--   where tablename = 'objects' and policyname like 'allow_uploads_%';
--
-- THEN SMOKE TEST, IN THIS ORDER — each exercises a different writer:
--   1. Web: upload a <50 MB mix (signed-URL PUT). Must succeed. This is the
--      path the old migration header claimed would break; if it does break,
--      roll back immediately — the JSDoc contract above is then wrong.
--   2. Web: upload a >50 MB mix (TUS chunked, service-role). Must succeed.
--   3. Generate artwork (server-side write). Must succeed.
--   4. iOS: upload a mix while signed in. Must succeed.
--
-- ZERO-BLAST-RADIUS PRE-CHECK (do this first if you want certainty without
-- touching the live buckets): create a throwaway bucket with an INSERT policy
-- scoped `to authenticated`, mint a signed upload URL with the service key, and
-- PUT to it with no auth headers. Success confirms the JSDoc contract.
--
-- ROLLBACK (restores the permissive behaviour exactly):
--   drop policy if exists allow_uploads_mf_audio on storage.objects;
--   create policy allow_uploads_mf_audio on storage.objects
--     for insert with check (bucket_id = 'mf-audio');
--   -- repeat for mf-artwork and mf-video
