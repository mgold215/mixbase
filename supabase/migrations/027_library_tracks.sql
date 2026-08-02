-- 027: released-track library (mb_library_tracks).
-- The artist's already-released discography, synced from Spotify/Deezer or
-- entered by hand: the ISRC/UPC/date facts a DistroKid upload needs, kept
-- SEPARATE from mb_releases so the pipeline board holds planned work only.
-- project_id optionally links a library track back to its mixBASE project so
-- the original audio file is one click away.

create table if not exists mb_library_tracks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  artist_name text,
  isrc text,
  upc text,
  release_title text,
  release_date date,
  release_type text,
  source text,
  source_url text,
  project_id uuid references mb_projects(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_library_tracks_user on mb_library_tracks(user_id);
create index if not exists idx_library_tracks_user_isrc on mb_library_tracks(user_id, isrc);

alter table mb_library_tracks enable row level security;

drop policy if exists "users_own_library_tracks" on mb_library_tracks;
create policy "users_own_library_tracks" on mb_library_tracks
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
