// Supabase status aggregator for the infra control panel.
//
// Tiered access, each degrades independently:
//   • Row counts + bucket list use `supabaseAdmin` (service-role key). Always on.
//   • DB size, per-bucket bytes, and the applied-migrations list use the Supabase
//     Management API SQL endpoint (same shape as src/app/api/db-init/route.ts),
//     which needs SUPABASE_MANAGEMENT_TOKEN. Absent → those fields are null and
//     `managementConfigured:false` (never an error).
//
// Contract: never throws. Returns a structured object the route serializes as-is.

import { supabaseAdmin, SUPABASE_URL } from '@/lib/supabase'

// Tables to report row counts for. Missing tables degrade to rowCount:null.
const KNOWN_TABLES = [
  'profiles',
  'mb_projects',
  'mb_versions',
  'mb_feedback',
  'mb_releases',
  'mb_activity',
  'mb_collections',
  'mb_collection_items',
  'mb_usage',
  'sb_curators',
  'sb_submissions',
] as const

// Reference thresholds for scaling signals. Defaults are the Supabase free-tier
// quotas (storage 1GB, database 0.5GB); override via env once the plan is known.
const STORAGE_LIMIT_BYTES = Number(process.env.SUPABASE_STORAGE_LIMIT_BYTES) || 1024 ** 3
const DB_LIMIT_BYTES = Number(process.env.SUPABASE_DB_LIMIT_BYTES) || 512 * 1024 ** 2

export interface TableCount {
  table: string
  rowCount: number | null
  error?: string
}

export interface StorageBucketInfo {
  id: string
  name: string
  public: boolean
  fileSizeLimit: number | null
  objectCount: number | null
  usedBytes: number | null
}

export interface ScalingSignal {
  id: string
  label: string
  usedBytes: number
  limitBytes: number
  pct: number
  severity: 'ok' | 'warn' | 'critical'
}

export interface SupabaseStatus {
  configured: boolean // service-role client reachable
  managementConfigured: boolean // SUPABASE_MANAGEMENT_TOKEN present
  projectRef: string | null
  tables: TableCount[]
  storage: { buckets: StorageBucketInfo[]; totalUsedBytes: number | null }
  db: { sizeBytes: number | null; migrations: { version: string; name: string | null }[] | null }
  scalingSignals: ScalingSignal[]
  error?: string
}

function projectRefFromUrl(): string | null {
  try {
    return SUPABASE_URL.replace('https://', '').replace('.supabase.co', '') || null
  } catch {
    return null
  }
}

// Run a read-only SQL query via the Supabase Management API. Returns rows, or
// null when the token is absent or the call fails.
async function managementQuery(sql: string): Promise<Record<string, unknown>[] | null> {
  const token = process.env.SUPABASE_MANAGEMENT_TOKEN
  const ref = projectRefFromUrl()
  if (!token || !ref) return null
  try {
    const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql }),
      cache: 'no-store',
    })
    if (!res.ok) return null
    const json = await res.json()
    return Array.isArray(json) ? (json as Record<string, unknown>[]) : null
  } catch {
    return null
  }
}

function severityFor(pct: number): ScalingSignal['severity'] {
  if (pct >= 90) return 'critical'
  if (pct >= 70) return 'warn'
  return 'ok'
}

export async function getSupabaseStatus(): Promise<SupabaseStatus> {
  const projectRef = projectRefFromUrl()
  const managementConfigured = Boolean(process.env.SUPABASE_MANAGEMENT_TOKEN)

  // ── Row counts (service-role, parallel, per-table fault isolation) ─────────
  const tables: TableCount[] = await Promise.all(
    KNOWN_TABLES.map(async (table): Promise<TableCount> => {
      try {
        const { count, error } = await supabaseAdmin
          .from(table)
          .select('*', { count: 'exact', head: true })
        if (error) return { table, rowCount: null, error: error.message }
        return { table, rowCount: count ?? 0 }
      } catch (e) {
        return { table, rowCount: null, error: e instanceof Error ? e.message : 'count failed' }
      }
    })
  )

  // ── Storage buckets (service-role) ─────────────────────────────────────────
  const buckets: StorageBucketInfo[] = []
  let serviceReachable = true
  try {
    const { data, error } = await supabaseAdmin.storage.listBuckets()
    if (error) {
      serviceReachable = false
    } else {
      for (const b of data ?? []) {
        buckets.push({
          id: b.id,
          name: b.name,
          public: b.public,
          fileSizeLimit: b.file_size_limit ?? null,
          objectCount: null,
          usedBytes: null,
        })
      }
    }
  } catch {
    serviceReachable = false
  }

  // ── Per-bucket bytes + DB size + migrations (Management API) ───────────────
  let totalUsedBytes: number | null = null
  const usageRows = await managementQuery(
    `select bucket_id, count(*)::bigint as objects, coalesce(sum((metadata->>'size')::bigint),0)::bigint as bytes
     from storage.objects group by bucket_id`
  )
  if (usageRows) {
    totalUsedBytes = 0
    for (const row of usageRows) {
      const bucketId = String(row.bucket_id)
      const objects = Number(row.objects ?? 0)
      const bytes = Number(row.bytes ?? 0)
      totalUsedBytes += bytes
      const bucket = buckets.find((b) => b.id === bucketId)
      if (bucket) {
        bucket.objectCount = objects
        bucket.usedBytes = bytes
      }
    }
  }

  let dbSizeBytes: number | null = null
  const dbRows = await managementQuery('select pg_database_size(current_database())::bigint as size')
  if (dbRows && dbRows[0]) dbSizeBytes = Number(dbRows[0].size ?? 0)

  let migrations: { version: string; name: string | null }[] | null = null
  const migRows = await managementQuery(
    `select version, name from supabase_migrations.schema_migrations order by version desc limit 50`
  )
  if (migRows) {
    migrations = migRows.map((r) => ({
      version: String(r.version),
      name: r.name == null ? null : String(r.name),
    }))
  }

  // ── Scaling signals (only emitted when the underlying metric is known) ─────
  const scalingSignals: ScalingSignal[] = []
  if (totalUsedBytes != null) {
    const pct = Math.round((totalUsedBytes / STORAGE_LIMIT_BYTES) * 1000) / 10
    scalingSignals.push({
      id: 'storage_total',
      label: 'Storage used',
      usedBytes: totalUsedBytes,
      limitBytes: STORAGE_LIMIT_BYTES,
      pct,
      severity: severityFor(pct),
    })
  }
  if (dbSizeBytes != null) {
    const pct = Math.round((dbSizeBytes / DB_LIMIT_BYTES) * 1000) / 10
    scalingSignals.push({
      id: 'db_size',
      label: 'Database size',
      usedBytes: dbSizeBytes,
      limitBytes: DB_LIMIT_BYTES,
      pct,
      severity: severityFor(pct),
    })
  }

  return {
    configured: serviceReachable,
    managementConfigured,
    projectRef,
    tables,
    storage: { buckets, totalUsedBytes },
    db: { sizeBytes: dbSizeBytes, migrations },
    scalingSignals,
  }
}
