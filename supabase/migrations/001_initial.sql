-- mixBase Database Schema
-- Run this in the Supabase SQL editor for project: mdefkqaawrusoaojstpq

-- Enable UUID generation
create extension if not exists "pgcrypto";

-- ============================================================
-- PROJECTS: Each mix project (song/track)
-- ============================================================
create table if not exists mb_projects (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  artwork_url text,
  genre text,
  bpm integer,
  key_signature text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================================
-- VERSIONS: Each iteration of a mix (v1, v2, v3...)
-- ============================================================
create table if not exists mb_versions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references mb_projects(id) on delete cascade,
  version_number integer not null,
  label text,                          -- e.g. "More low end", "Fixed chorus"
  audio_url text not null,
  audio_filename text,
  duration_seconds integer,
  file_size_bytes bigint,
  status text not null default 'WIP',  -- WIP | Mix/Master | Finished | Released
  private_notes text,                  -- Only visible to project owner
  public_notes text,                   -- Visible on share page
  change_log text,                     -- What changed from previous version
  share_token text unique default replace(gen_random_uuid()::text, '-', ''),
  allow_download boolean default false,
  created_at timestamptz default now()
);

-- ============================================================
-- FEEDBACK: Listener responses on share pages
-- ============================================================
create table if not exists mb_feedback (
  id uuid primary key default gen_random_uuid(),
  version_id uuid references mb_versions(id) on delete cascade,
  reviewer_name text not null default 'Anonymous',
  rating integer check (rating >= 1 and rating <= 5),
  comment text,
  timestamp_seconds integer,           -- Optional: timestamp in the track they're commenting on
  created_at timestamptz default now()
);

-- ============================================================
-- RELEASES: Release pipeline planning
-- ============================================================
create table if not exists mb_releases (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  release_date date,
  project_id uuid references mb_projects(id) on delete set null,
  genre text,
  label text,
  isrc text,
  notes text,
  -- Checklist
  mixing_done boolean default false,
  mastering_done boolean default false,
  artwork_ready boolean default false,
  dsp_submitted boolean default false,
  social_posts_done boolean default false,
  press_release_done boolean default false,
  -- DSP platforms
  dsp_spotify boolean default false,
  dsp_apple_music boolean default false,
  dsp_tidal boolean default false,
  dsp_bandcamp boolean default false,
  dsp_soundcloud boolean default false,
  dsp_youtube boolean default false,
  dsp_amazon boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================================
-- ACTIVITY LOG: For the dashboard activity feed
-- ============================================================
create table if not exists mb_activity (
  id uuid primary key default gen_random_uuid(),
  type text not null,                  -- version_upload | status_change | feedback_received | release_created
  project_id uuid references mb_projects(id) on delete cascade,
  version_id uuid,
  release_id uuid,
  description text,
  created_at timestamptz default now()
);

-- ============================================================
-- INDEXES for performance
-- ============================================================
create index if not exists idx_versions_project_id on mb_versions(project_id);
create index if not exists idx_versions_share_token on mb_versions(share_token);
create index if not exists idx_feedback_version_id on mb_feedback(version_id);
create index if not exists idx_releases_project_id on mb_releases(project_id);
create index if not exists idx_activity_project_id on mb_activity(project_id);
create index if not exists idx_activity_created on mb_activity(created_at desc);

-- ============================================================
-- DISABLE RLS (password gate is handled at app level)
-- ============================================================
alter table mb_projects disable row level security;
alter table mb_versions disable row level security;
alter table mb_feedback disable row level security;
alter table mb_releases disable row level security;
alter table mb_activity disable row level security;
