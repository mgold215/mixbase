import { SUPABASE_URL } from '@/lib/supabase'

// Runtime self-heal for the additive mb_projects.visualizer_url column.
//
// Migrations normally land via supabase/migrations + /api/db-init, but a deploy
// can reach production before either has run — and PostgREST rejects the WHOLE
// select/update when one referenced column is missing, which would break the
// player's track list. The routes that touch visualizer_url call this on that
// specific failure and retry, using the same Management API channel db-init
// uses. The ALTER is idempotent (add column if not exists) and the promise is
// memoized per process so it runs at most once per deploy.

const ALTER_SQL = 'alter table mb_projects add column if not exists visualizer_url text;'

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
  return !!error?.message?.includes('visualizer_url')
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
