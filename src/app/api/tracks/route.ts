import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { ensureProjectVisualizerColumn, isMissingVisualizerColumn } from '@/lib/schema-heal'
import { normalizeStatus } from '@/lib/mix-status'

export type Track = {
  id: string
  project_id: string
  share_token: string | null
  title: string
  artist: string
  artwork_url: string | null
  /** Project visualizer video (Spotify-Canvas style) — loops in the player while the track plays */
  visualizer_url: string | null
  audio_url: string
  /** Stored length of this mix, or null on a row that has never been measured
   *  (~40% of the catalog). Carried so the engine can tell a healed row from an
   *  unhealed one — without it the mini player and /player can see every
   *  project but heal none of them. See the backfill notes in PlayerContext. */
  duration_seconds: number | null
  status: string
  version: string
  uploaded_at: number
  key_signature: string | null
  bpm: number | null
}

// Track which users we've already backfilled this process. Must be PER-USER:
// a single module-level boolean would let the first caller after a deploy mark
// the backfill "done" for everyone, so every other user's legacy projects keep
// share_token:null and their share links stay broken until the next restart.
const _backfilled = new Set<string>()
// Share links must resolve to the *latest* mix, so they point at the project
// (mb_projects.share_token), not a single version. Backfill any project that
// predates project-level tokens so every track has a shareable link.
async function ensureShareTokens(userId: string) {
  if (_backfilled.has(userId)) return
  try {
    const { data } = await supabaseAdmin
      .from('mb_projects')
      .select('id')
      .is('share_token', null)
      .eq('user_id', userId)
      .limit(200)
    if (!data?.length) { _backfilled.add(userId); return }
    await Promise.all(
      data.map(p =>
        supabaseAdmin
          .from('mb_projects')
          .update({ share_token: crypto.randomUUID().replace(/-/g, '') })
          .eq('id', p.id)
      )
    )
    _backfilled.add(userId)
  } catch (e) {
    // Non-fatal — leave this user out of the set so the next request retries the
    // backfill, but surface the failure so it isn't silently swallowed forever.
    console.warn('[tracks] share-token backfill failed:', e)
  }
}

export async function GET(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  await ensureShareTokens(userId)

  const selectVersions = (withVisualizer: boolean) => supabaseAdmin
    .from('mb_versions')
    .select(`id, project_id, label, version_number, audio_url, duration_seconds, status, created_at, mb_projects!inner(title, artwork_url, finalized_artwork_url, ${withVisualizer ? 'visualizer_url, ' : ''}key_signature, bpm, user_id, share_token)`)
    .eq('mb_projects.user_id', userId)
    .order('version_number', { ascending: false })

  const [initialVersionsResult, profileResult] = await Promise.all([
    selectVersions(true),
    supabaseAdmin
      .from('profiles')
      .select('artist_name')
      .eq('id', userId)
      .single(),
  ])
  let versionsResult = initialVersionsResult

  // Deploys can beat the 015 migration to production, and PostgREST rejects the
  // whole select when one column is missing — never let that take down the
  // player. Heal the column and retry; if healing isn't possible, serve tracks
  // without visualizers.
  if (versionsResult.error && isMissingVisualizerColumn(versionsResult.error)) {
    const healed = await ensureProjectVisualizerColumn()
    versionsResult = await selectVersions(healed)
  }

  if (versionsResult.error) return NextResponse.json({ error: versionsResult.error.message }, { status: 500 })

  const artistName: string = profileResult.data?.artist_name || 'mixBase'

  const seen = new Set<string>()
  const latest = (versionsResult.data ?? []).filter((v) => {
    if (seen.has(v.project_id)) return false
    seen.add(v.project_id)
    return true
  })

  const tracks: Track[] = latest.map((v) => {
    const project = Array.isArray(v.mb_projects) ? v.mb_projects[0] : v.mb_projects
    const p = project as { title?: string; artwork_url?: string | null; finalized_artwork_url?: string | null; visualizer_url?: string | null; key_signature?: string | null; bpm?: number | null; share_token?: string | null }
    const projectTitle: string = p?.title ?? 'Unknown'
    return {
      id: v.id,
      project_id: v.project_id,
      // Project-level token — the share page resolves it to the latest mix.
      share_token: p?.share_token ?? null,
      title: projectTitle,
      artist: artistName,
      artwork_url: p?.finalized_artwork_url ?? p?.artwork_url ?? null,
      visualizer_url: p?.visualizer_url ?? null,
      audio_url: v.audio_url,
      // `?? null` so an absent column (a deploy that beats a migration) reads as
      // "not measured" rather than undefined — the engine tests this with
      // `== null` and must never mistake either for a real length.
      duration_seconds: v.duration_seconds ?? null,
      // Folded, not defaulted. `?? 'Mix'` only covers NULL; already-shipped iOS
      // builds still POST the retired 'WIP' straight to PostgREST, so a retired
      // value can re-enter the catalog after migration 034 and reach the engine
      // unfolded. normalizeStatus is the same fold the write paths apply.
      status: normalizeStatus(v.status),
      version: v.label || `v${v.version_number}`,
      uploaded_at: Math.floor(new Date(v.created_at).getTime() / 1000),
      key_signature: p?.key_signature ?? null,
      bpm: p?.bpm ?? null,
    }
  })

  return NextResponse.json(tracks)
}
