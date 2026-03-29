import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// The full schema SQL — same as supabase/migrations/001_initial.sql + 002_remaining_tables.sql
const SCHEMA_SQL = `
create extension if not exists "pgcrypto";

create table if not exists mf_projects (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  artwork_url text,
  genre text,
  bpm integer,
  key_signature text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists mf_versions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references mf_projects(id) on delete cascade,
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

create table if not exists mf_feedback (
  id uuid primary key default gen_random_uuid(),
  version_id uuid references mf_versions(id) on delete cascade,
  reviewer_name text not null default 'Anonymous',
  rating integer check (rating >= 1 and rating <= 5),
  comment text,
  timestamp_seconds integer,
  created_at timestamptz default now()
);

create table if not exists mf_releases (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  release_date date,
  project_id uuid references mf_projects(id) on delete set null,
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

create table if not exists mf_activity (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  project_id uuid references mf_projects(id) on delete cascade,
  version_id uuid,
  release_id uuid,
  description text,
  created_at timestamptz default now()
);

create index if not exists idx_versions_project_id on mf_versions(project_id);
create index if not exists idx_versions_share_token on mf_versions(share_token);
create index if not exists idx_feedback_version_id on mf_feedback(version_id);
create index if not exists idx_releases_project_id on mf_releases(project_id);
create index if not exists idx_activity_project_id on mf_activity(project_id);
create index if not exists idx_activity_created on mf_activity(created_at desc);

alter table mf_projects disable row level security;
alter table mf_versions disable row level security;
alter table mf_feedback disable row level security;
alter table mf_releases disable row level security;
alter table mf_activity disable row level security;
`

// GET /api/db-init — run Mixfolio database migrations via the Supabase Management API.
// Requires SUPABASE_MANAGEMENT_TOKEN env var (create one at supabase.com/dashboard/account/tokens).
// Also auto-creates storage buckets using the service role key.
export async function GET() {
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
    const { error } = await supabaseAdmin.from('mf_projects').select('id').limit(1)
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
