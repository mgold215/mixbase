-- Migration 044: stop anyone with the public key LISTING the mf-* buckets.
-- APPLIED to production 2026-11-14 (supabase_migrations: 044_storage_owner_scoped_read).
--
-- Supersedes the refuted approach in 028. Dropping the bucket-wide SELECT
-- policies alone broke uploads (2026-07-11), because every client upload sends
-- `x-upsert: true` and Storage's write reads the new row back under the
-- uploader's SELECT policy. So the SELECT policy is kept for the row a user
-- just wrote (Storage stamps owner_id with the uploader's JWT sub) and refused
-- for everything else, which closes bucket-wide enumeration.
--
-- Rehearsed 2026-11-14 on throwaway public buckets with a real signed-in user,
-- old rules vs these rules, side by side:
--   upload new file with x-upsert ........ 200 / 200
--   re-upload same name ................... 403 / 403 (no UPDATE policy; unchanged)
--   signed upload URL, PUT with no session  200 (new rules)
--   anon list ............................. rows / []
--   owner list ............................ own rows / own rows
--   public download ....................... 200 / 200
-- Verified live after applying: anon list of mf-audio and mf-artwork -> [];
-- a mix's public URL with a Range header -> 206; /api/health green.
-- Reads stay on /storage/v1/object/public/... (public buckets bypass RLS);
-- server reads, lists and deletes use the service key (bypasses RLS).
--
-- ROLLBACK (exact previous state):
--   drop policy "mf owners read own files" on storage.objects;
--   create policy "Public read mf-audio"   on storage.objects for select using (bucket_id = 'mf-audio');
--   create policy "Public read mf-artwork" on storage.objects for select using (bucket_id = 'mf-artwork');
--   create policy "Public read mf-video"   on storage.objects for select using (bucket_id = 'mf-video');

drop policy if exists "Public read mf-audio" on storage.objects;
drop policy if exists "Public read mf-artwork" on storage.objects;
drop policy if exists "Public read mf-video" on storage.objects;
create policy "mf owners read own files" on storage.objects for select to authenticated
  using (bucket_id in ('mf-artwork','mf-audio','mf-video') and owner_id = (select auth.uid())::text);
