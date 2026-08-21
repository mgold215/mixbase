import { keyProjectId } from './project-assets.ts'

// Artwork History — every artwork image a project has ever had, and which one
// is live right now.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// mf-artwork holds 288 objects in production; 84 are referenced by a live row.
// The other 204 are not junk — they are 94 generation drafts the user scrolled
// past and 99 finalized covers a later Finalize superseded. Every one of them
// was produced BY a user, FOR a project, and the moment it was superseded the
// app stopped being able to name it. 39 of the 54 projects that have any
// artwork at all (72%) have at least one image in that state, median 4 each.
//
// ── THE MISTAKE THIS MODULE IS SHAPED TO AVOID ──────────────────────────────
// On 2026-08-14 this codebase called 10 mf-video objects "orphans". They were a
// user's lost renders, and the misclassification cost an App Store submission.
// The words "unreferenced" and "junk" got treated as synonyms.
//
// So this module never computes "junk". It computes "everything under this
// project's prefix, and which of them the project currently points at". A
// history item carries `current: true` instead of being filtered out, and
// NOTHING here can produce a delete list. The reference set that would be
// needed to safely say "nothing wants this" is precisely the thing that is hard
// to get exhaustively right (see ASSET_URL_COLUMNS in project-assets.ts) — so
// the feature is designed not to need it. Restoring never deletes the image it
// replaces; that image simply becomes another history entry.

/**
 * What produced an artwork object, read from its key.
 *
 * The three shapes are minted in three different places and mean different
 * things to the restore path, which is the only reason this is a union rather
 * than a display string:
 *   'generated' — `<projectId>/ai-<ts>.{jpg,webp,png}`, written by
 *                 /api/generate-artwork. A raw model output, no text lockup.
 *   'finalized' — `<projectId>/finalized-<ts>.jpg`, written by
 *                 /api/finalize-artwork. Source artwork + the artist/title
 *                 lockup burned in. This is a RENDER OF a 'generated' or
 *                 'upload' image, not a replacement for it.
 *   'upload'    — anything else under the prefix (`cover.jpg`, `<ts>.jpeg`),
 *                 an image the user supplied themselves.
 */
export type ArtworkKind = 'generated' | 'finalized' | 'upload'

export type ArtworkHistoryItem = {
  /** Storage key inside mf-artwork, e.g. `<projectId>/ai-1787250068415.jpg`. */
  path: string
  /** Public URL — mf-artwork is a public-read bucket. */
  url: string
  kind: ArtworkKind
  /** ISO-8601 from storage.objects, or null when the listing did not carry one. */
  createdAt: string | null
  /** Bytes, or null when the listing did not carry a size. */
  size: number | null
  /** True when the project points at this exact object right now. */
  current: boolean
}

/**
 * Classify a key by the filename the app minted, NOT by extension.
 *
 * Deliberately anchored to the segment after the last '/' so a project id that
 * happened to start with "ai-" could never shift the classification of every
 * object beneath it. (Project ids are UUIDs so that is unreachable today; the
 * anchor costs nothing and removes the class of bug entirely.)
 */
export function classifyArtworkKey(key: string): ArtworkKind {
  const leaf = key.slice(key.lastIndexOf('/') + 1)
  if (leaf.startsWith('finalized-')) return 'finalized'
  if (leaf.startsWith('ai-')) return 'generated'
  return 'upload'
}

/**
 * May this key be restored onto this project?
 *
 * The ONLY question asked is whether the key attributes itself to this exact
 * project, via the same keyProjectId() that the delete paths trust for the
 * mirror-image decision. That makes the restore endpoint strictly narrower than
 * the PATCH it shortcuts: PATCH /api/projects/[id] accepts any
 * isSupabaseStorageUrl() value, which validates protocol and hostname only and
 * therefore admits another user's object (see filterToOwnedPrefixes' docstring
 * — that hole is already known and compensated for elsewhere). Restore cannot
 * admit one, because a foreign object's first path segment is a different
 * project id and this returns false.
 *
 * Case: keyProjectId lowercases, and Postgres spells project ids lowercase, so
 * the comparison is done on the normalised pair rather than on raw input.
 */
