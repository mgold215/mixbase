// src/lib/feed.ts
// Community feed — recent uploads across ALL users, with inter-artist comments.
// Server-side only (supabaseAdmin). Shared by the /feed page and GET /api/feed.

import { supabaseAdmin } from './supabase'
import { ensureFeedCommentsTable, isMissingFeedCommentsTable, ensureUgcModerationTables, isMissingUgcModerationTable } from './schema-heal'
import { publicArtistName } from './display-name'
import { versionDisplayLabel } from './mix-status'

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

// Public display name for a profile. Never falls back to display_name when it
// looks like an email — signup defaults display_name to the address, and the
// feed is visible to every user. Lives in its own dependency-free module so a
// bare node contract test can import it; re-exported here for existing callers.
export { publicArtistName }

/** Unwrap a PostgREST embedded relation that may come back as object or array. */
export function unwrapJoin<T>(v: T | T[] | null | undefined): T | null {
  if (v == null) return null
  return Array.isArray(v) ? (v[0] ?? null) : v
}

// Explicit projection — never select('*'). These rows are serialized into the
// owner's project page; the commenter's profiles row must never be embedded,
// because display_name defaults to the signup EMAIL (see publicArtistName).
const FEED_COMMENT_COLS = 'id, version_id, user_id, comment, created_at'

// Cap on how many of a project's versions we ask about at once. The PostgREST
// filter serializes as ?version_id=in.(uuid,uuid,…) at ~39 bytes per id, so an
// unbounded list on a version-heavy project builds a request line long enough
// to be rejected by the proxy — turning a page that renders today into an
// error. Versions arrive newest-first, so the cap keeps the mixes that matter.
const PROJECT_VERSION_SCAN = 100

/**
 * Feed comments other artists left on a specific project's versions.
 *
 * TOTAL: never throws and never rejects. Unlike getFeed() (which throws and is
 * caught by the /feed page), this is awaited inside the project page's render
 * path, where a throw would 500 a page that currently survives its own queries
 * failing. Every failure degrades to "no comments".
 *
 * Callers must pass version ids they have ALREADY established the caller owns —
 * this runs with the service-role client, which bypasses RLS.
 */
export async function getFeedCommentsForVersions(versionIds: string[]): Promise<FeedComment[]> {
  const ids = versionIds.slice(0, PROJECT_VERSION_SCAN)
  if (ids.length === 0) return []

  const fetchComments = () => supabaseAdmin
    .from('mb_feed_comments')
    .select(FEED_COMMENT_COLS)
    .in('version_id', ids)
    .order('created_at', { ascending: false })
    .limit(COMMENTS_LIMIT)

  try {
    let res = await fetchComments()

    // Deploy may have beaten migration 022 — heal the table and retry once,
    // the same pair the feed itself uses.
    if (res.error && isMissingFeedCommentsTable(res.error) && await ensureFeedCommentsTable()) {
      res = await fetchComments()
    }
    if (res.error) {
      console.error('[project] feed comments query failed:', res.error.message)
      return []
    }

    // Query is newest-first for the cap; restore chronological display order.
    const rows = [...(res.data ?? [])].reverse()
    if (rows.length === 0) return []

    // Name top-up. Ignoring the error is deliberate: a profiles failure degrades
    // every name to the neutral fallback, it does not drop the comments.
    const { data: profiles } = await supabaseAdmin
      .from('profiles')
      .select('id, artist_name, display_name')
      .in('id', [...new Set(rows.map(c => c.user_id))])
    const nameById = new Map((profiles ?? []).map(p => [p.id, publicArtistName(p)]))

    return rows.map(c => ({
      id: c.id,
      version_id: c.version_id,
      user_id: c.user_id,
      artist: nameById.get(c.user_id) ?? 'Artist',
      comment: c.comment,
      created_at: c.created_at,
    }))
  } catch (e) {
    console.error('[project] feed comments load threw:', e instanceof Error ? e.message : e)
    return []
  }
}

// Reports needed from distinct users before content is hidden from EVERYONE
// (the reporter stops seeing it immediately). Keep in sync with the same
// constant in /api/feed/report.
const AUTO_HIDE_THRESHOLD = 3

/** Moderation state for one viewer: who they've blocked, what they've
 *  reported, and which content has crossed the global report threshold.
 *  TOTAL: any failure (including the tables not existing yet) degrades to
 *  "no filtering" rather than taking down the feed. */
