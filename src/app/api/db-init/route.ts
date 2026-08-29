import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { timingSafeEqual } from 'node:crypto'

// Constant-time string compare. Length differences short-circuit safely because
// we compare encoded bytes, not raw strings.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

// The bootstrap schema SQL. NOT a verbatim copy of supabase/migrations/ — it
// carries the subset of the numbered migrations that db-init owns (the
// public-schema tables this app creates), and EVERY statement must be
// idempotent, because this runs against environments that already hold some of
// these objects.
//
// Which migrations are carried here, and which are deliberately left out and
// why, is asserted by scripts/db-init-migration-parity-test.mjs. Adding a
// migration without either folding it in below or recording it as a documented
// exclusion in that test turns it red — which is the point: this blob silently
// fell five migrations behind before that guard existed.
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
  status text not null default 'Mix',
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

create table if not exists mb_feed_comments (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references mb_versions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  comment text not null,
  created_at timestamptz default now()
);

create index if not exists idx_versions_project_id on mb_versions(project_id);
create index if not exists idx_versions_share_token on mb_versions(share_token);
create index if not exists idx_feedback_version_id on mb_feedback(version_id);
create index if not exists idx_releases_project_id on mb_releases(project_id);
create index if not exists idx_activity_project_id on mb_activity(project_id);
create index if not exists idx_activity_created on mb_activity(created_at desc);
create index if not exists idx_feed_comments_version_id on mb_feed_comments(version_id);
create index if not exists idx_feed_comments_created on mb_feed_comments(created_at desc);

alter table mb_projects disable row level security;
alter table mb_versions disable row level security;
alter table mb_feedback disable row level security;
alter table mb_releases disable row level security;
alter table mb_activity disable row level security;

-- Ensure share_token column exists on versions (idempotent — safe to re-run)
alter table mb_versions
  add column if not exists share_token text unique default replace(gen_random_uuid()::text, '-', '');

create index if not exists idx_versions_share_token on mb_versions(share_token);

-- Backfill any rows that are still missing a share_token
update mb_versions
set share_token = replace(gen_random_uuid()::text, '-', '')
where share_token is null;

-- Migration 012: project-level share token (share link always resolves to latest mix)
alter table mb_projects
  add column if not exists share_token text unique default replace(gen_random_uuid()::text, '-', '');

update mb_projects
set share_token = replace(gen_random_uuid()::text, '-', '')
where share_token is null;

create index if not exists idx_projects_share_token on mb_projects(share_token);

-- Migration 015: project visualizer (Spotify-Canvas style video pinned to a project)
alter table mb_projects
  add column if not exists visualizer_url text;

-- Migration 020: horizontal (16:9) visualizer pin for the Full-Length finalize
alter table mb_projects
  add column if not exists visualizer_wide_url text;

-- Migration 035: per-project instrumental (no-vocals) audio slot
alter table mb_projects
  add column if not exists instrumental_url text;

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

-- Migration 019: collection-level share token (public /share/album/<token> player)
alter table mb_collections
  add column if not exists share_token text unique default replace(gen_random_uuid()::text, '-', '');

update mb_collections
set share_token = replace(gen_random_uuid()::text, '-', '')
where share_token is null;

create index if not exists idx_collections_share_token on mb_collections(share_token);

create index if not exists idx_collection_items_collection on mb_collection_items(collection_id);
create index if not exists idx_collection_items_position on mb_collection_items(collection_id, position);

-- Migration 005: multi-user support
alter table mb_projects    add column if not exists user_id uuid references auth.users(id);
alter table mb_releases    add column if not exists user_id uuid references auth.users(id);
alter table mb_collections add column if not exists user_id uuid references auth.users(id);
-- Migration 006 also puts user_id on mb_activity, and this blob had missed it.
-- Every activity insert in the app writes user_id explicitly (see
-- /api/projects, /api/versions, /api/feedback, /api/releases), so without this
-- column a database bootstrapped through db-init rejects EVERY activity write
-- with PGRST204. It is also what the users_own_activity policy below reads —
-- creating that policy against a table lacking the column aborts the entire
-- bootstrap run, since the Management API executes this whole body as one query.
alter table mb_activity    add column if not exists user_id uuid references auth.users(id);

create index if not exists idx_projects_user_id    on mb_projects(user_id);
create index if not exists idx_releases_user_id    on mb_releases(user_id);
create index if not exists idx_collections_user_id on mb_collections(user_id);
create index if not exists idx_activity_user_id    on mb_activity(user_id);

