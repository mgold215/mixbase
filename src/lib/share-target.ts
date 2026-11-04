import { supabaseAdmin } from '@/lib/supabase'

// Share tokens as bearer capabilities — the one resolver behind every PUBLIC,
// token-scoped route:
//   POST /api/share/<token>/duration   (the listener's measured length)
//   GET  /api/share/<token>/peaks      (the waveform)
//   POST /api/feedback                 (a note or reaction from an album page)
//
// A share token is already a capability: whoever holds it can stream the mix
// and read its public projection. These routes let the holder act on exactly
// that mix and nothing wider, so what a token resolves to must be decided in
// ONE place, mirroring what the public players actually serve:
//   1. PROJECT-level  (mb_projects.share_token)    → /listen/…/<token>, latest mix
//   2. VERSION-level  (mb_versions.share_token)    → legacy /share/<token> links
//   3. COLLECTION     (mb_collections.share_token) → /album/<artist>/<title>/<token>
// Form 3 names many tracks, so the caller must say which project — and that
// claim is checked against the collection's own item list before it means
// anything. A project id can only ever NARROW what a token exposes.

// Every share token in production is 32 lowercase hex characters
// (`replace(gen_random_uuid()::text, '-', '')`). This check is deliberately
// looser than that exact shape — hard-coding it would silently stop every
// route the day the generator changes, and the value is a parameterised query
// argument either way. The point is only to keep obvious junk out of the
// database round trips.
export const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/

/** The version a token exposes, plus the project it belongs to. */
export type ShareTarget = { versionId: string; projectId: string }

/** Newest mix of a project — the one, and only one, that the public players
 *  load. src/lib/track-share.ts and src/lib/album-share.ts both resolve
 *  "latest" exactly this way; mirroring it is what keeps these routes from
 *  granting a version the token does not expose. */
export async function latestVersionOf(projectId: string): Promise<ShareTarget | null> {
  const { data } = await supabaseAdmin
    .from('mb_versions')
    .select('id, project_id')
    .eq('project_id', projectId)
    .order('version_number', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data ? { versionId: data.id as string, projectId: data.project_id as string } : null
}

/**
 * Resolve a share token to the single version it authorises an action on.
 * `wantProjectId` is required for a collection token and ignored otherwise.
 * Null for an unknown token, a malformed one, or a project the token does not
 * cover — callers treat all of those the same way.
 */
export async function resolveShareTarget(token: string, wantProjectId: string | null): Promise<ShareTarget | null> {
  if (!SHARE_TOKEN_RE.test(token)) return null

  // 1. Project-level token.
  const { data: project } = await supabaseAdmin
    .from('mb_projects')
    .select('id')
    .eq('share_token', token)
    .maybeSingle()
  if (project) return latestVersionOf(project.id as string)

  // 2. Legacy version-level token — the token IS the row.
  const { data: version } = await supabaseAdmin
    .from('mb_versions')
    .select('id, project_id')
    .eq('share_token', token)
    .maybeSingle()
  if (version) return { versionId: version.id as string, projectId: version.project_id as string }

  // 3. Collection/album token. An error here (e.g. a deploy that raced
  // migration 019 and has no share_token column yet) is treated as "no match":
  // these routes are advisory, so they decline rather than reaching for a
  // schema self-heal from an unauthenticated path.
  const { data: collection } = await supabaseAdmin
    .from('mb_collections')
    .select('id')
    .eq('share_token', token)
    .maybeSingle()
  if (!collection) return null
  if (!wantProjectId) return null

  // The album token authorises exactly the collection's own tracks — never an
  // arbitrary project id the caller attached to a valid token.
  const { data: item } = await supabaseAdmin
    .from('mb_collection_items')
    .select('project_id')
    .eq('collection_id', collection.id as string)
    .eq('project_id', wantProjectId)
    .maybeSingle()
  if (!item) return null

  return latestVersionOf(wantProjectId)
}
