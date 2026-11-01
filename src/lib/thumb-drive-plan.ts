// THUMB DRIVE — the pure half. Every account has one built-in playlist that
// holds all of its songs, each playing its newest mix, so an artist can send
// someone everything with a single share link. The database half lives in
// src/lib/thumb-drive.ts; this file has NO imports so the test suite
// (scripts/thumb-drive-test.mjs) can load the real rules via Node type-stripping.

/** The playlist's fixed name — shown in every client and in its share URL. */
export const THUMB_DRIVE_TITLE = 'THUMB DRIVE'

/** One line that tells the artist what this playlist does. Shared by the web pages. */
export const THUMB_DRIVE_BLURB =
  'Every song you upload lands here automatically and always plays its newest mix. Share it to send someone all your songs.'

/** True only for a row the server marked as the account's THUMB DRIVE. */
export function isThumbDrive(row: { is_thumb_drive?: unknown } | null | undefined): boolean {
  return row?.is_thumb_drive === true
}

/**
 * The order a brand-new THUMB DRIVE is filled in: newest song first, and only
 * songs that have at least one uploaded mix (a song with no audio has nothing
 * to play — it joins when its first mix lands). Ties break on id so the result
 * is the same on every run. Index in the returned array = the item's position.
 */
export function thumbDriveFillOrder(
  songs: ReadonlyArray<{ id: string; created_at: string | null; mixCount: number }>,
): string[] {
  const time = (iso: string | null) => {
    const t = iso ? Date.parse(iso) : NaN
    return Number.isFinite(t) ? t : -Infinity
  }
  return songs
    .filter(p => p.mixCount > 0)
    .sort((a, b) => time(b.created_at) - time(a.created_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(p => p.id)
}

/**
 * Position for a newly uploaded song: the top of the list, i.e. one above the
 * current first item (positions sort ascending; negatives are fine). An empty
 * playlist starts at 0.
 */
export function positionForNewSong(topPosition: number | null | undefined): number {
  return typeof topPosition === 'number' && Number.isFinite(topPosition) ? topPosition - 1 : 0
}

/** Collections list order: THUMB DRIVE pinned first, everything else as given. */
export function pinThumbDriveFirst<T extends { is_thumb_drive?: unknown }>(rows: ReadonlyArray<T>): T[] {
  return [...rows.filter(r => isThumbDrive(r)), ...rows.filter(r => !isThumbDrive(r))]
}

/**
 * Fields of a THUMB DRIVE that can't be changed. The name is the feature, and
 * "album"/"EP" make no sense for an auto-filled list of every song. Cover art
 * stays editable.
 */
export const THUMB_DRIVE_LOCKED_FIELDS = ['title', 'type'] as const
