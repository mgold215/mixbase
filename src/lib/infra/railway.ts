// Railway status aggregator for the infra control panel.
//
// Two independent signals, each degrades on its own:
//   1. App liveness — fetch `${envUrl}/api/health` for each environment. Needs
//      NO token, so the diagram always shows app up/down even with zero Railway
//      credentials.
//   2. Railway control-plane data — project / services / latest deployment via
//      the public GraphQL API. Needs RAILWAY_API_TOKEN; absent → { configured:false }.
//
// Contract: this module NEVER throws. Every failure path returns a structured
// object so the route can always respond 200 and the canvas can render a badge.

const RAILWAY_GQL = 'https://backboard.railway.app/graphql/v2'

// Known defaults from CLAUDE.md — overridable via env.
const DEFAULT_PROJECT_ID = '9ff29ad4-39cd-45d5-a0e9-5cbd4ffa2227'
const DEFAULT_PROD_URL = 'https://mixbase-production.up.railway.app'
const DEFAULT_STAGING_URL = 'https://mixbase-staging.up.railway.app'

export interface HealthProbe {
  ok: boolean
  db: 'ok' | 'error' | 'unknown'
  httpStatus: number | null
  latencyMs: number | null
  error?: string
}

export interface RailwayDeployment {
  status: string | null
  url: string | null
  createdAt: string | null
}

export interface RailwayEnvironment {
  name: string
  url: string
  health: HealthProbe
  deployment: RailwayDeployment | null
}

export interface RailwayStatus {
  configured: boolean
  project: { id: string; name: string } | null
  environments: RailwayEnvironment[]
  error?: string
}

// ── Health probe (token-free) ──────────────────────────────────────────────
async function probeHealth(baseUrl: string): Promise<HealthProbe> {
  const started = Date.now()
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 6000)
    const res = await fetch(`${baseUrl}/api/health`, {
      signal: controller.signal,
      cache: 'no-store',
    })
    clearTimeout(timeout)
    const latencyMs = Date.now() - started
    let db: 'ok' | 'error' | 'unknown' = 'unknown'
    try {
      const json = (await res.json()) as { db?: string }
      if (json.db === 'ok' || json.db === 'error') db = json.db
    } catch {
      /* non-JSON body — leave db unknown */
    }
    return { ok: res.ok, db, httpStatus: res.status, latencyMs }
  } catch (e) {
    return {
      ok: false,
      db: 'unknown',
      httpStatus: null,
      latencyMs: Date.now() - started,
      error: e instanceof Error ? e.message : 'fetch failed',
    }
  }
}

// ── Railway GraphQL (token-gated) ────────────────────────────────────────────
interface GqlServiceNode {
  id: string
  name: string
  deployments?: {
    edges: { node: { status?: string; staticUrl?: string; createdAt?: string; environmentId?: string } }[]
  }
}
interface GqlProjectResponse {
  data?: {
    project?: {
      id: string
      name: string
      environments?: { edges: { node: { id: string; name: string } }[] }
      services?: { edges: { node: GqlServiceNode }[] }
    }
  }
  errors?: { message: string }[]
}

async function railwayGraphQL(token: string, query: string, variables: Record<string, unknown>): Promise<GqlProjectResponse> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)
  try {
    const res = await fetch(RAILWAY_GQL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
      cache: 'no-store',
    })
    return (await res.json()) as GqlProjectResponse
  } finally {
    clearTimeout(timeout)
  }
}

const PROJECT_QUERY = `query project($id: String!) {
  project(id: $id) {
    id
    name
    environments { edges { node { id name } } }
    services {
      edges {
        node {
          id
          name
          deployments(first: 1) {
            edges { node { status staticUrl createdAt environmentId } }
          }
        }
      }
    }
  }
}`

export async function getRailwayStatus(): Promise<RailwayStatus> {
  const token = process.env.RAILWAY_API_TOKEN
  const projectId = process.env.RAILWAY_PROJECT_ID || DEFAULT_PROJECT_ID
  const prodUrl = process.env.RAILWAY_PROD_URL || DEFAULT_PROD_URL
  const stagingUrl = process.env.RAILWAY_STAGING_URL || DEFAULT_STAGING_URL

  // Health probes always run — they need no Railway token.
  const [prodHealth, stagingHealth] = await Promise.all([
    probeHealth(prodUrl),
    probeHealth(stagingUrl),
  ])

  const environments: RailwayEnvironment[] = [
    { name: 'production', url: prodUrl, health: prodHealth, deployment: null },
    { name: 'staging', url: stagingUrl, health: stagingHealth, deployment: null },
  ]

  if (!token) {
    return { configured: false, project: null, environments }
  }

  try {
    const json = await railwayGraphQL(token, PROJECT_QUERY, { id: projectId })
    if (json.errors?.length) {
      return { configured: true, project: null, environments, error: json.errors[0].message }
    }
    const project = json.data?.project
    if (!project) {
      return { configured: true, project: null, environments, error: 'project not found' }
    }

    // Map environment id → name, then attach each service's latest deployment to
    // its environment. Railway returns deployments newest-first.
    const envNameById = new Map<string, string>()
    for (const edge of project.environments?.edges ?? []) {
      envNameById.set(edge.node.id, edge.node.name.toLowerCase())
    }
    const latestByEnv = new Map<string, RailwayDeployment>()
    for (const edge of project.services?.edges ?? []) {
      const dep = edge.node.deployments?.edges?.[0]?.node
      if (!dep) continue
      const envName = dep.environmentId ? envNameById.get(dep.environmentId) : undefined
      if (!envName) continue
      // Keep the first (newest) deployment seen per environment.
      if (!latestByEnv.has(envName)) {
        latestByEnv.set(envName, {
          status: dep.status ?? null,
          url: dep.staticUrl ?? null,
          createdAt: dep.createdAt ?? null,
        })
      }
    }
    for (const env of environments) {
      env.deployment = latestByEnv.get(env.name) ?? null
    }

    return { configured: true, project: { id: project.id, name: project.name }, environments }
  } catch (e) {
    return {
      configured: true,
      project: null,
      environments,
      error: e instanceof Error ? e.message : 'railway query failed',
    }
  }
}
