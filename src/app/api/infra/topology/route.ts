import { NextRequest, NextResponse } from 'next/server'
import { assertAdmin } from '@/lib/auth'
import { INFRA_NODES, INFRA_EDGES, LAYER_ORDER, type InfraNode } from '@/lib/infra/topology'
import { getRailwayStatus, type RailwayStatus } from '@/lib/infra/railway'
import { getSupabaseStatus, type SupabaseStatus } from '@/lib/infra/supabase'

export const dynamic = 'force-dynamic'

type NodeStatus = 'ok' | 'degraded' | 'down' | 'unknown' | 'not_configured' | 'static'

interface TopologyNode extends InfraNode {
  status: NodeStatus
  metric?: string
}

function formatBytes(bytes: number | null): string | undefined {
  if (bytes == null) return undefined
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

function railwayNodeStatus(node: InfraNode, railway: RailwayStatus): { status: NodeStatus; metric?: string } {
  const envName = node.id === 'railway-prod' ? 'production' : node.id === 'railway-staging' ? 'staging' : null
  const env = envName ? railway.environments.find((e) => e.name === envName) : undefined
  if (!env) return { status: 'unknown' }
  const deployStatus = env.deployment?.status
  let status: NodeStatus
  if (!env.health.ok) status = 'down'
  else if (env.health.db === 'error') status = 'degraded'
  else status = 'ok'
  const metric = deployStatus
    ? `deploy: ${deployStatus}`
    : env.health.latencyMs != null
      ? `${env.health.latencyMs}ms`
      : undefined
  return { status, metric }
}

function supabaseNodeStatus(node: InfraNode, supabase: SupabaseStatus): { status: NodeStatus; metric?: string } {
  if (!supabase.configured) return { status: 'down' }
  if (node.id === 'supabase-db') {
    const total = supabase.tables.reduce((sum, t) => sum + (t.rowCount ?? 0), 0)
    return { status: 'ok', metric: `${total.toLocaleString()} rows` }
  }
  if (node.id === 'supabase-storage') {
    return { status: 'ok', metric: formatBytes(supabase.storage.totalUsedBytes) }
  }
  return { status: 'ok' }
}

export async function GET(request: NextRequest) {
  const adminId = await assertAdmin(request)
  if (!adminId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const [railway, supabase] = await Promise.all([getRailwayStatus(), getSupabaseStatus()])

  const nodes: TopologyNode[] = INFRA_NODES.map((node) => {
    switch (node.statusSource) {
      case 'railway':
        return { ...node, ...railwayNodeStatus(node, railway) }
      case 'supabase':
        return { ...node, ...supabaseNodeStatus(node, supabase) }
      case 'static':
        return { ...node, status: 'static' }
      default:
        return { ...node, status: 'unknown' }
    }
  })

  return NextResponse.json({
    nodes,
    edges: INFRA_EDGES,
    layerOrder: LAYER_ORDER,
    sources: {
      railway: { configured: railway.configured, error: railway.error ?? null },
      supabase: { configured: supabase.configured, managementConfigured: supabase.managementConfigured },
    },
    generatedAt: new Date().toISOString(),
  })
}
