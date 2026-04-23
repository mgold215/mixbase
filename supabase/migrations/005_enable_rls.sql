-- Enable RLS on all tables and lock down storage insert policies.
-- Service-role key (used by all server-side API routes) bypasses RLS entirely,
-- so no data-access policies are needed — this just blocks direct anon-key access.

alter table mb_projects enable row level security;
alter table mb_versions enable row level security;
alter table mb_feedback enable row level security;
alter table mb_releases enable row level security;
alter table mb_activity enable row level security;
alter table mb_collections enable row level security;
alter table mb_collection_items enable row level security;

-- Remove permissive any-user policies left from earlier schema versions
drop policy if exists "Allow all access to mb_collections" on mb_collections;
drop policy if exists "Allow all access to mb_collection_items" on mb_collection_items;

-- Tighten storage insert policies to service role only.
-- Signed upload URLs bypass RLS per Supabase docs, so browser → signed-URL uploads still work.
drop policy if exists "Service role insert mf-audio" on storage.objects;
drop policy if exists "Service role insert mf-artwork" on storage.objects;

create policy "Service role insert mf-audio" on storage.objects
  for insert with check (bucket_id = 'mf-audio' AND auth.role() = 'service_role');

create policy "Service role insert mf-artwork" on storage.objects
  for insert with check (bucket_id = 'mf-artwork' AND auth.role() = 'service_role');

-- Add missing update/delete policies (service role only)
drop policy if exists "Service role update mf-audio" on storage.objects;
drop policy if exists "Service role update mf-artwork" on storage.objects;
drop policy if exists "Service role delete mf-audio" on storage.objects;
drop policy if exists "Service role delete mf-artwork" on storage.objects;

create policy "Service role update mf-audio" on storage.objects
  for update using (bucket_id = 'mf-audio' AND auth.role() = 'service_role');

create policy "Service role update mf-artwork" on storage.objects
  for update using (bucket_id = 'mf-artwork' AND auth.role() = 'service_role');

create policy "Service role delete mf-audio" on storage.objects
  for delete using (bucket_id = 'mf-audio' AND auth.role() = 'service_role');

create policy "Service role delete mf-artwork" on storage.objects
  for delete using (bucket_id = 'mf-artwork' AND auth.role() = 'service_role');
