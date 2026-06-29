-- Visualizers: persist generated video loops so they're findable in the Media library.
--
-- Before this, free renders were in-browser blobs (lost on reload) and AI/Runway
-- videos were transient provider URLs that expire. Both now upload to the mf-video
-- bucket and get a row here, exactly mirroring how artwork lands in mf-artwork.

-- ── Storage bucket: mf-video ────────────────────────────────────────────────
-- Public read (same as mf-audio/mf-artwork). 50 MB ceiling comfortably covers
-- both the 1/4-scale free WebM loops and short Runway clips.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('mf-video', 'mf-video', true, 52428800, ARRAY['video/webm', 'video/mp4', 'video/quicktime'])
on conflict (id) do nothing;

-- Public read so <video> tags and downloads work without auth.
create policy "Public read mf-video" on storage.objects
  for select using (bucket_id = 'mf-video');

-- Uploads: all visualizer write paths (/api/visualizer/runway, /api/visualizer/save)
-- are auth-gated by middleware, so mirror the mf-artwork insert policy.
create policy "allow_uploads_mf_video" on storage.objects
  for insert with check (bucket_id = 'mf-video');

-- Overwrite/delete stay service-role only, matching the other buckets.
create policy "Service role update mf-video" on storage.objects
  for update using (bucket_id = 'mf-video' AND auth.role() = 'service_role');

create policy "Service role delete mf-video" on storage.objects
  for delete using (bucket_id = 'mf-video' AND auth.role() = 'service_role');

-- ── Table: mb_visualizers ───────────────────────────────────────────────────
create table if not exists mb_visualizers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  project_id uuid references mb_projects(id) on delete cascade,
  video_url text not null,
  source_image_url text,
  kind text not null default 'ai',     -- 'free' (canvas render) | 'ai' (Runway)
  title text,                          -- e.g. "Spotify Canvas · Ken Burns" or "Gen-4 Turbo · 5s"
  created_at timestamptz default now()
);

create index if not exists mb_visualizers_user_created_idx
  on mb_visualizers (user_id, created_at desc);

-- Enable RLS — service-role key (all server-side ops) bypasses RLS entirely,
-- matching mb_collections. No anon policies needed or desired.
alter table mb_visualizers enable row level security;
