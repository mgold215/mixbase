import { SUPABASE_URL } from '@/lib/supabase'

// Runtime self-heal for the additive mb_projects visualizer pin columns
// (visualizer_url from migration 015, visualizer_wide_url from 020 — one heal
// adds both since they always travel together).
//
// Migrations normally land via supabase/migrations + /api/db-init, but a deploy
// can reach production before either has run — and PostgREST rejects the WHOLE
// select/update when one referenced column is missing, which would break the
// player's track list. The routes that touch visualizer_url call this on that
// specific failure and retry, using the same Management API channel db-init
// uses. The ALTER is idempotent (add column if not exists) and the promise is
// memoized per process so it runs at most once per deploy.

const ALTER_SQL =
  'alter table mb_projects add column if not exists visualizer_url text;' +
  ' alter table mb_projects add column if not exists visualizer_wide_url text;'

let ensured: Promise<boolean> | null = null

export function ensureProjectVisualizerColumn(): Promise<boolean> {
  if (!ensured) {
    ensured = runAlter()
      .catch(() => false)
      .then(ok => {
        // Only cache success — a transient failure should retry on the next request.
        if (!ok) ensured = null
        return ok
      })
  }
  return ensured
}

async function runAlter(): Promise<boolean> {
  const token = process.env.SUPABASE_MANAGEMENT_TOKEN
  if (!token) return false
  const ref = SUPABASE_URL.replace('https://', '').replace('.supabase.co', '')
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: ALTER_SQL }),
  })
  if (!res.ok) console.error('[schema-heal] visualizer_url ALTER failed:', res.status, await res.text().catch(() => ''))
  return res.ok
}

/** True when a PostgREST error is the missing-column failure this module heals. */
export function isMissingVisualizerColumn(error: { message?: string } | null): boolean {
  // Matches either pin column ('visualizer_wide_url' does NOT contain the
  // substring 'visualizer_url', so both are checked explicitly).
  return !!error?.message && /visualizer(_wide)?_url/.test(error.message)
}

// ── mf-video bucket size limit (migration 016) ──────────────────────────────
// Final YouTube videos exceed the bucket's original 50 MB cap. The limit must
// be raised via direct SQL — the Storage API clamps updateBucket to the
// project's 500 MB global ceiling and silently downgrades (same gotcha as
// mf-audio). Memoized like the column heal; runs before large uploads.

const BUCKET_SQL = "update storage.buckets set file_size_limit = 524288000 where id = 'mf-video' and (file_size_limit is null or file_size_limit < 524288000);"

let bucketEnsured: Promise<boolean> | null = null

export function ensureVideoBucketLimit(): Promise<boolean> {
  if (!bucketEnsured) {
    bucketEnsured = runQuery(BUCKET_SQL, 'mf-video bucket limit')
      .catch(() => false)
      .then(ok => {
        if (!ok) bucketEnsured = null
        return ok
      })
  }
  return bucketEnsured
}

// ── Migration 017: race-safe usage RPC + unique version numbers ─────────────
// A deploy can reach production before migration 017 runs. tier.ts calls
// try_increment_usage on every AI generation and versions/route.ts relies on the
// unique (project_id, version_number) index for its retry loop; both heal here
// on the specific "function/relation missing" failure, using the same Management
// API channel db-init uses. Memoized per process; no-op without a Mgmt token.

const USAGE_RPC_SQL = `
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
-- Lock execution to the service role. REVOKE must include PUBLIC: a freshly
-- created function carries a default EXECUTE grant to PUBLIC, and revoking only
-- anon/authenticated leaves that PUBLIC grant intact — so both roles keep access
-- via /rest/v1/rpc and can inflate any user's quota. (Mirrors 017_prc_hardening.)
revoke execute on function public.try_increment_usage(uuid, text, text, int) from public, anon, authenticated;
grant execute on function public.try_increment_usage(uuid, text, text, int) to service_role;`

let usageRpcEnsured: Promise<boolean> | null = null

