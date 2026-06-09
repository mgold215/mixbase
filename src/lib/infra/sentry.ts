// Sentry error-monitoring status for the infra control panel.
//
// Needs SENTRY_AUTH_TOKEN (an auth token with project:read). Org/project default
// to the known values and are env-overridable. Without the token the node
// reports configured:false. Never throws.

const DEFAULT_ORG = 'moodmixformat'
const DEFAULT_PROJECT = 'mixbase'

export interface SentryIssue {
  title: string
  culprit: string | null
  count: string
  lastSeen: string | null
  permalink: string | null
}

export interface SentryStatus {
  configured: boolean // SENTRY_AUTH_TOKEN present
  org: string
  project: string
  shownIssues: number | null // count of latest unresolved issues returned (sample)
  recentIssues: SentryIssue[] | null
  error?: string
}

interface SentryIssueResponse {
  title?: string
  culprit?: string
  count?: string | number
  lastSeen?: string
  permalink?: string
}

export async function getSentryStatus(): Promise<SentryStatus> {
  const token = process.env.SENTRY_AUTH_TOKEN
  const org = process.env.SENTRY_ORG || DEFAULT_ORG
  const project = process.env.SENTRY_PROJECT || DEFAULT_PROJECT

  if (!token) {
    return { configured: false, org, project, shownIssues: null, recentIssues: null }
  }
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)
    const url = `https://sentry.io/api/0/projects/${org}/${project}/issues/?query=is:unresolved&statsPeriod=14d&limit=10`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: controller.signal,
    })
    clearTimeout(timeout)
    if (!res.ok) {
      return { configured: true, org, project, shownIssues: null, recentIssues: null, error: `Sentry API ${res.status}` }
    }
    const json = (await res.json()) as SentryIssueResponse[]
    const recentIssues: SentryIssue[] = (Array.isArray(json) ? json : []).map((i) => ({
      title: i.title ?? '(untitled)',
      culprit: i.culprit ?? null,
      count: String(i.count ?? '0'),
      lastSeen: i.lastSeen ?? null,
      permalink: i.permalink ?? null,
    }))
    return { configured: true, org, project, shownIssues: recentIssues.length, recentIssues }
  } catch (e) {
    return {
      configured: true,
      org,
      project,
      shownIssues: null,
      recentIssues: null,
      error: e instanceof Error ? e.message : 'sentry query failed',
    }
  }
}
