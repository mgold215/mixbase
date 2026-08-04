import * as Sentry from '@sentry/nextjs'
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
//
// The DO block + advisory lock are load-bearing, not decoration. REVOKE/GRANT
// rewrites a row in the pg_proc catalog, and this heal fires once per fresh
// process from /api/health — so a Railway rollout boots two containers that
// both re-assert the same grant within seconds of each other, and Postgres
// kills the loser with `XX000: tuple concurrently updated` (observed live as
// Sentry MIXBASE-6, 2 seconds after app_start_time). The heal therefore failed
// precisely when it was LEAST needed: the grant state was already correct, the
// healer just couldn't rewrite the row. Worse, the failure nulls the memo, so
// the loser retries and the noise sustains itself.
//
// pg_advisory_xact_lock makes concurrent healers queue instead of collide: the
// second one waits, then runs the same idempotent statements against an already
// correct state and succeeds. The lock is transaction-scoped and a DO block is
// its own transaction, so it is released the moment the block ends — no unlock
// bookkeeping, and no way to leak a lock if a statement throws.
//
// Deliberately NOT done: reading pg_proc.proacl first and skipping the DDL when
// it already looks right. That would also stop the race, but a predicate with a
// bug silently skips a heal that IS needed — and this is the code that closes
// the anon-key quota-griefing hole. Serialize the write; don't get clever about
// avoiding it.
const USAGE_RPC_GRANTS_SQL = `
do $$ begin
  perform pg_advisory_xact_lock(hashtext('mixbase:usage_rpc_grants'));
  revoke execute on function public.try_increment_usage(uuid, text, text, int) from public, anon, authenticated;
  grant execute on function public.try_increment_usage(uuid, text, text, int) to service_role;
  -- handle_new_user is a SECURITY DEFINER signup trigger, never meant to be
  -- client-callable. It isn't reachable over /rest/v1/rpc (no-arg trigger shape),
  -- but migration 018 revokes its PUBLIC grant too; applying the whole of 018 here
  -- keeps the two in lockstep. No service_role grant — only its trigger fires it.
  revoke execute on function public.handle_new_user() from public, anon, authenticated;
end $$;`

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
// Same catalog-race exposure as the grants heal above (DROP POLICY and ALTER
// TABLE rewrite pg_policy/pg_class rows), so it takes the same treatment under
// its own lock key — the two heals serialize against their own kind, never
// against each other. The nested BEGIN/EXCEPTION replaces what used to be a
// second `do $$` block: plpgsql sub-blocks catch duplicate_object exactly the
// same way, and avoiding nested dollar-quoting keeps this readable.
const USAGE_TABLE_LOCK_SQL = `
do $$ begin
  perform pg_advisory_xact_lock(hashtext('mixbase:usage_table_lock'));
  alter table public.mb_usage enable row level security;
  drop policy if exists "Users can insert their own usage" on public.mb_usage;
  drop policy if exists "Users can update their own usage" on public.mb_usage;
  begin
    alter table public.mb_usage
      add constraint mb_usage_nonneg_counts
      check (artwork_generations >= 0 and video_generations >= 0);
  exception when duplicate_object then null; end;
end $$;`

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

// ── Making the two lockdowns above actually run ──────────────────────────────
// Both heals are memoized per process and fired from checkAndIncrementUsage —
// i.e. only when a user starts a PAID artwork/video generation. That trigger is
// far too rare to rely on: verified against the LIVE database on 2026-08-02,
// weeks after the heals shipped, `pg_proc.proacl` for try_increment_usage was
// still `{=X/postgres, postgres=X/postgres, service_role=X/postgres}` — the
// leading `=X` is the PUBLIC grant, so the anon-key quota-griefing hole the
// heal exists to close was still WIDE OPEN in production. (The two
// increment_*_usage functions, revoked by an applied migration, correctly show
// no PUBLIC entry — the contrast is the proof.) The heal was never broken; it
// simply never ran, because no generation happened to land on a process that
// had not already healed.
//
// So fire the security-critical heals from a path that is guaranteed to execute:
// the health check, which Railway hits on every single deploy. That turns
// "eventually, if someone pays to generate" into "once per deploy, always".
//
// Bounded retry is what makes that safe. /api/health is PUBLIC and
// unauthenticated, and the heals above null their memo on failure so the next
// call retries — from a public endpoint that is an unbounded amplifier pointed
// at the Supabase Management API. Cap the attempts and space them out, so a
// persistently failing heal costs at most HEAL_MAX_ATTEMPTS calls per process
// instead of one per request.
const HEAL_MAX_ATTEMPTS = 5
const HEAL_RETRY_COOLDOWN_MS = 60_000

