-- Create Supabase Storage buckets for Mixfolio
-- mf-audio: audio files (max 50MB per Supabase free tier)
-- mf-artwork: project artwork images

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('mf-audio', 'mf-audio', true, 52428800, ARRAY['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/aiff', 'audio/x-aiff', 'audio/flac', 'audio/ogg', 'audio/mp4', 'audio/x-m4a', 'audio/*']),
  ('mf-artwork', 'mf-artwork', true, 10485760, ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do nothing;

-- Allow public read on both buckets (anyone can view shared audio and artwork)
create policy "Public read mf-audio" on storage.objects
  for select using (bucket_id = 'mf-audio');

create policy "Public read mf-artwork" on storage.objects
  for select using (bucket_id = 'mf-artwork');

-- Allow inserts from service role (our server-side uploads)
create policy "Service role insert mf-audio" on storage.objects
  for insert with check (bucket_id = 'mf-audio');

create policy "Service role insert mf-artwork" on storage.objects
  for insert with check (bucket_id = 'mf-artwork');
