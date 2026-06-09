import { NextRequest, NextResponse } from 'next/server'
import { assertAdmin } from '@/lib/auth'
import { INFRA_NODES, INFRA_EDGES, LAYER_ORDER, type InfraNode } from '@/lib/infra/topology'
import { getRailwayStatus, type RailwayStatus } from '@/lib/infra/railway'
import { getSupabaseStatus, type SupabaseStatus } from '@/lib/infra/supabase'
import { getGithubStatus, type GithubStatus } from '@/lib/infra/github'
import { getStripeStatus, type StripeStatus } from '@/lib/infra/stripe'
import { getSentryStatus, type SentryStatus } from '@/lib/infra/sentry'

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

function githubNodeStatus(github: GithubStatus): { status: NodeStatus; metric?: string } {
  if (github.error || github.runs.length === 0) return { status: 'unknown', metric: 'CI: ?' }
  const anyFailed = github.runs.some((r) => r.conclusion === 'failure' || r.conclusion === 'cancelled')
  const anyRunning = github.runs.some((r) => r.status !== 'completed')
  const status: NodeStatus = anyFailed ? 'degraded' : 'ok'
  const tst = github.runs.find((r) => r.branch === 'tst')
  const metric = anyRunning ? 'CI: running' : `CI: ${tst?.conclusion ?? github.runs[0].conclusion ?? 'ok'}`
  return { status, metric }
}

function stripeNodeStatus(stripe: StripeStatus): { status: NodeStatus; metric?: string } {
  const mrr = (stripe.estimatedMrrCents / 100).toFixed(0)
  const paid = (stripe.tierCounts.pro ?? 0) + (stripe.tierCounts.studio ?? 0)
  return { status: 'ok', metric: `$${mrr}/mo · ${paid} paid` }
}

function sentryNodeStatus(sentry: SentryStatus): { status: NodeStatus; metric?: string } {
  if (!sentry.configured) return { status: 'not_configured', metric: 'no token' }
  if (sentry.error) return { status: 'unknown' }
  const n = sentry.shownIssues ?? 0
  return { status: n > 0 ? 'degraded' : 'ok', metric: `${n} open issue${n === 1 ? '' : 's'}` }
}

export async function GET(request: NextRequest) {
  const adminId = await assertAdmin(request)
  if (!adminId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const [railway, supabase, github, stripe, sentry] = await Promise.all([
    getRailwayStatus(),
    getSupabaseStatus(),
    getGithubStatus(),
    getStripeStatus(),
    getSentryStatus(),
  ])

  const nodes: TopologyNode[] = INFRA_NODES.map((node) => {
    switch (node.statusSource) {
      case 'railway':
        return { ...node, ...railwayNodeStatus(node, railway) }
      case 'supabase':
        return { ...node, ...supabaseNodeStatus(node, supabase) }
      case 'github':
        return { ...node, ...githubNodeStatus(github) }
      case 'stripe':
        return { ...node, ...stripeNodeStatus(stripe) }
      case 'sentry':
        return { ...node, ...sentryNodeStatus(sentry) }
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
      github: { configured: github.configured, authenticated: github.authenticated },
      stripe: { configured: stripe.configured },
      sentry: { configured: sentry.configured },
    },
    generatedAt: new Date().toISOString(),
  })
}
