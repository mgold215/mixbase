import { cache } from 'react'
import { supabaseAdmin, displayArtworkUrl } from '@/lib/supabase'
import { publicArtistName } from '@/lib/display-name'
import { listStudio, isOwnStudioKey } from '@/lib/cassette-server'

// The single-track public share page's data, shared by its two addresses —
//   mixbase.app/listen/<artist>/<title>/<token>   (canonical, what gets copied)
//   mixbase.app/share/<token>                     (every link ever sent; redirects)
// — and by the two token-scoped public routes that decorate it:
//   GET /api/share/<token>/card   the 1200×630 link-preview image
//   GET /api/share/<token>/peaks  the waveform
//
// This is a PUBLIC projection: everything selected here is serialized into the
// payload sent to anonymous viewers (props flow Server Component → ShareClient
// → browser). So we select ONLY the columns the page actually renders — never
// `*`. In particular this keeps mb_versions.private_notes (the artist's own
// notes) and every mb_feedback row (owner-read-only per RLS: another reviewer's
// name, rating, comment) out of the payload. share-projection-test.mjs locks this.
//
// allow_download is the artist's per-mix opt-in for letting share recipients
// save the original upload (the full-quality WAV). It gates the download button
// in ShareClient — a boolean flag, not owner-private content.
export const VERSION_PUBLIC_COLS = 'id, audio_url, label, version_number, status, public_notes, allow_download'
// visualizer_url is the 9:16 Canvas loop (full-screen backdrop on a phone),
// visualizer_wide_url the 16:9 one (the backdrop on a laptop/desktop).
export const PROJECT_PUBLIC_COLS = 'id, user_id, title, artwork_url, finalized_artwork_url, visualizer_url, visualizer_wide_url'

export type ShareProject = {
  id: string
  user_id: string | null
  title: string | null
  artwork_url: string | null
  finalized_artwork_url: string | null
  visualizer_url: string | null
  visualizer_wide_url: string | null
}

export type ShareVersion = {
  id: string
  audio_url: string
  label: string | null
  version_number: number
  status: string | null
  public_notes: string | null
  allow_download: boolean
  mb_projects: ShareProject
}

export type TrackShareData = {
  version: ShareVersion
  artistName: string
  /** The song's title in the artist's OWN handwriting (Cassette Studio
   *  lettering, white ink on transparency) — only the platform owner has one. */
  letteringUrl: string | null
}

async function artistNameFor(userId: string | null | undefined): Promise<string> {
  if (!userId) return 'mixBASE'
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('artist_name, display_name')
    .eq('id', userId)
    .single()
  return profile ? publicArtistName(profile, 'mixBASE') : 'mixBASE'
}

// ── Handwritten title ────────────────────────────────────────────────────────
// Cassette Studio keeps one lettering PNG per song at
// studio/<userId>/lettering-<projectId>-<ts>.png (ink lifted off the owner's
// own photo — never a font). Only the platform owner has a studio folder, so
// for everyone else the listing is empty and the page falls back to type.
// Negative answers are remembered briefly so an anonymous page view is not a
// Storage listing every time.
const letteringCache = new Map<string, { url: string | null; at: number }>()
const LETTERING_TTL_MS = 5 * 60 * 1000

export async function newestLetteringUrl(userId: string | null | undefined, projectId: string): Promise<string | null> {
  if (!userId) return null
  const key = `${userId}/${projectId}`
  const hit = letteringCache.get(key)
  if (hit && Date.now() - hit.at < LETTERING_TTL_MS) return hit.url
  let url: string | null = null
  try {
    const files = (await listStudio(userId, `lettering-${projectId}-`))
      .filter(f => isOwnStudioKey(f.path, userId, 'lettering') && f.path.includes(`/lettering-${projectId}-`))
    url = files[0]?.url ?? null
  } catch {
    url = null
  }
  letteringCache.set(key, { url, at: Date.now() })
  return url
}

// Wrapped in React cache() so generateMetadata and the page component (both
// called in the same request) share ONE execution instead of running the full
// project → version → profile query set twice per share-page view.
export const getTrackShareData = cache(async (token: string): Promise<TrackShareData | null> => {
  // ── 1. Project-level share token (always resolves to the latest mix) ──
  const { data: project } = await supabaseAdmin
    .from('mb_projects')
    .select(PROJECT_PUBLIC_COLS)
    .eq('share_token', token)
    .single()

  if (project) {
    const { data: latestVersion } = await supabaseAdmin
      .from('mb_versions')
      .select(VERSION_PUBLIC_COLS)
      .eq('project_id', project.id)
      .order('version_number', { ascending: false })
      .limit(1)
      .single()

    if (!latestVersion) return null

    const proj = project as unknown as ShareProject
    const version = { ...latestVersion, mb_projects: proj } as ShareVersion
    const [artistName, letteringUrl] = await Promise.all([
      artistNameFor(proj.user_id),
      newestLetteringUrl(proj.user_id, proj.id),
    ])
    return { version, artistName, letteringUrl }
  }

  // ── 2. Legacy: version-level share token (old links keep working) ──
  const { data: version } = await supabaseAdmin
    .from('mb_versions')
    .select(`${VERSION_PUBLIC_COLS}, mb_projects(${PROJECT_PUBLIC_COLS})`)
    .eq('share_token', token)
    .single()

  if (!version) return null

  // supabase-js types a to-one embed as an array; at runtime it's the object.
  const legacyProject = version.mb_projects as unknown as ShareProject | null
  const [artistName, letteringUrl] = await Promise.all([
    artistNameFor(legacyProject?.user_id),
    legacyProject ? newestLetteringUrl(legacyProject.user_id, legacyProject.id) : Promise.resolve(null),
  ])
  return { version: version as unknown as ShareVersion, artistName, letteringUrl }
})

/** The cover the page and the link card show: the finalized artwork when
 *  there is one, else the plain artwork. */
export function shareCoverUrl(data: TrackShareData): string | null {
  return displayArtworkUrl(data.version.mb_projects ?? {})
}

export function shareTitle(data: TrackShareData): string {
  return data.version.mb_projects?.title ?? 'Untitled'
}

// A short fingerprint of what the link card is drawn from. It rides on the
// card URL as ?v=… so a changed cover or title busts every previewer's cache
// while an unchanged card stays cacheable for a long time.
export function shareCardStamp(data: TrackShareData): string {
  const input = `${shareCoverUrl(data) ?? ''}|${shareTitle(data)}|${data.artistName}|${data.version.id}`
  let h = 5381
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) >>> 0
  return h.toString(36)
}