let securityHealAttempts = 0
let securityHealLastAttempt = 0
let securityHealDone = false

/**
 * Re-assert the security-critical lockdowns (usage-RPC execute grant + mb_usage
 * write door). Idempotent, cheap once satisfied, and safe to call from a public
 * endpoint: it is rate-limited and attempt-capped per process. Never throws.
 *
 * Returns true once both lockdowns have been applied successfully.
 */
export async function ensureSecurityHeals(): Promise<boolean> {
  if (securityHealDone) return true
  if (securityHealAttempts >= HEAL_MAX_ATTEMPTS) return false

  const now = Date.now()
  if (securityHealAttempts > 0 && now - securityHealLastAttempt < HEAL_RETRY_COOLDOWN_MS) return false
  securityHealAttempts++
  securityHealLastAttempt = now

  // Both must succeed before we stop retrying — they are independent doors into
  // the same quota ledger, and healing one does not close the other.
  const [grants, tableLock] = await Promise.all([
    ensureUsageRpcGrants().catch(() => false),
    ensureUsageTableWriteLock().catch(() => false),
  ])
  securityHealDone = grants && tableLock
  return securityHealDone
}

// ── Sign in with Apple: accept the native app's bundle ID ────────────────────
// The iOS app signs in natively (ASAuthorizationController) and posts Apple's
// id_token straight to GoTrue (grant_type=id_token). Apple mints that token
// with aud = the app's BUNDLE ID — not the Services ID the web OAuth button
// uses — and GoTrue rejects any audience it wasn't told about:
//   "Unacceptable audience in id_token: [com.moodmixformat.mixbase]"
// (the App Store rejection of 2026-08-04). The allow-list lives in the hosted
// project's auth config, not in the database, so the SQL channel can't heal it;
// this one reads and PATCHes the Management API auth config instead. Additive
// only: the bundle ID is merged into external_apple_additional_client_ids and
// the web flow's Services ID in external_apple_client_id is never touched.

const APPLE_NATIVE_CLIENT_ID = 'com.moodmixformat.mixbase'

let appleClientIdEnsured: Promise<boolean> | null = null

export function ensureAppleNativeClientId(): Promise<boolean> {
  if (!appleClientIdEnsured) {
    appleClientIdEnsured = healAppleNativeClientId()
      .catch(() => false)
      .then(ok => {
        if (!ok) appleClientIdEnsured = null
        return ok
      })
  }
  return appleClientIdEnsured
}

