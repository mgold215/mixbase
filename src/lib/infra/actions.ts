// Phase-3 SAFE control actions for the infra panel — reversible operations only.
//
// Scope (deliberately narrow): Railway deployment restart/redeploy and GitHub CI
// re-run. NO destructive operations (no write SQL, no user deletion, no paid
// resource scaling). Every action is admin-gated at the route, requires an
// explicit confirm flag, and degrades to a clear message (never throws) when the
// needed token is missing.

const RAILWAY_GQL = 'https://backboard.railway.app/graphql/v2'
const DEFAULT_PROJECT_ID = '9ff29ad4-39cd-45d5-a0e9-5cbd4ffa2227'
const DEFAULT_REPO = 'mgold215/mixbase'

export interface ActionResult {
  ok: boolean
  message: string
}

interface GqlResponse {
  data?: unknown
  errors?: { message: string }[]
}

async function railwayGql(token: string, query: string, variables: Record<string, unknown>): Promise<GqlResponse> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)
  try {
    const res = await fetch(RAILWAY_GQL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
      cache: 'no-store',
    })
    return (await res.json()) as GqlResponse
  } finally {
    clearTimeout(timeout)
  }
}

// Resolve the latest deployment id for a given environment name (production/staging).
interface LatestDeployment {
  deploymentId: string
  serviceId: string
  environmentId: string
}

const LATEST_DEPLOYMENT_QUERY = `query($id: String!) {
  project(id: $id) {
    environments { edges { node { id name } } }
    services {
      edges {
        node {
          id
          deployments(first: 1) { edges { node { id environmentId } } }
        }
      }
    }
  }
}`

interface ProjectLookup {
  data?: {
    project?: {
      environments?: { edges: { node: { id: string; name: string } }[] }
      services?: { edges: { node: { id: string; deployments?: { edges: { node: { id: string; environmentId?: string } }[] } } }[] }
    }
  }
}

async function resolveLatestDeployment(token: string, projectId: string, envName: string): Promise<LatestDeployment | null> {
  const json = (await railwayGql(token, LATEST_DEPLOYMENT_QUERY, { id: projectId })) as ProjectLookup
  const project = json.data?.project
  if (!project) return null
  const env = project.environments?.edges.find((e) => e.node.name.toLowerCase() === envName.toLowerCase())
  if (!env) return null
  for (const svc of project.services?.edges ?? []) {
    const dep = svc.node.deployments?.edges?.[0]?.node
    if (dep && dep.environmentId === env.node.id) {
      return { deploymentId: dep.id, serviceId: svc.node.id, environmentId: env.node.id }
    }
  }
  return null
}

export async function railwayRestart(envName: string): Promise<ActionResult> {
  const token = process.env.RAILWAY_API_TOKEN
  if (!token) return { ok: false, message: 'RAILWAY_API_TOKEN is not set — cannot restart from here.' }
  const projectId = process.env.RAILWAY_PROJECT_ID || DEFAULT_PROJECT_ID
  try {
    const dep = await resolveLatestDeployment(token, projectId, envName)
    if (!dep) return { ok: false, message: `No active deployment found for "${envName}".` }
    const res = await railwayGql(token, `mutation($id: String!) { deploymentRestart(id: $id) }`, { id: dep.deploymentId })
    if (res.errors?.length) return { ok: false, message: `Railway: ${res.errors[0].message}` }
    return { ok: true, message: `Restart triggered for ${envName} (deployment ${dep.deploymentId.slice(0, 8)}).` }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'restart failed' }
  }
}

export async function railwayRedeploy(envName: string): Promise<ActionResult> {
  const token = process.env.RAILWAY_API_TOKEN
  if (!token) return { ok: false, message: 'RAILWAY_API_TOKEN is not set — cannot redeploy from here.' }
  const projectId = process.env.RAILWAY_PROJECT_ID || DEFAULT_PROJECT_ID
  try {
    const dep = await resolveLatestDeployment(token, projectId, envName)
    if (!dep) return { ok: false, message: `No active deployment found for "${envName}".` }
    const res = await railwayGql(
      token,
      `mutation($id: String!) { deploymentRedeploy(id: $id) { id status } }`,
      { id: dep.deploymentId }
    )
    if (res.errors?.length) return { ok: false, message: `Railway: ${res.errors[0].message}` }
    return { ok: true, message: `Redeploy triggered for ${envName} (deployment ${dep.deploymentId.slice(0, 8)}).` }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'redeploy failed' }
  }
}

export async function rerunCI(branch: string): Promise<ActionResult> {
  const token = process.env.GITHUB_TOKEN
  const repo = process.env.GITHUB_REPO || DEFAULT_REPO
  if (!token) return { ok: false, message: 'GITHUB_TOKEN (with actions:write) is required to re-run CI.' }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'mixbase-infra',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  try {
    const runsRes = await fetch(`https://api.github.com/repos/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=1`, {
      headers,
      cache: 'no-store',
    })
    if (!runsRes.ok) return { ok: false, message: `GitHub: could not list runs (${runsRes.status}).` }
    const runsJson = (await runsRes.json()) as { workflow_runs?: { id: number }[] }
    const runId = runsJson.workflow_runs?.[0]?.id
    if (!runId) return { ok: false, message: `No workflow run found for branch "${branch}".` }
    const rerun = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${runId}/rerun`, { method: 'POST', headers })
    if (!rerun.ok && rerun.status !== 201) return { ok: false, message: `GitHub: re-run failed (${rerun.status}).` }
    return { ok: true, message: `Re-running CI for "${branch}" (run ${runId}).` }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 're-run failed' }
  }
}
