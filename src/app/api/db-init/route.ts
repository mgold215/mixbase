import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// The full schema SQL — same as supabase/migrations/001_initial.sql + 002_remaining_tables.sql
const SCHEMA_SQL = `
create extension if not exists "pgcrypto";

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

create table if not exists mb_versions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references mb_projects(id) on delete cascade,
  version_number integer not null,
  label text,
  audio_url text not null,
  audio_filename text,
  duration_seconds integer,
  file_size_bytes bigint,
  status text not null default 'WIP',
  private_notes text,
  public_notes text,
  change_log text,
  share_token text unique default replace(gen_random_uuid()::text, '-', ''),
  allow_download boolean default false,
  created_at timestamptz default now()
);

create table if not exists mb_feedback (
  id uuid primary key default gen_random_uuid(),
  version_id uuid references mb_versions(id) on delete cascade,
  reviewer_name text not null default 'Anonymous',
  rating integer check (rating >= 1 and rating <= 5),
  comment text,
  timestamp_seconds integer,
  created_at timestamptz default now()
);

create table if not exists mb_releases (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  release_date date,
  project_id uuid references mb_projects(id) on delete set null,
  genre text,
  label text,
  isrc text,
  notes text,
  mixing_done boolean default false,
  mastering_done boolean default false,
  artwork_ready boolean default false,
  dsp_submitted boolean default false,
  social_posts_done boolean default false,
  press_release_done boolean default false,
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

create table if not exists mb_activity (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  project_id uuid references mb_projects(id) on delete cascade,
  version_id uuid,
  release_id uuid,
  description text,
  created_at timestamptz default now()
);

create index if not exists idx_versions_project_id on mb_versions(project_id);
create index if not exists idx_versions_share_token on mb_versions(share_token);
create index if not exists idx_feedback_version_id on mb_feedback(version_id);
create index if not exists idx_releases_project_id on mb_releases(project_id);
create index if not exists idx_activity_project_id on mb_activity(project_id);
create index if not exists idx_activity_created on mb_activity(created_at desc);

alter table mb_projects disable row level security;
alter table mb_versions disable row level security;
alter table mb_feedback disable row level security;
alter table mb_releases disable row level security;
alter table mb_activity disable row level security;

-- Ensure share_token column exists (idempotent — safe to re-run)
alter table mb_versions
  add column if not exists share_token text unique default replace(gen_random_uuid()::text, '-', '');

create index if not exists idx_versions_share_token on mb_versions(share_token);

-- Backfill any rows that are still missing a share_token
update mb_versions
set share_token = replace(gen_random_uuid()::text, '-', '')
where share_token is null;

-- Collections tables (idempotent)
create table if not exists mb_collections (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  type text not null check (type in ('playlist','ep','album')),
  cover_url text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists mb_collection_items (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid references mb_collections(id) on delete cascade,
  project_id uuid references mb_projects(id) on delete cascade,
  position integer not null default 0,
  created_at timestamptz default now()
);

alter table mb_collections disable row level security;
alter table mb_collection_items disable row level security;

-- Add cover_url if it was created before this column existed
alter table mb_collections add column if not exists cover_url text;

create index if not exists idx_collection_items_collection on mb_collection_items(collection_id);
create index if not exists idx_collection_items_position on mb_collection_items(collection_id, position);

-- Migration 005: multi-user support
alter table mb_projects    add column if not exists user_id uuid references auth.users(id);
alter table mb_releases    add column if not exists user_id uuid references auth.users(id);
alter table mb_collections add column if not exists user_id uuid references auth.users(id);

create index if not exists idx_projects_user_id    on mb_projects(user_id);
create index if not exists idx_releases_user_id    on mb_releases(user_id);
create index if not exists idx_collections_user_id on mb_collections(user_id);

alter table mb_projects        enable row level security;
alter table mb_versions        enable row level security;
alter table mb_releases        enable row level security;
alter table mb_collections     enable row level security;
alter table mb_collection_items enable row level security;
alter table mb_feedback        enable row level security;
alter table mb_activity        enable row level security;

drop policy if exists "users_own_projects"         on mb_projects;
drop policy if exists "users_own_versions"         on mb_versions;
drop policy if exists "users_own_releases"         on mb_releases;
drop policy if exists "users_own_collections"      on mb_collections;
drop policy if exists "users_own_collection_items" on mb_collection_items;
drop policy if exists "public_feedback_insert"     on mb_feedback;
drop policy if exists "users_read_feedback"        on mb_feedback;
drop policy if exists "users_own_activity"         on mb_activity;

create policy "users_own_projects" on mb_projects
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "users_own_versions" on mb_versions
  using (project_id in (select id from mb_projects where user_id = auth.uid()))
  with check (project_id in (select id from mb_projects where user_id = auth.uid()));

create policy "users_own_releases" on mb_releases
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "users_own_collections" on mb_collections
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "users_own_collection_items" on mb_collection_items
  using (collection_id in (select id from mb_collections where user_id = auth.uid()))
  with check (collection_id in (select id from mb_collections where user_id = auth.uid()));

create policy "public_feedback_insert" on mb_feedback
  for insert with check (true);

create policy "users_read_feedback" on mb_feedback
  for select using (
    version_id in (
      select v.id from mb_versions v
      join mb_projects p on v.project_id = p.id
      where p.user_id = auth.uid()
    )
  );

create policy "users_own_activity" on mb_activity
  using (project_id in (select id from mb_projects where user_id = auth.uid()))
  with check (project_id in (select id from mb_projects where user_id = auth.uid()));
`

