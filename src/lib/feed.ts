// src/lib/feed.ts
// Community feed — recent uploads across ALL users, with inter-artist comments.
// Server-side only (supabaseAdmin). Shared by the /feed page and GET /api/feed.

import { supabaseAdmin } from './supabase'
import { ensureFeedCommentsTable, isMissingFeedCommentsTable } from './schema-heal'

export type FeedComment = {
  id: string
  version_id: string
  user_id: string
  artist: string
  comment: string
  created_at: string
}

/** An earlier mix of a feed item's project — playable from the
 *  "listen to older mixes" browser. */
export type OlderMix = {
  version_id: string
  version_label: string
  audio_url: string
  created_at: string
}

export type FeedItem = {
  version_id: string
  project_id: string
  user_id: string
  title: string
  artist: string
  version_label: string
  artwork_url: string | null
  audio_url: string
  created_at: string
  comments: FeedComment[]
  /** Previous mixes of this project, newest first */
  older: OlderMix[]
}

const FEED_LIMIT = 60
// How many recent version rows to pull before grouping by project. The feed
// shows one entry per project (its newest mix); the rest of a project's
// versions inside this window become its "older mixes" browser.
const RAW_VERSION_FETCH = 200
// Older mixes shown per project — bounds the payload for version-heavy projects
const OLDER_LIMIT = 15
// Hard cap on comment rows fetched per feed load. Without an explicit limit
// PostgREST silently truncates at its own default — and with ascending order
// that would drop the NEWEST comments. Fetch newest-first with a stated cap,
// then restore chronological order in code, so growth drops oldest instead.
const COMMENTS_LIMIT = 2000

// Public display name for a profile. Never fall back to display_name when it
// looks like an email — signup defaults display_name to the address, and the
// feed is visible to every user.
export function publicArtistName(p?: { artist_name?: string | null; display_name?: string | null } | null): string {
  if (p?.artist_name?.trim()) return p.artist_name.trim()
  const dn = p?.display_name?.trim()
  if (dn && !dn.includes('@')) return dn
  return 'Artist'
}

/** Unwrap a PostgREST embedded relation that may come back as object or array. */
export function unwrapJoin<T>(v: T | T[] | null | undefined): T | null {
  if (v == null) return null
  return Array.isArray(v) ? (v[0] ?? null) : v
}

export async function getFeed(): Promise<FeedItem[]> {
  const { data: versions, error } = await supabaseAdmin
    .from('mb_versions')
    .select('id, project_id, label, version_number, audio_url, created_at, mb_projects!inner(title, artwork_url, finalized_artwork_url, user_id)')
    .not('audio_url', 'is', null)
    .order('created_at', { ascending: false })
    .limit(RAW_VERSION_FETCH)
  if (error) throw new Error(error.message)

  type ProjectJoin = { title?: string; artwork_url?: string | null; finalized_artwork_url?: string | null; user_id?: string }
  const rows = (versions ?? []).map(v => ({
    ...v,
    project: unwrapJoin(v.mb_projects) as ProjectJoin | null,
  }))

  // Group by project, preserving newest-first order: the first row seen for a
  // project is its live mix (the feed entry); later rows are its older mixes.
  // Re-uploading a mix bumps the project to the top instead of stacking
  // near-duplicate entries down the feed.
  type Row = (typeof rows)[number]
  const grouped: { latest: Row; older: Row[] }[] = []
  const idxByProject = new Map<string, number>()
  for (const v of rows) {
    const idx = idxByProject.get(v.project_id)
    if (idx === undefined) {
      if (grouped.length >= FEED_LIMIT) continue
      idxByProject.set(v.project_id, grouped.length)
      grouped.push({ latest: v, older: [] })
    } else if (grouped[idx].older.length < OLDER_LIMIT) {
      grouped[idx].older.push(v)
    }
  }

  const versionIds = grouped.map(g => g.latest.id)
  const uploaderIds = [...new Set(grouped.map(g => g.latest.project?.user_id).filter((id): id is string => !!id))]

  // Comments and uploader profiles are independent — fetch them concurrently.
  const fetchComments = () => versionIds.length > 0
    ? supabaseAdmin
        .from('mb_feed_comments')
        .select('id, version_id, user_id, comment, created_at')
        .in('version_id', versionIds)
        .order('created_at', { ascending: false })
        .limit(COMMENTS_LIMIT)
    : Promise.resolve({ data: [], error: null })

  const results = await Promise.all([
    fetchComments(),
    uploaderIds.length > 0
      ? supabaseAdmin.from('profiles').select('id, artist_name, display_name').in('id', uploaderIds)
      : Promise.resolve({ data: [] as { id: string; artist_name: string | null; display_name: string | null }[], error: null }),
  ])
  let commentsRes = results[0]
  const profilesRes = results[1]

  // Deploy may have beaten migration 022 — heal the table and retry once.
  // A comments failure must never take down the whole feed either way.
  if (commentsRes.error) {
    if (isMissingFeedCommentsTable(commentsRes.error) && await ensureFeedCommentsTable()) {
      commentsRes = await fetchComments()
    }
    if (commentsRes.error) {
      console.error('[feed] comments query failed:', commentsRes.error.message)
      commentsRes = { data: [], error: null }
    }
  }
  // Restore chronological display order (query is newest-first for the cap)
  const commentRows = [...(commentsRes.data ?? [])].reverse()

  // Top-up: commenter profiles not already fetched as uploaders
  const nameById = new Map((profilesRes.data ?? []).map(p => [p.id, publicArtistName(p)]))
  const missingIds = [...new Set(commentRows.map(c => c.user_id))].filter(id => !nameById.has(id))
  if (missingIds.length > 0) {
    const { data: extra } = await supabaseAdmin
      .from('profiles')
      .select('id, artist_name, display_name')
      .in('id', missingIds)
    for (const p of extra ?? []) nameById.set(p.id, publicArtistName(p))
  }

  const commentsByVersion = new Map<string, FeedComment[]>()
  for (const c of commentRows) {
    const list = commentsByVersion.get(c.version_id) ?? []
    list.push({
      id: c.id,
      version_id: c.version_id,
      user_id: c.user_id,
      artist: nameById.get(c.user_id) ?? 'Artist',
      comment: c.comment,
      created_at: c.created_at,
    })
    commentsByVersion.set(c.version_id, list)
  }

  return grouped.map(({ latest: v, older }) => ({
    version_id: v.id,
    project_id: v.project_id,
    user_id: v.project?.user_id ?? '',
    title: v.project?.title ?? 'Untitled',
    artist: nameById.get(v.project?.user_id ?? '') ?? 'Artist',
    version_label: v.label || `v${v.version_number}`,
    artwork_url: v.project?.finalized_artwork_url ?? v.project?.artwork_url ?? null,
    audio_url: v.audio_url,
    created_at: v.created_at,
    comments: commentsByVersion.get(v.id) ?? [],
    older: older.map(o => ({
      version_id: o.id,
      version_label: o.label || `v${o.version_number}`,
      audio_url: o.audio_url,
      created_at: o.created_at,
    })),
  }))
}
