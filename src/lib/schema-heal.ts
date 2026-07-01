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