alter table mb_projects        enable row level security;
alter table mb_versions        enable row level security;
alter table mb_releases        enable row level security;
alter table mb_collections     enable row level security;
alter table mb_collection_items enable row level security;
alter table mb_feedback        enable row level security;
alter table mb_activity        enable row level security;
-- Migration 022: feed comments. Its only protection from the public anon key
-- (which holds default SELECT/INSERT/UPDATE/DELETE grants on public tables) is
-- RLS being ON — a table created without it is world-read/write via PostgREST.
alter table mb_feed_comments   enable row level security;

drop policy if exists "users_own_projects"         on mb_projects;
drop policy if exists "users_own_versions"         on mb_versions;
drop policy if exists "users_own_releases"         on mb_releases;
drop policy if exists "users_own_collections"      on mb_collections;
drop policy if exists "users_own_collection_items" on mb_collection_items;
drop policy if exists "public_feedback_insert"     on mb_feedback;
drop policy if exists "users_read_feedback"        on mb_feedback;
drop policy if exists "users_own_activity"         on mb_activity;
drop policy if exists "feed_comments_read_authenticated" on mb_feed_comments;
drop policy if exists "feed_comments_insert_own"         on mb_feed_comments;
drop policy if exists "feed_comments_delete_own"         on mb_feed_comments;

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

-- Migration 017 (prc_hardening) tightened this away from "with check (true)",
-- which let anyone insert feedback rows against any — or a non-existent —
-- version_id. The bootstrap blob still carried the permissive form, and the
-- drop/create pair here is unconditional: running db-init against an already
-- hardened database silently REVERTED the fix. Match the canonical migration.
create policy "public_feedback_insert" on mb_feedback
  for insert with check (
    version_id is not null
    and exists (select 1 from mb_versions v where v.id = version_id)
  );

create policy "users_read_feedback" on mb_feedback
  for select using (
    version_id in (
      select v.id from mb_versions v
      join mb_projects p on v.project_id = p.id
      where p.user_id = auth.uid()
    )
  );

