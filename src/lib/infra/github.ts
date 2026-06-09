// GitHub Actions status for the infra control panel.
//
// The repo is public, so the GitHub REST API works WITHOUT a token (rate-limited
// to 60/hr/IP). GITHUB_TOKEN (optional) raises the limit. Never throws.

const DEFAULT_REPO = 'mgold215/mixbase'

export interface GithubRun {
  branch: string
  status: string | null // queued | in_progress | completed
  conclusion: string | null // success | failure | cancelled | null
  title: string
  url: string
  createdAt: string | null
}

export interface GithubStatus {
  configured: boolean
  authenticated: boolean
  repo: string
  runs: GithubRun[]
  error?: string
}

interface GhRunsResponse {
  workflow_runs?: {
    head_branch?: string
    status?: string
    conclusion?: string
    display_title?: string
    html_url?: string
    created_at?: string
  }[]
}

export async function getGithubStatus(): Promise<GithubStatus> {
  const repo = process.env.GITHUB_REPO || DEFAULT_REPO
  const token = process.env.GITHUB_TOKEN
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'mixbase-infra',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (token) headers.Authorization = `Bearer ${token}`

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/runs?per_page=20`, {
      headers,
      cache: 'no-store',
      signal: controller.signal,
    })
    clearTimeout(timeout)
    if (!res.ok) {
      return { configured: true, authenticated: Boolean(token), repo, runs: [], error: `GitHub API ${res.status}` }
    }
    const json = (await res.json()) as GhRunsResponse
    // Keep the latest run for the branches we care about (main, tst).
    const seen = new Set<string>()
    const runs: GithubRun[] = []
    for (const r of json.workflow_runs ?? []) {
      const branch = r.head_branch ?? ''
      if ((branch === 'main' || branch === 'tst') && !seen.has(branch)) {
        seen.add(branch)
        runs.push({
          branch,
          status: r.status ?? null,
          conclusion: r.conclusion ?? null,
          title: (r.display_title ?? '').slice(0, 80),
          url: r.html_url ?? '',
          createdAt: r.created_at ?? null,
        })
      }
    }
    return { configured: true, authenticated: Boolean(token), repo, runs }
  } catch (e) {
    return {
      configured: true,
      authenticated: Boolean(token),
      repo,
      runs: [],
      error: e instanceof Error ? e.message : 'github query failed',
    }
  }
}
