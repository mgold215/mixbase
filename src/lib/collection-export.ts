// Pure, dependency-free builder that turns a collection (album / EP / playlist)
// and its ordered tracks into a Markdown tracklist the musician can paste into
// release notes, a distributor submission, or a message to a collaborator.
// Mirrors the punch-list / release-plan exports so all of mixBASE's exports
// read as a matching set. Pure (no runtime deps, no Date/clipboard) so it can
// be unit-tested and reused server-side later.

// User-facing labels for the `mb_collections.type` column. This is the single
// source of truth for these labels — CollectionClient imports it to render the
// type pill AND buildCollectionExport() uses it for the heading, so the in-app
// badge and the exported document can never drift apart.
export const COLLECTION_TYPE_LABEL: Record<string, string> = {
  album: 'Album',
  ep: 'EP',
  playlist: 'Playlist',
}

// Minimal shapes so the builder stays pure/testable and decoupled from the
// Supabase row types. A track only needs its title and (optional) genre.
export type CollectionMeta = { title: string; type: string }
export type CollectionTrack = { title: string | null; genre?: string | null }

// One numbered tracklist line: "1. Midnight Drive" / "2. Sunrise (House)".
// Genre is appended in parens only when present, matching the release-plan
// hint style. Falls back to "Untitled" for a missing/blank title.
function trackLine(track: CollectionTrack, index: number): string {
  const title = track.title?.trim() || 'Untitled'
  const genre = track.genre?.trim()
  return `${index + 1}. ${title}${genre ? ` (${genre})` : ''}`
}

/**
 * Turn a collection into a Markdown tracklist. One heading (title — type), a
 * single context line (the track count, matching the count shown in the UI),
 * then the numbered tracks in their saved order. Degrades to a clear
 * "_No tracks yet._" line for an empty collection rather than an empty section.
 */
export function buildCollectionExport(
  collection: CollectionMeta,
  tracks: CollectionTrack[],
): string {
  const typeLabel = COLLECTION_TYPE_LABEL[collection.type] ?? collection.type
  const count = `${tracks.length} ${tracks.length === 1 ? 'track' : 'tracks'}`

  const out: string[] = [`# ${collection.title} — ${typeLabel}`, '', count, '']
  if (tracks.length) {
    out.push(...tracks.map(trackLine))
  } else {
    out.push('_No tracks yet._')
  }
  return out.join('\n').trimEnd() + '\n'
}