-- Migration 006 SUPERSEDED migration 005's definition of this policy, and 006 is
-- what is live in production (verified against pg_policies). This blob carried
-- the 005 shape, and its drop/create pair above is unconditional — so running
-- db-init against production would have silently DOWNGRADED a live policy, the
-- same mechanism as the public_feedback_insert revert fixed just above.
--
-- The downgrade was a real weakening, not churn. The 005 predicate constrains
-- only the row's project_id and says nothing about user_id, so it would let a
-- user insert an mb_activity row carrying SOMEONE ELSE'S user_id as long as the
-- project_id is one of their own. The 006 predicate constrains the row's own
-- user_id, which is the property that actually matters. Do not "restore" 005.
create policy "users_own_activity" on mb_activity
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Migration 022: feed comments — readable by every signed-in artist, writable/
-- deletable only by their author. (Server routes use the service-role key and
-- bypass RLS; these policies cover the iOS app, which talks to PostgREST
-- directly with the user's JWT.)
create policy "feed_comments_read_authenticated" on mb_feed_comments
  for select using (auth.uid() is not null);

create policy "feed_comments_insert_own" on mb_feed_comments
  for insert with check (user_id = auth.uid());

create policy "feed_comments_delete_own" on mb_feed_comments
  for delete using (user_id = auth.uid());

-- Migration 017: atomic usage metering + unique version numbers
create or replace function public.try_increment_usage(
  p_user_id uuid, p_month text, p_feature text, p_limit int
) returns table(allowed boolean, used int)
language plpgsql security definer set search_path = public as $$
declare v_used int;
begin
  insert into public.mb_usage (user_id, month, artwork_generations, video_generations, updated_at)
  values (p_user_id, p_month, 0, 0, now())
  on conflict (user_id, month) do nothing;
  select case when p_feature = 'artwork' then artwork_generations else video_generations end
    into v_used from public.mb_usage
   where user_id = p_user_id and month = p_month for update;
  if v_used >= p_limit then allowed := false; used := v_used; return next; return; end if;
  if p_feature = 'artwork' then
    update public.mb_usage set artwork_generations = artwork_generations + 1, updated_at = now()
     where user_id = p_user_id and month = p_month;
  else
    update public.mb_usage set video_generations = video_generations + 1, updated_at = now()
     where user_id = p_user_id and month = p_month;
  end if;
  allowed := true; used := v_used + 1; return next;
end; $$;
-- REVOKE must include PUBLIC (not just anon/authenticated): a new function keeps
-- its default EXECUTE grant to PUBLIC, through which both roles could otherwise
-- still call it and inflate any user's quota. (Mirrors 017_prc_hardening.)
revoke execute on function public.try_increment_usage(uuid, text, text, int) from public, anon, authenticated;
grant execute on function public.try_increment_usage(uuid, text, text, int) to service_role;

-- Migration 025: mb_usage is the tier-limit enforcement point, written only via
-- the service-role key (SECURITY DEFINER RPCs above + supabaseAdmin). Migration
-- 007's client INSERT/UPDATE policies let any signed-in user PATCH their own
-- usage row to 0 over PostgREST and reset their paid quota. Drop them (own-row
-- SELECT stays for the UI) and guard the counters non-negative.
alter table public.mb_usage enable row level security;
drop policy if exists "Users can insert their own usage" on public.mb_usage;
drop policy if exists "Users can update their own usage" on public.mb_usage;
do $$ begin
  alter table public.mb_usage
    add constraint mb_usage_nonneg_counts
    check (artwork_generations >= 0 and video_generations >= 0);
exception when duplicate_object then null; end $$;

with ranked as (
  select id, row_number() over (
    partition by project_id order by version_number asc, created_at asc, id asc
  ) as rn from public.mb_versions
)
update public.mb_versions v set version_number = ranked.rn
  from ranked where v.id = ranked.id and v.version_number <> ranked.rn;

create unique index if not exists mb_versions_project_version_uidx
  on public.mb_versions (project_id, version_number);

-- Migration 026: DistroKid submission metadata + waterfall sequencing
alter table mb_releases add column if not exists artist_name      text;
alter table mb_releases add column if not exists release_type     text not null default 'single';
alter table mb_releases add column if not exists featured_artists text;
alter table mb_releases add column if not exists songwriters      text;
alter table mb_releases add column if not exists producers        text;
alter table mb_releases add column if not exists explicit         boolean not null default false;
alter table mb_releases add column if not exists instrumental     boolean not null default false;
alter table mb_releases add column if not exists language         text not null default 'English';
alter table mb_releases add column if not exists secondary_genre  text;
alter table mb_releases add column if not exists version_info     text;
alter table mb_releases add column if not exists upc              text;
alter table mb_releases add column if not exists waterfall_group_id uuid;
alter table mb_releases add column if not exists waterfall_position integer;

create index if not exists idx_releases_waterfall_group
  on mb_releases(waterfall_group_id, waterfall_position);

-- Migration 027: released-track library
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

-- ── 028 + 029 (storage RLS) are DELIBERATELY NOT CARRIED HERE ───────────────
-- Both rewrite RLS on storage.objects and both are still awaiting the owner's
-- sign-off; their own headers say so. Folding them in would apply that pending
-- decision as a side effect of "run the bootstrap", which is wrong for three
-- reasons:
--   1. There is no such thing as an isolated fresh environment here. This route
--      targets whatever NEXT_PUBLIC_SUPABASE_URL points at, and staging and
--      production are the SAME Supabase project — so the first db-init run
--      against either applies the change to production, with no smoke test
--      queued and nobody watching for the rollback window.
--   2. 028 is destructive. It drops the three live "Public read mf-*" policies,
--      and its own note puts the blast radius at "all audio playback stops" if
--      the public-object reasoning turns out to be wrong. A bootstrap endpoint
--      is the worst possible vehicle for a change that needs a curl check ready
--      in the other terminal.
--   3. This blob has never contained a single storage.objects statement. Every
--      storage grant in this app comes from a numbered migration, and the
--      buckets themselves are created by Step 2 of this route through the
--      Storage API — not from SQL. Making db-init a second, quieter owner of
--      storage RLS is a worse end state than the drift it would close.
-- When the owner approves them, apply the migration files with their documented
-- verify steps and fold them in here in the same change.

-- Migration 030: UGC moderation — content reports + user blocks (App Store 1.2).
-- Both tables are SERVER-ONLY: every read and write goes through the API routes
-- with supabaseAdmin, which validates identity from the middleware's X-User-Id.
-- Migration 030 expresses that as "RLS on, no policies" (which denies the anon
-- and authenticated PostgREST roles by default). Here the same deny-all is
-- written out explicitly as a "using (false)" policy: it grants nothing that
-- no-policy did not already grant, it states the intent where a reader of the
-- bootstrap blob will actually look, and it keeps the "every created table
-- carries a policy" invariant in scripts/db-init-rls-test.mjs true without
-- weakening that guard for the tables where it really matters.
create table if not exists mb_content_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id) on delete cascade,
  -- Polymorphic on purpose (no FK on content_id): 'version' rows point at
  -- mb_versions, 'comment' rows at mb_feed_comments. Comments are hard-deleted
  -- at the report threshold; orphaned report rows are the audit trail.
  content_type text not null check (content_type in ('version', 'comment')),
  content_id uuid not null,
  reason text,
  created_at timestamptz not null default now(),
  unique (reporter_id, content_type, content_id)
);