export function ensureUsageRpc(): Promise<boolean> {
  if (!usageRpcEnsured) {
    usageRpcEnsured = runQuery(USAGE_RPC_SQL, 'try_increment_usage RPC')
      .catch(() => false)
      .then(ok => {
        if (!ok) usageRpcEnsured = null
        return ok
      })
  }
  return usageRpcEnsured
}

/** True when a PostgREST error is the missing-function failure ensureUsageRpc heals. */
export function isMissingUsageRpc(error: { code?: string; message?: string } | null): boolean {
  return error?.code === 'PGRST202' || !!error?.message?.includes('try_increment_usage')
}

// ── Migration 018: lock the usage RPC's execute grant to service_role ────────
// try_increment_usage is SECURITY DEFINER, so it bypasses mb_usage RLS by
// design. A freshly created function carries a default EXECUTE grant to PUBLIC,
// which lets ANY anon or authenticated caller reach it via POST /rest/v1/rpc
// and inflate — or exhaust — any user's monthly quota. Migration 018 revokes
// that grant, and so does the revoke bundled into USAGE_RPC_SQL above. But both
// only run on the CREATE-FUNCTION path (ensureUsageRpc / db-init's SCHEMA_SQL),
// which fires ONLY when the function is absent. A production that created the
// function under migration 017 — before the revoke text existed — keeps the
// PUBLIC grant forever, because the calls succeed and no error ever triggers the
// create-path heal (verified live: anon can POST the RPC and reach the function
// body). This heal re-asserts the lockdown on its own. A REVOKE/GRANT is
// idempotent and safe to run against the already-present function, so it closes
// the grant on every environment, with no manual migration step, the first time
// a generation runs after a deploy. It deliberately does NOT re-create the
// function, so it can never race or diverge from the canonical definition.
const USAGE_RPC_GRANTS_SQL = `
revoke execute on function public.try_increment_usage(uuid, text, text, int) from public, anon, authenticated;
grant execute on function public.try_increment_usage(uuid, text, text, int) to service_role;
-- handle_new_user is a SECURITY DEFINER signup trigger, never meant to be
-- client-callable. It isn't reachable over /rest/v1/rpc (no-arg trigger shape),
-- but migration 018 revokes its PUBLIC grant too; applying the whole of 018 here
-- keeps the two in lockstep. No service_role grant — only its trigger fires it.
revoke execute on function public.handle_new_user() from public, anon, authenticated;`

let usageRpcGrantsEnsured: Promise<boolean> | null = null

export function ensureUsageRpcGrants(): Promise<boolean> {
  if (!usageRpcGrantsEnsured) {
    usageRpcGrantsEnsured = runQuery(USAGE_RPC_GRANTS_SQL, 'try_increment_usage grants')
      .catch(() => false)
      .then(ok => {
        // Only cache success — a transient failure should retry next generation.
        if (!ok) usageRpcGrantsEnsured = null
        return ok
      })
  }
  return usageRpcGrantsEnsured
}

// ── Migration 025: lock mb_usage's own write door ────────────────────────────
// mb_usage is the server-side tier-limit enforcement point. Migration 007 gave
// it INSERT/UPDATE policies scoped `user_id = auth.uid()`, and anon/authenticated
// hold the default table write grants — so any signed-in user could PATCH their
// own usage row to 0 over PostgREST and reset their paid-generation quota (no
// `>= 0` guard meant a negative value was a permanent bypass). Every app write
// goes through the service-role key (SECURITY DEFINER RPCs + supabaseAdmin),
// which bypasses RLS, so dropping the client write policies breaks nothing.
// This is the table-door twin of the RPC-door lockdown above; it heals the same
// way (migrations are applied by hand, so a deploy can't rely on 025 having run)
// — idempotent, memoized per process, fired from the generation path.
const USAGE_TABLE_LOCK_SQL = `
alter table public.mb_usage enable row level security;
drop policy if exists "Users can insert their own usage" on public.mb_usage;
drop policy if exists "Users can update their own usage" on public.mb_usage;
do $$ begin
  alter table public.mb_usage
    add constraint mb_usage_nonneg_counts
    check (artwork_generations >= 0 and video_generations >= 0);
exception when duplicate_object then null; end $$;`