async function getModerationState(viewerId: string | undefined, versionIds: string[]) {
  const empty = {
    blockedIds: new Set<string>(),
    reportedVersionIds: new Set<string>(),
    reportedCommentIds: new Set<string>(),
    hiddenVersionIds: new Set<string>(),
  }
  try {
    const fetchBoth = () => Promise.all([
      viewerId
        ? supabaseAdmin.from('mb_user_blocks').select('blocked_id').eq('blocker_id', viewerId)
        : Promise.resolve({ data: [], error: null }),
      versionIds.length > 0
        ? supabaseAdmin.from('mb_content_reports').select('content_id, reporter_id').eq('content_type', 'version').in('content_id', versionIds)
        : Promise.resolve({ data: [], error: null }),
      viewerId
        ? supabaseAdmin.from('mb_content_reports').select('content_id').eq('content_type', 'comment').eq('reporter_id', viewerId)
        : Promise.resolve({ data: [], error: null }),
    ])
    let [blocksRes, versionReportsRes, commentReportsRes] = await fetchBoth()
    const firstError = blocksRes.error ?? versionReportsRes.error ?? commentReportsRes.error
    if (firstError && isMissingUgcModerationTable(firstError) && await ensureUgcModerationTables()) {
      ;[blocksRes, versionReportsRes, commentReportsRes] = await fetchBoth()
    }
    if (blocksRes.error || versionReportsRes.error || commentReportsRes.error) {
      console.error('[feed] moderation queries failed:',
        (blocksRes.error ?? versionReportsRes.error ?? commentReportsRes.error)?.message)
      return empty
    }

    const reportersByVersion = new Map<string, Set<string>>()
    const reportedVersionIds = new Set<string>()
    for (const r of versionReportsRes.data ?? []) {
      const set = reportersByVersion.get(r.content_id) ?? new Set<string>()
      set.add(r.reporter_id)
      reportersByVersion.set(r.content_id, set)
      if (viewerId && r.reporter_id === viewerId) reportedVersionIds.add(r.content_id)
    }
    const hiddenVersionIds = new Set<string>()
    for (const [id, reporters] of reportersByVersion) {
      if (reporters.size >= AUTO_HIDE_THRESHOLD) hiddenVersionIds.add(id)
    }
    return {
      blockedIds: new Set((blocksRes.data ?? []).map(b => b.blocked_id)),
      reportedVersionIds,
      reportedCommentIds: new Set((commentReportsRes.data ?? []).map(r => r.content_id)),
      hiddenVersionIds,
    }
  } catch (e) {
    console.error('[feed] moderation state load threw:', e instanceof Error ? e.message : e)
    return empty
  }
}

export async function getFeed(viewerId?: string): Promise<FeedItem[]> {
  const { data: versions, error } = await supabaseAdmin
    .from('mb_versions')
    .select('id, project_id, label, version_number, audio_filename, status, audio_url, created_at, mb_projects!inner(title, artwork_url, finalized_artwork_url, user_id)')
    .not('audio_url', 'is', null)
    // Ownerless projects (residue of the fixed iOS null-owner insert bug) must
    // not reach a cross-user feed: their user_id serializes as "", which strict
    // clients reject as a UUID — one such row blanked the entire iOS feed —
    // and an entry with no author can't be blocked or reported (Guideline 1.2).
    .not('mb_projects.user_id', 'is', null)
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
    getModerationState(viewerId, versionIds),
  ])
  let commentsRes = results[0]
  const profilesRes = results[1]
  const moderation = results[2]

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
    // UGC moderation (Guideline 1.2): hide comments from users this viewer
    // blocked and comments this viewer reported. (Comments past the global
    // report threshold are hard-deleted by /api/feed/report, so they don't
    // reach this query at all.)
    if (moderation.blockedIds.has(c.user_id)) continue
    if (moderation.reportedCommentIds.has(c.id)) continue
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

  return grouped.filter(({ latest: v }) => {
    // UGC moderation (Guideline 1.2): drop feed items from blocked users,
    // items this viewer reported, and items past the global report threshold.
    const ownerId = v.project?.user_id
    if (ownerId && moderation.blockedIds.has(ownerId)) return false
    if (moderation.reportedVersionIds.has(v.id)) return false
    if (moderation.hiddenVersionIds.has(v.id)) return false
    return true
  }).map(({ latest: v, older }) => ({
    version_id: v.id,
    project_id: v.project_id,
    user_id: v.project?.user_id ?? '',
    title: v.project?.title ?? 'Untitled',
    artist: nameById.get(v.project?.user_id ?? '') ?? 'Artist',
    version_label: versionDisplayLabel(v),
    artwork_url: v.project?.finalized_artwork_url ?? v.project?.artwork_url ?? null,
    audio_url: v.audio_url,
    created_at: v.created_at,
    comments: commentsByVersion.get(v.id) ?? [],
    older: older.map(o => ({
      version_id: o.id,
      version_label: versionDisplayLabel(o),
      audio_url: o.audio_url,
      created_at: o.created_at,
    })),
  }))
}