async function healAppleNativeClientId(): Promise<boolean> {
  const token = process.env.SUPABASE_MANAGEMENT_TOKEN
  if (!token) return false
  // Shares runQuery's per-process failure budget: this heal fires from the
  // public health endpoint, so it needs the same amplifier cap even though it
  // isn't SQL.
  const label = 'apple native client id'
  if ((runQueryFailures.get(label) ?? 0) >= RUN_QUERY_MAX_FAILURES) return false
  const ref = SUPABASE_URL.replace('https://', '').replace('.supabase.co', '')
  const endpoint = `https://api.supabase.com/v1/projects/${ref}/config/auth`
  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }

  const fail = (stage: string, status: number, detail: string) => {
    runQueryFailures.set(label, (runQueryFailures.get(label) ?? 0) + 1)
    console.error(`[schema-heal] ${label} ${stage} failed:`, status, detail)
    Sentry.captureMessage(`schema-heal: ${label} ${stage} failed (${status})`, {
      level: status === 401 || status === 403 ? 'error' : 'warning',
      tags: { heal: label, status: String(status) },
      // `detail` is Supabase's error envelope, never the token.
      extra: { detail: detail.slice(0, 500) },
    })
    return false
  }

  const res = await fetch(endpoint, { headers })
  if (!res.ok) return fail('read', res.status, await res.text().catch(() => ''))
  const config = (await res.json().catch(() => null)) as {
    external_apple_client_id?: string | null
    external_apple_additional_client_ids?: string | null
  } | null
  if (!config) return fail('read', res.status, 'unparseable auth config response')

  const split = (v: string | null | undefined) =>
    (v ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const additional = split(config.external_apple_additional_client_ids)
  const accepted = [...split(config.external_apple_client_id), ...additional]
  if (accepted.includes(APPLE_NATIVE_CLIENT_ID)) {
    runQueryFailures.delete(label)
    return true
  }

  const patch = await fetch(endpoint, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      external_apple_additional_client_ids: [...additional, APPLE_NATIVE_CLIENT_ID].join(','),
    }),
  })
  if (!patch.ok) return fail('write', patch.status, await patch.text().catch(() => ''))
  runQueryFailures.delete(label)
  // Success is logged (unlike the SQL heals) because this one closes a live
  // App Review rejection — the deploy log is where that fix is confirmed.
  console.log(`[schema-heal] ${label}: added ${APPLE_NATIVE_CLIENT_ID} to accepted Apple audiences`)
  return true
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

// ── Migration 026: DistroKid metadata + waterfall sequencing ─────────────────
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
  on mb_releases(waterfall_group_id, waterfall_position);
notify pgrst, 'reload schema';`

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

// Every heal in this module runs through here, and every failure was reported
// ONLY to console.error — which nothing watches. That made a dead heal
// indistinguishable from a healthy one: confirmed on 2026-08-02, when the
// Railway-stored SUPABASE_MANAGEMENT_TOKEN turned out to be rejected with
// `401 JWT could not be decoded` on BOTH staging and production, meaning every
// self-heal in the app (visualizer columns, video bucket limit, usage RPC
// grants, mb_usage lockdown, share tokens, DistroKid columns…) had been
// silently no-op for an unknown period while the code looked correct.
//
// A missing token is a deliberate, quiet opt-out (local dev). A token that IS
// present and REJECTED is a broken deployment, so report that one to Sentry —
// it is the only signal that distinguishes "healing" from "pretending to heal".
// ── Migration 027: released-track library ────────────────────────────────────
// /api/library reads and writes mb_library_tracks on every visit to /library.
// Same deploy-beats-the-migration race as the other heals — create the table
// on the specific missing-relation error and retry. Policy creation is guarded
// with do-blocks because CREATE POLICY has no IF NOT EXISTS (mirrors the
// mb_feed_comments heal).

const LIBRARY_TRACKS_SQL = `
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
do $$ begin
  create policy "users_own_library_tracks" on mb_library_tracks
    using (auth.uid() = user_id) with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;