let usageTableLockEnsured: Promise<boolean> | null = null

export function ensureUsageTableWriteLock(): Promise<boolean> {
  if (!usageTableLockEnsured) {
    usageTableLockEnsured = runQuery(USAGE_TABLE_LOCK_SQL, 'mb_usage write lockdown')
      .catch(() => false)
      .then(ok => {
        if (!ok) usageTableLockEnsured = null
        return ok
      })
  }
  return usageTableLockEnsured
}

// ── Migration 019: collection share token ────────────────────────────────────
// The public /share/album/[token] page and the collection Share button both
// select mb_collections.share_token. A deploy can reach production before the
// migration runs; heal on the specific missing-column failure and retry.

const COLLECTION_SHARE_SQL = `
alter table mb_collections
  add column if not exists share_token text unique default replace(gen_random_uuid()::text, '-', '');
update mb_collections
set share_token = replace(gen_random_uuid()::text, '-', '')
where share_token is null;
create index if not exists idx_collections_share_token on mb_collections(share_token);`

let collectionShareEnsured: Promise<boolean> | null = null

export function ensureCollectionShareToken(): Promise<boolean> {
  if (!collectionShareEnsured) {
    collectionShareEnsured = runQuery(COLLECTION_SHARE_SQL, 'mb_collections share_token')
      .catch(() => false)
      .then(ok => {
        if (!ok) collectionShareEnsured = null
        return ok
      })
  }
  return collectionShareEnsured
}

/** True when a PostgREST error is the missing-column failure ensureCollectionShareToken heals. */
export function isMissingCollectionShareToken(error: { message?: string } | null): boolean {
  return !!error?.message?.includes('share_token')
}

const VERSION_INDEX_SQL = `
create unique index if not exists mb_versions_project_version_uidx
  on public.mb_versions (project_id, version_number);`

let versionIndexEnsured: Promise<boolean> | null = null

export function ensureVersionUniqueIndex(): Promise<boolean> {
  if (!versionIndexEnsured) {
    versionIndexEnsured = runQuery(VERSION_INDEX_SQL, 'mb_versions unique index')
      .catch(() => false)
      .then(ok => {
        if (!ok) versionIndexEnsured = null
        return ok
      })
  }
  return versionIndexEnsured
}

// ── Migration 021: artist social links on profiles ──────────────────────────
// The submission portal reads/writes profiles.spotify_url + youtube_url. A
// deploy can reach production before the migration runs, and PostgREST rejects
// the whole select/upsert when a referenced column is missing; heal on that
// specific failure and retry. Idempotent ALTER, memoized per process.

const PROFILE_SOCIAL_SQL =
  'alter table public.profiles add column if not exists spotify_url text;' +
  ' alter table public.profiles add column if not exists youtube_url text;'

let profileSocialEnsured: Promise<boolean> | null = null

export function ensureProfileSocialColumns(): Promise<boolean> {
  if (!profileSocialEnsured) {
    profileSocialEnsured = runQuery(PROFILE_SOCIAL_SQL, 'profiles social columns')
      .catch(() => false)
      .then(ok => {
        if (!ok) profileSocialEnsured = null
        return ok
      })
  }
  return profileSocialEnsured
}

/** True when a PostgREST error is the missing-column failure this heals. */
export function isMissingProfileSocialColumn(error: { message?: string } | null): boolean {
  return !!error?.message && /(spotify|youtube)_url/.test(error.message)
}

// ── Migration 023: notification read cursor on profiles ──────────────────────
// GET /api/notifications reads profiles.activity_seen_at to decide which
// mb_activity rows are unread, and POST writes it when the bell is opened. Same
// deploy-beats-the-migration race as 021: PostgREST rejects the whole
// select/update when the column is missing, which silently pins the unread
// badge at zero (a read error there is indistinguishable from "nothing new").
// Heal on that specific failure and retry. Idempotent ALTER, memoized.

const ACTIVITY_SEEN_SQL =
  'alter table public.profiles add column if not exists activity_seen_at timestamptz default now();'

