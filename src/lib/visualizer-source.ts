// Which picture a visualizer animates, and whether a pinned loop was made from
// the project's FINISHED cover.
//
// A project carries two images: artwork_url (the clean source) and
// finalized_artwork_url (the finished cover — Finalize Artwork's title
// lettering, or a Cassette Studio cover with handwriting and/or a look). Until
// 2026-10-19 every generator animated the clean source, so pinning a loop made
// the player show a different picture from the cover everywhere else ("wrong
// album art"). Both clients now animate the finished cover by default, with the
// clean artwork one tap away.
//
// A loop made from the finished cover usually already shows the title, so the
// finished-video renderer's own title flash would print it twice:
// GET /api/finalize-video suggests "No text" for those, and both clients start
// from that suggestion.
//
// Pure (no imports) so the unit suite can load it directly.

const ARTWORK_MARKER = '/storage/v1/object/public/mf-artwork/'

/** True when `url` is one of this project's finished covers (mf-artwork <projectId>/finalized-….jpg). */
export function isFinishedCoverUrl(url: string | null | undefined, projectId: string): boolean {
  if (!url || !projectId) return false
  const idx = url.indexOf(ARTWORK_MARKER)
  if (idx === -1) return false
  const key = url.slice(idx + ARTWORK_MARKER.length).split(/[?#]/)[0]
  return key.startsWith(`${projectId.toLowerCase()}/finalized-`)
}

export type FinishedVideoFormat = 'youtube' | 'shorts'

/**
 * The pinned loop a finished video renders from: the pin in its own orientation
 * (horizontal for the full-length 16:9, vertical for the Short), else the other
 * pin, which the renderer cover-crops.
 */
export function pinForFormat(format: FinishedVideoFormat, vertical: string | null, wide: string | null): string | null {
  return format === 'youtube' ? (wide ?? vertical) : (vertical ?? wide)
}
