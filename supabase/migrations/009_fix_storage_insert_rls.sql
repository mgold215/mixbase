-- Fix storage INSERT policies for mf-audio and mf-artwork.
--
-- Root cause: the old service_role-only INSERT policies blocked signed upload
-- URL requests.  createSignedUploadUrl() pre-registers the object row in
-- storage.objects before returning the signed URL; that INSERT runs under
-- the caller's JWT context.  When SUPABASE_SERVICE_ROLE_KEY is absent
-- supabaseAdmin falls back to the anon key, so auth.role() = 'anon' and the
-- policy rejected the INSERT with "new row violates row-level security".
-- Even when the key IS set, the short-lived token embedded in the signed URL
-- carries 'anon' role rather than 'service_role', so the browser-side PUT
-- would also fail without this fix.
--
-- Security rationale:
--   * These buckets are already publicly readable — upload restriction was the
--     only gate.
--   * All upload entry-points (/api/upload-url, /api/tus, /api/generate-artwork)
--     are protected by auth middleware; only authenticated users can obtain a
--     signed URL or trigger a TUS session.
--   * UPDATE and DELETE policies remain service_role-only, preventing clients
--     from overwriting or deleting existing objects.

drop policy if exists "service_role_insert_mf_audio"   on storage.objects;
drop policy if exists "service_role_insert_mf_artwork" on storage.objects;
drop policy if exists "Service role insert mf-audio"   on storage.objects;
drop policy if exists "Service role insert mf-artwork" on storage.objects;

create policy "allow_uploads_mf_audio" on storage.objects
  for insert with check (bucket_id = 'mf-audio');

create policy "allow_uploads_mf_artwork" on storage.objects
  for insert with check (bucket_id = 'mf-artwork');