-- PostgREST caches the schema; without this reload nudge the retry that
-- follows the heal still sees "table not found in schema cache" (PGRST205)
-- and the first sync after a fresh deploy fails even though the DDL worked.
notify pgrst, 'reload schema';`

let libraryTracksEnsured: Promise<boolean> | null = null

export function ensureLibraryTracksTable(): Promise<boolean> {
  if (!libraryTracksEnsured) {
    libraryTracksEnsured = runQuery(LIBRARY_TRACKS_SQL, 'mb_library_tracks table')
      .catch(() => false)
      .then(ok => {
        if (!ok) libraryTracksEnsured = null
        return ok
      })
  }
  return libraryTracksEnsured
}

/** True when a PostgREST error is the missing-relation failure this heals. */
export function isMissingLibraryTracksTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  if (error.code === '42P01' && !!error.message?.includes('mb_library_tracks')) return true
  return !!error.message && error.message.includes('mb_library_tracks') && /does not exist|relation|schema cache/.test(error.message)
}

// ── Profile save fallback (RLS-degraded admin client) ────────────────────────
// PATCH /api/auth/me writes profiles through supabaseAdmin. If that client is
// degraded (service key missing/rotated/wrong), the upsert dies on RLS because
// profiles deliberately has no INSERT policy and read/update are own-row-only
// (migration 024). This routes the same upsert through the Management SQL
// channel, which authorizes with SUPABASE_MANAGEMENT_TOKEN instead of the
// service key — so the user's save still lands while the key gets fixed.
const PROFILE_UPSERT_COLS = new Set(['artist_name', 'display_name', 'spotify_url', 'youtube_url'])

export async function upsertProfileViaManagementSql(
  userId: string,
  updates: Record<string, string>,
): Promise<boolean> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) return false
  const entries = Object.entries(updates).filter(([key]) => PROFILE_UPSERT_COLS.has(key))
  if (entries.length === 0) return false

  const escape = (value: string) => `'${value.replace(/'/g, "''")}'`
  const cols = entries.map(([key]) => key).join(', ')
  const vals = entries.map(([, value]) => escape(value)).join(', ')
  const sets = entries.map(([key, value]) => `${key} = ${escape(value)}`).join(', ')
  const sql = `insert into profiles (id, ${cols}) values ('${userId}', ${vals}) on conflict (id) do update set ${sets};`
  return runQuery(sql, 'profiles upsert fallback')
}

/**
 * Postgres catalog contention — two healers rewriting the same pg_proc/pg_class
 * row at once. It is not a defect in the SQL and it self-clears on a retry, so
 * it must not page anyone; the advisory locks above make it rare, and this
 * classifier keeps the residual (a lock taken on a connection that dies
 * mid-flight, say) from looking like a real failure.
 */
function isTransientCatalogRace(detail: string): boolean {
  return /tuple concurrently updated|deadlock detected|could not serialize access/i.test(detail)
}

// Per-label failure budget for the whole process.
//
// Every heal memoizes its promise but NULLS the memo on failure so the next
// caller retries — deliberate, but only `ensureSecurityHeals` was ever capped,
// because only it was reachable from a public endpoint. The rest are reachable
// from ordinary authenticated routes that mostly have no rate limiter (34 of 48
// write routes don't — that's the house norm), so one client looping a failing
// request turned each attempt into a Supabase Management API call.
//
// Capping here rather than in the ten individual heals means every heal — and
// every future one — is covered by construction, and no call site changes.
const RUN_QUERY_MAX_FAILURES = 8
const runQueryFailures = new Map<string, number>()

async function runQuery(sql: string, label: string): Promise<boolean> {
  const token = process.env.SUPABASE_MANAGEMENT_TOKEN
  if (!token) return false
  if ((runQueryFailures.get(label) ?? 0) >= RUN_QUERY_MAX_FAILURES) return false
  const ref = SUPABASE_URL.replace('https://', '').replace('.supabase.co', '')

  // At most one retry, and ONLY for the transient catalog race. Everything else
  // (bad credential, bad SQL) is reported on the first failure — retrying those
  // just doubles the load on the Management API from a public endpoint.
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql }),
    })
    if (res.ok) {
      // A heal that succeeds clears its budget: the next drift is a fresh
      // problem, not a continuation of an old one.
      runQueryFailures.delete(label)
      return true
    }

    const detail = await res.text().catch(() => '')
    const transient = isTransientCatalogRace(detail)
    if (transient && attempt === 0) {
      console.warn(`[schema-heal] ${label} hit catalog contention, retrying once`)
      continue
    }
    runQueryFailures.set(label, (runQueryFailures.get(label) ?? 0) + 1)

    console.error(`[schema-heal] ${label} SQL failed:`, res.status, detail)
    // 401/403 = the credential itself is bad; that never self-recovers and
    // disables every heal at once, so it is worth waking someone up for.
    Sentry.captureMessage(`schema-heal: ${label} failed (${res.status})`, {
      level: res.status === 401 || res.status === 403 ? 'error' : 'warning',
      tags: { heal: label, status: String(res.status), transient: String(transient) },
      // `detail` is Supabase's own error envelope, never the SQL or the token.
      extra: { detail: detail.slice(0, 500) },
    })
    return false
  }
  return false
}