let activitySeenEnsured: Promise<boolean> | null = null

export function ensureActivitySeenColumn(): Promise<boolean> {
  if (!activitySeenEnsured) {
    activitySeenEnsured = runQuery(ACTIVITY_SEEN_SQL, 'profiles activity_seen_at column')
      .catch(() => false)
      .then(ok => {
        if (!ok) activitySeenEnsured = null
        return ok
      })
  }
  return activitySeenEnsured
}

/** True when a PostgREST error is the missing-column failure this heals. */
export function isMissingActivitySeenColumn(error: { message?: string } | null): boolean {
  return !!error?.message && /activity_seen_at/.test(error.message)
}

// ── mb_feed_comments (migration 022) ─────────────────────────────────────────
// A deploy can beat migration 022 to production (or a fresh environment may
// never have run it) — heal the table on the specific missing-relation error
// so feed comments degrade for one request instead of until manual action.

const FEED_COMMENTS_SQL = `
create table if not exists mb_feed_comments (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references mb_versions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  comment text not null,
  created_at timestamptz default now()
);
create index if not exists idx_feed_comments_version_id on mb_feed_comments(version_id);
create index if not exists idx_feed_comments_created on mb_feed_comments(created_at desc);
alter table mb_feed_comments enable row level security;
do $$ begin
  create policy "feed_comments_read_authenticated" on mb_feed_comments for select using (auth.uid() is not null);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "feed_comments_insert_own" on mb_feed_comments for insert with check (user_id = auth.uid());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "feed_comments_delete_own" on mb_feed_comments for delete using (user_id = auth.uid());
exception when duplicate_object then null; end $$;`

let feedCommentsEnsured: Promise<boolean> | null = null

export function ensureFeedCommentsTable(): Promise<boolean> {
  if (!feedCommentsEnsured) {
    feedCommentsEnsured = runQuery(FEED_COMMENTS_SQL, 'mb_feed_comments table')
      .catch(() => false)
      .then(ok => {
        if (!ok) feedCommentsEnsured = null
        return ok
      })
  }
  return feedCommentsEnsured
}

/** True when a PostgREST error is the missing-relation failure this heals. */
export function isMissingFeedCommentsTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  if (error.code === '42P01' && !!error.message?.includes('mb_feed_comments')) return true
  return !!error.message && error.message.includes('mb_feed_comments') && /does not exist|relation/.test(error.message)
}

// ── Migration 025: DistroKid metadata + waterfall sequencing ─────────────────
// The release routes write these mb_releases columns (details editor PATCH,
// waterfall POST). Same deploy-beats-the-migration race as the other heals:
// PostgREST rejects the whole insert/update when a referenced column is
// missing. Idempotent ALTERs, memoized per process.

const DISTROKID_SQL = `
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
  on mb_releases(waterfall_group_id, waterfall_position);`

let distroKidEnsured: Promise<boolean> | null = null

export function ensureDistroKidColumns(): Promise<boolean> {
  if (!distroKidEnsured) {
    distroKidEnsured = runQuery(DISTROKID_SQL, 'mb_releases DistroKid columns')
      .catch(() => false)
      .then(ok => {
        if (!ok) distroKidEnsured = null
        return ok
      })
  }
  return distroKidEnsured
}

/** True when a PostgREST error is the missing-column failure this heals. */
export function isMissingDistroKidColumn(error: { message?: string } | null): boolean {
  return !!error?.message &&
    /(artist_name|release_type|featured_artists|songwriters|producers|instrumental|secondary_genre|version_info|waterfall_group_id|waterfall_position)/.test(error.message)
}

async function runQuery(sql: string, label: string): Promise<boolean> {
  const token = process.env.SUPABASE_MANAGEMENT_TOKEN
  if (!token) return false
  const ref = SUPABASE_URL.replace('https://', '').replace('.supabase.co', '')
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  })
  if (!res.ok) console.error(`[schema-heal] ${label} SQL failed:`, res.status, await res.text().catch(() => ''))
  return res.ok
}