function isAuthorizedDbInit(request: NextRequest): boolean {
  const expectedToken = process.env.DB_INIT_TOKEN
  const authHeader = request.headers.get('authorization')
  const bearerToken = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1]
  return !!expectedToken && bearerToken === expectedToken
}

// GET /api/db-init — run mixBase database migrations via the Supabase Management API.
// Requires DB_INIT_TOKEN for route access and SUPABASE_MANAGEMENT_TOKEN for SQL execution.
// Also auto-creates storage buckets using the service role key.
export async function GET(request: NextRequest) {
  if (!isAuthorizedDbInit(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const results: { step: string; status: string; detail?: string }[] = []

  // ── Step 1: Run SQL migrations via Management API ──────────────────────────
  const managementToken = process.env.SUPABASE_MANAGEMENT_TOKEN
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL

  if (!managementToken) {
    results.push({
      step: 'database_migrations',
      status: 'skipped',
      detail: 'Set SUPABASE_MANAGEMENT_TOKEN in your Railway env vars to auto-run migrations. ' +
              'Get a token at supabase.com/dashboard/account/tokens. ' +
              'Alternatively, run the SQL in supabase/migrations/ from the Supabase SQL editor.',
    })
  } else if (!supabaseUrl) {
    results.push({ step: 'database_migrations', status: 'error', detail: 'NEXT_PUBLIC_SUPABASE_URL not set' })
  } else {
    // Extract project ref from URL (https://[ref].supabase.co)
    const projectRef = supabaseUrl.replace('https://', '').replace('.supabase.co', '')
    const mgmtEndpoint = `https://api.supabase.com/v1/projects/${projectRef}/database/query`

    try {
      const res = await fetch(mgmtEndpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${managementToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: SCHEMA_SQL }),
      })
      if (res.ok) {
        results.push({ step: 'database_migrations', status: 'success', detail: 'All tables created (or already existed)' })
      } else {
        const err = await res.text()
        results.push({ step: 'database_migrations', status: 'error', detail: err })
      }
    } catch (e) {
      results.push({ step: 'database_migrations', status: 'error', detail: String(e) })
    }
  }

  // ── Step 2: Create storage buckets ──────────────────────────────────────────
  for (const bucket of ['mf-audio', 'mf-artwork'] as const) {
    const isAudio = bucket === 'mf-audio'
    try {
      const { error: getErr } = await supabaseAdmin.storage.getBucket(bucket)
      if (!getErr) {
        results.push({ step: `bucket_${bucket}`, status: 'exists' })
        continue
      }
      const { error: createErr } = await supabaseAdmin.storage.createBucket(bucket, {
        public: true,
        fileSizeLimit: isAudio ? 52428800 : 10485760,
        allowedMimeTypes: isAudio
          ? ['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/aiff', 'audio/x-aiff', 'audio/flac', 'audio/ogg', 'audio/mp4', 'audio/x-m4a', 'audio/*']
          : ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
      })
      if (createErr) {
        results.push({ step: `bucket_${bucket}`, status: 'error', detail: createErr.message })
      } else {
        results.push({ step: `bucket_${bucket}`, status: 'created' })
      }
    } catch (e) {
      results.push({ step: `bucket_${bucket}`, status: 'error', detail: String(e) })
    }
  }

  // ── Step 3: Verify DB connectivity ──────────────────────────────────────────
  try {
    const { error } = await supabaseAdmin.from('mb_projects').select('id').limit(1)
    if (error) {
      results.push({ step: 'db_check', status: 'error', detail: error.message })
    } else {
      results.push({ step: 'db_check', status: 'ok' })
    }
  } catch (e) {
    results.push({ step: 'db_check', status: 'error', detail: String(e) })
  }

  const allOk = results.every(r => r.status === 'ok' || r.status === 'exists' || r.status === 'created' || r.status === 'success')
  return NextResponse.json({ ok: allOk, results }, { status: allOk ? 200 : 207 })
}
