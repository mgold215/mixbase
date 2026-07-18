// src/lib/feed.ts
// Community feed — recent uploads across ALL users, with inter-artist comments.
// Server-side only (supabaseAdmin). Shared by the /feed page and GET /api/feed.

import { supabaseAdmin } from './supabase'

export type FeedComment = {
  id: string
  version_id: string
  user_id: string
  artist: string
  comment: string
  created_at: string
}

export type FeedItem = {
  version_id: string
  project_id: string
  user_id: string
  title: string
  artist: string
  version_label: string
  status: string
  artwork_url: string | null
  audio_url: string
  created_at: string
  comments: FeedComment[]
}

const FEED_LIMIT = 60

// Public display name for a profile. Never fall back to display_name when it
// looks like an email — signup defaults display_name to the address, and the
// feed is visible to every user.
export function publicArtistName(p?: { artist_name?: string | null; display_name?: string | null } | null): string {
  if (p?.artist_name?.trim()) return p.artist_name.trim()
  const dn = p?.display_name?.trim()
  if (dn && !dn.includes('@')) return dn
  return 'Artist'
}

export async function getFeed(): Promise<FeedItem[]> {
  const { data: versions, error } = await supabaseAdmin
    .from('mb_versions')
    .select('id, project_id, label, version_number, audio_url, status, created_at, mb_projects!inner(title, artwork_url, finalized_artwork_url, user_id)')
    .not('audio_url', 'is', null)
    .order('created_at', { ascending: false })
    .limit(FEED_LIMIT)
  if (error) throw new Error(error.message)

  type ProjectJoin = { title?: string; artwork_url?: string | null; finalized_artwork_url?: string | null; user_id?: string }
  const rows = (versions ?? []).map(v => ({
    ...v,
    project: (Array.isArray(v.mb_projects) ? v.mb_projects[0] : v.mb_projects) as ProjectJoin | null,
  }))

  const versionIds = rows.map(v => v.id)
  const { data: comments } = versionIds.length > 0
    ? await supabaseAdmin
        .from('mb_feed_comments')
        .select('id, version_id, user_id, comment, created_at')
        .in('version_id', versionIds)
        .order('created_at', { ascending: true })
    : { data: [] }
  const commentRows = comments ?? []

  // One profiles lookup for uploaders + commenters combined
  const userIds = [...new Set([
    ...rows.map(v => v.project?.user_id).filter((id): id is string => !!id),
    ...commentRows.map(c => c.user_id),
  ])]
  const { data: profiles } = userIds.length > 0
    ? await supabaseAdmin.from('profiles').select('id, artist_name, display_name').in('id', userIds)
    : { data: [] }
  const nameById = new Map((profiles ?? []).map(p => [p.id, publicArtistName(p)]))

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

  return rows.map(v => ({
    version_id: v.id,
    project_id: v.project_id,
    user_id: v.project?.user_id ?? '',
    title: v.project?.title ?? 'Untitled',
    artist: nameById.get(v.project?.user_id ?? '') ?? 'Artist',
    version_label: v.label || `v${v.version_number}`,
    status: v.status ?? 'WIP',
    artwork_url: v.project?.finalized_artwork_url ?? v.project?.artwork_url ?? null,
    audio_url: v.audio_url,
    created_at: v.created_at,
    comments: commentsByVersion.get(v.id) ?? [],
  }))
}