export function isRestorableArtworkKey(key: unknown, projectId: string): key is string {
  if (typeof key !== 'string' || key.length === 0) return false
  const attributed = keyProjectId(key)
  return attributed !== null && attributed === projectId.toLowerCase()
}

/**
 * Newest first, with a total order.
 *
 * created_at is the primary key of the sort because it is what the user
 * experienced ("the one I made after lunch"). It can be null — Supabase's list
 * has returned null created_at for objects written by older client versions —
 * and a null must not silently sort as "oldest" next to a real timestamp, so
 * nulls go last as a group and then order by key, which for `ai-<ts>` and
 * `finalized-<ts>` is itself chronological.
 *
 * The name tie-break is what makes this a TOTAL order: two objects written in
 * the same millisecond (the finalize path can write several in one burst — four
 * `finalized-*` objects landed within 28 seconds on 2026-08-07) would otherwise
 * have an implementation-defined order, and the strip would reshuffle between
 * loads for no reason the user can see.
 */
export function compareArtworkItems(a: ArtworkHistoryItem, b: ArtworkHistoryItem): number {
  if (a.createdAt !== b.createdAt) {
    if (a.createdAt === null) return 1
    if (b.createdAt === null) return -1
    if (a.createdAt > b.createdAt) return -1
    if (a.createdAt < b.createdAt) return 1
  }
  return a.path < b.path ? 1 : a.path > b.path ? -1 : 0
}

export type ArtworkListEntry = {
  path: string
  createdAt?: string | null
  size?: number | null
}

/**
 * Turn a prefix listing into the history payload.
 *
 * `currentPaths` are the keys the project's own columns resolve to right now —
 * artwork_url and finalized_artwork_url. They are FLAGGED, never dropped: a
 * strip that hid the live cover would make "which one am I looking at?"
 * unanswerable, and dropping is also the exact shape of the 08-14 mistake.
 */
export function buildArtworkHistory(
  entries: readonly ArtworkListEntry[],
  publicUrl: (path: string) => string,
  currentPaths: readonly (string | null)[],
): ArtworkHistoryItem[] {
  const current = new Set(currentPaths.filter((p): p is string => typeof p === 'string' && p.length > 0))
  return entries
    .map(entry => ({
      path: entry.path,
      url: publicUrl(entry.path),
      kind: classifyArtworkKey(entry.path),
      createdAt: entry.createdAt ?? null,
      size: entry.size ?? null,
      current: current.has(entry.path),
    }))
    .sort(compareArtworkItems)
}

/**
 * The column write that restoring `kind` means.
 *
 * This is the whole semantic core of the restore, so it is a pure function with
 * a test rather than three lines inside a route handler.
 *
 * A 'finalized' object IS the finished cover — it already has the lockup burned
 * in — so restoring one sets finalized_artwork_url and leaves artwork_url
 * alone. The source image that the render was made FROM is still the right
 * source for the next Finalize, and clobbering it would lose the pairing.
 *
 * A 'generated' or 'upload' object is a SOURCE. Pointing artwork_url at it
 * while leaving a finalized render made from a different source in place would
 * leave the project displaying (displayArtworkUrl prefers finalized) an image
 * that no longer has anything to do with its artwork. PATCH /api/projects/[id]
 * already nulls finalized_artwork_url for exactly this reason
 * (src/app/api/projects/[id]/route.ts:83) and this mirrors it deliberately —
 * two code paths that set artwork_url must agree on the invariant, or the
 * project page shows one image and every listing shows another.
 *
 * Nulling finalized_artwork_url costs the user nothing now that this feature
 * exists: the superseded render stays in the bucket and reappears in the strip
 * one line below. Before this feature, that null was a one-way door.
 */
export function artworkRestorePatch(kind: ArtworkKind, url: string): Record<string, string | null> {
  if (kind === 'finalized') return { finalized_artwork_url: url }
  return { artwork_url: url, finalized_artwork_url: null }
}
