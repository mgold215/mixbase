// ─── Release-day ISRC lookup: the pure rules ────────────────────────────────
// Owner, 2026-11-18: "It should just go look for the ISRC on the release date"
// and "Daily is excessive". So nothing is synced on a timer for its own sake:
// a pipeline release with no ISRC is looked up ON its release day, retried a
// couple of times over the next week in case Deezer lists it late, then left
// alone. A release that came out while nothing was looking (the backlog this
// was built for: BLINKERS, REGARDLESS) is looked up once, the first time the
// check runs after it.
//
// There is no per-release "last looked" column. The user's library already
// records it: every library sync stamps updated_at on each row it matches, so
// the newest updated_at in mb_library_tracks is when that user's catalog was
// last read. That makes the schedule survive deploys without a migration.
//
// Everything here is pure (no clock, no I/O) so scripts/release-isrc-test.mjs
// can pin the schedule down. The job that applies it is release-isrc-job.ts.

/** Days after the release date to look again if the ISRC still isn't in. */
export const RETRY_DAYS: readonly number[] = [2, 7]

/**
 * How far back a release that was never looked up still gets its one lookup.
 * Bounds the backlog, and bounds how long a release whose catalog lookup keeps
 * failing outright can keep asking.
 */
export const BACKFILL_MAX_AGE_DAYS = 120

/** A library sync newer than this counts as "just done" (the other process). */
export const FRESH_SYNC_MS = 6 * 60 * 60 * 1000

/** Hour (US Eastern) from which the day's check runs. Releases drop at midnight. */
export const CHECK_HOUR_ET = 9

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** YYYY-MM-DD and hour for an instant, in US Eastern (the owner's release clock). */
export function easternParts(at: Date): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(at)
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? ''
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) }
}

/** Whole days from date `from` to date `to` (both YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

function blank(v: string | null | undefined): boolean {
  return v == null || v.trim() === ''
}

/**
 * Should this release's ISRC be looked up today?
 *
 * @param releaseDate  the pipeline row's release_date (YYYY-MM-DD)
 * @param isrc         the row's current ISRC
 * @param today        today's date in US Eastern
 * @param lastSyncDate the Eastern date of the user's last library sync, or null
 */
export function isReleaseDue(
  releaseDate: string | null,
  isrc: string | null,
  today: string,
  lastSyncDate: string | null,
): boolean {
  if (!blank(isrc)) return false
  if (!releaseDate || !ISO_DATE.test(releaseDate)) return false
  const age = daysBetween(releaseDate, today)
  if (age < 0 || age > BACKFILL_MAX_AGE_DAYS) return false
  // Nothing has read the catalog since it came out: release day itself, or
  // a backlog release from before this check existed.
  if (lastSyncDate == null || lastSyncDate < releaseDate) return true
  // Looked once already and still missing: try again on the retry days only.
  return RETRY_DAYS.includes(age) && lastSyncDate < today
}

/** Title key for matching a pipeline release to a library track. */
export function titleKey(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

export type LibraryCode = { title: string; isrc: string | null; upc: string | null; release_date: string | null }

/**
 * The ISRC (and, when it is the same drop, the UPC) for a pipeline release,
 * from the user's library. A song on several releases (single, then the EP)
 * keeps one ISRC, so any match gives the right ISRC; the UPC belongs to one
 * release, so it is only taken from a library row with the same release date.
 */
export function matchLibraryCodes(
  release: { title: string; release_date: string | null },
  library: LibraryCode[],
): { isrc: string; upc: string | null } | null {
  const key = titleKey(release.title)
  if (!key) return null
  const hits = library.filter(t => !blank(t.isrc) && titleKey(t.title) === key)
  if (!hits.length) return null
  const sameDay = hits.find(t => release.release_date && t.release_date === release.release_date)
  const pick = sameDay
    ?? [...hits].sort((a, b) => (a.release_date ?? '9999').localeCompare(b.release_date ?? '9999'))[0]
  return {
    isrc: (pick.isrc as string).trim(),
    upc: sameDay && !blank(sameDay.upc) ? (sameDay.upc as string).trim() : null,
  }
}