create table if not exists mb_user_blocks (
  id uuid primary key default gen_random_uuid(),
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (blocker_id, blocked_id)
);

create index if not exists idx_content_reports_content on mb_content_reports(content_type, content_id);
create index if not exists idx_user_blocks_blocker on mb_user_blocks(blocker_id);

alter table mb_content_reports enable row level security;
alter table mb_user_blocks     enable row level security;

drop policy if exists "content_reports_server_only" on mb_content_reports;
create policy "content_reports_server_only" on mb_content_reports
  using (false) with check (false);

drop policy if exists "user_blocks_server_only" on mb_user_blocks;
create policy "user_blocks_server_only" on mb_user_blocks
  using (false) with check (false);

-- Migration 031: the FX-engine recipe (VizRecipe JSON) behind a saved clip.
-- "alter table IF EXISTS" on purpose. mb_visualizers is created by migration
-- 014, which this blob has never carried, so on a project bootstrapped only
-- through db-init the table is absent — and a bare ALTER against a missing
-- relation aborts the WHOLE run, taking every statement after it down with it.
-- Every environment that does have the table gets the column; the rest are no
-- worse off than before, and src/lib/schema-heal.ts
-- (ensureVisualizerSettingsColumn) still adds it at runtime.
alter table if exists mb_visualizers add column if not exists settings jsonb;

-- Migration 032: per-version loudness (BS.1770-4). Nullable, no defaults and no
-- backfill on purpose — a measurement costs seconds of CPU over fully decoded
-- audio, so it can only come from a user pressing "Measure loudness", and NULL
-- means "never measured", a real and permanent state that has to stay
-- distinguishable from a measured value.
alter table mb_versions add column if not exists loudness_lufs            real;
alter table mb_versions add column if not exists loudness_short_term_lufs real;
alter table mb_versions add column if not exists sample_peak_db           real;
alter table mb_versions add column if not exists loudness_measured_at     timestamptz;
alter table mb_versions add column if not exists loudness_algo            text;

-- Migration 033: one mb_visualizers row per stored mf-video object. A retried
-- save claim could write a SECOND row over the same object, and deleting either
-- one takes the shared bytes with it — the survivor is left pointing at a 404.
--
-- Guarded on the table existing, for the same reason 031 above uses "alter table
-- IF EXISTS": mb_visualizers comes from migration 014, which this blob has never
-- carried, and CREATE INDEX has no IF EXISTS for its target table — an unguarded
-- one would abort the whole bootstrap on a project that lacks it.
--
-- The de-duplication is not optional: "create unique index" fails outright if
-- duplicates already exist. It keeps the OLDEST row per video_url and deletes
-- the rest. Those rows describe bytes that are NOT deleted — the survivor still
-- points at the same object, so nothing becomes unreachable.
do $$ begin
  if to_regclass('public.mb_visualizers') is not null then
    with ranked as (
      select id,
             row_number() over (
               partition by video_url
               order by created_at asc nulls last, id asc
             ) as rn
      from mb_visualizers
    )
    delete from mb_visualizers v
    using ranked r
    where v.id = r.id
      and r.rn > 1;

    create unique index if not exists mb_visualizers_video_url_uidx
      on mb_visualizers (video_url);
  end if;
end $$;

-- PostgREST caches the schema. Without this nudge the first write after a
-- bootstrap can still fail with "column not found in schema cache" (PGRST204)
-- even though the DDL above succeeded.
notify pgrst, 'reload schema';
`

// GET /api/db-init — run mixBase database migrations via the Supabase Management API.
// Requires SUPABASE_MANAGEMENT_TOKEN env var (create one at supabase.com/dashboard/account/tokens).
// Also auto-creates storage buckets using the service role key.
//
// Auth: the caller must present `x-setup-token: <token>` where <token> matches
// either DB_INIT_SECRET (preferred) or SUPABASE_MANAGEMENT_TOKEN. Without this,
// any unauthenticated visitor could trigger schema runs against the production
// database. Routes under /api/db-init are kept in the middleware's PUBLIC_PATHS
// because the very first call happens before any user exists — so we gate at
// the handler instead of at the cookie layer.
export async function GET(request: NextRequest) {
  const provided = request.headers.get('x-setup-token') ?? ''
  const expected = process.env.DB_INIT_SECRET || process.env.SUPABASE_MANAGEMENT_TOKEN || ''
  if (!expected || !provided || !safeEqual(provided, expected)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
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
          : ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'],
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
