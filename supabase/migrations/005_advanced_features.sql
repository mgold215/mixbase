-- 005: Advanced features — Spotify integration, favorites, press kits, social posts

-- ── Spotify integration ─────────────────────────────────────────────────────
-- Stores OAuth tokens for the user's Spotify account
create table if not exists mb_spotify_auth (
  id uuid primary key default gen_random_uuid(),
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  spotify_user_id text,
  display_name text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Links a mixBase project to a Spotify track/album for analytics
create table if not exists mb_spotify_links (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references mb_projects(id) on delete cascade,
  spotify_track_id text not null,
  spotify_track_name text,
  spotify_artist_name text,
  spotify_album_name text,
  spotify_url text,
  linked_at timestamptz default now(),
  unique(project_id, spotify_track_id)
);

-- Cached Spotify stream data snapshots
create table if not exists mb_spotify_stats (
  id uuid primary key default gen_random_uuid(),
  spotify_link_id uuid references mb_spotify_links(id) on delete cascade,
  streams integer default 0,
  popularity integer default 0,
  followers integer default 0,
  monthly_listeners integer default 0,
  snapshot_date date not null default current_date,
  raw_data jsonb,
  created_at timestamptz default now(),
  unique(spotify_link_id, snapshot_date)
);

-- ── Favorites / starred tracks ──────────────────────────────────────────────
create table if not exists mb_favorites (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references mb_projects(id) on delete cascade unique,
  created_at timestamptz default now()
);

-- ── Press kits ──────────────────────────────────────────────────────────────
create table if not exists mb_press_kits (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references mb_projects(id) on delete cascade,
  content jsonb not null default '{}',
  -- content includes: bio, one_liner, key_facts, press_release, social_captions
  generated_by text default 'claude',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ── Social media post templates ─────────────────────────────────────────────
create table if not exists mb_social_posts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references mb_projects(id) on delete cascade,
  platform text not null, -- 'instagram', 'twitter', 'tiktok', 'facebook'
  post_type text not null default 'announcement', -- 'announcement', 'teaser', 'release_day', 'milestone'
  caption text not null,
  hashtags text[],
  scheduled_for timestamptz,
  posted boolean default false,
  created_at timestamptz default now()
);

-- ── Curator / playlist submission tracking ──────────────────────────────────
create table if not exists mb_curator_submissions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references mb_projects(id) on delete cascade,
  curator_name text not null,
  curator_email text,
  playlist_name text,
  playlist_url text,
  status text default 'draft', -- 'draft', 'sent', 'accepted', 'declined', 'no_response'
  sent_at timestamptz,
  response_at timestamptz,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ── Enable RLS on all new tables ────────────────────────────────────────────
alter table mb_spotify_auth enable row level security;
alter table mb_spotify_links enable row level security;
alter table mb_spotify_stats enable row level security;
alter table mb_favorites enable row level security;
alter table mb_press_kits enable row level security;
alter table mb_social_posts enable row level security;
alter table mb_curator_submissions enable row level security;

-- Allow all operations (single-user app, auth is via password middleware)
create policy "mb_spotify_auth_all" on mb_spotify_auth for all using (true) with check (true);
create policy "mb_spotify_links_all" on mb_spotify_links for all using (true) with check (true);
create policy "mb_spotify_stats_all" on mb_spotify_stats for all using (true) with check (true);
create policy "mb_favorites_all" on mb_favorites for all using (true) with check (true);
create policy "mb_press_kits_all" on mb_press_kits for all using (true) with check (true);
create policy "mb_social_posts_all" on mb_social_posts for all using (true) with check (true);
create policy "mb_curator_submissions_all" on mb_curator_submissions for all using (true) with check (true);
