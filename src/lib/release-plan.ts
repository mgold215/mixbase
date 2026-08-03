import type { Release } from './supabase'

// A single checklist row: the boolean column on mb_releases it tracks, its
// user-facing label, and an optional one-line hint.
export type ChecklistItem = { key: keyof Release; label: string; hint?: string }

// Pre-launch steps — everything that has to be true before the release goes out.
// This is the single source of truth for these labels; PipelineClient renders
// them and buildReleasePlan() exports them, so the in-app checklist and the
// exported plan never drift apart.
export const PRE_LAUNCH_ITEMS: ChecklistItem[] = [
  { key: 'mixing_done', label: 'Mixing done' },
  { key: 'mastering_done', label: 'Mastering done' },
  { key: 'artwork_ready', label: 'Artwork ready' },
  { key: 'press_release_done', label: 'Pre-save link live' },
  { key: 'dsp_submitted', label: 'DistroKid submitted' },
  { key: 'social_posts_done', label: 'Social posts scheduled' },
]

// Post-launch campaign steps. These reuse the dsp_* boolean columns (no
// migration needed) as generic campaign checkboxes with their own labels/hints.
export const LAUNCH_CAMPAIGN_ITEMS: ChecklistItem[] = [
  { key: 'dsp_spotify',     label: 'Brazil Showcase launched', hint: '$100 · launch day' },
  { key: 'dsp_apple_music', label: 'US Showcase launched',     hint: '$100 · launch day' },
  { key: 'dsp_youtube',     label: 'Canvas uploaded to Spotify', hint: '+15% saves' },
  { key: 'dsp_tidal',       label: 'Save rate ≥6%? Add Marquee', hint: '$100 · check T+48h' },
  { key: 'dsp_soundcloud',  label: 'Curator emails sent',      hint: 'email-agents' },
  { key: 'dsp_amazon',      label: 'Meta ad live',             hint: 'Hypeddit · evergreen' },
  { key: 'dsp_bandcamp',    label: 'Release Radar fired?',     hint: 'check T+7' },
]

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Format a YYYY-MM-DD date column as "Jul 10, 2026". Parsed from the string
// parts (not the Date constructor) so it never shifts across timezones and stays
// pure for unit tests. Returns null for a blank/malformed date.
function formatDate(dateStr: string | null): string | null {
  if (!dateStr) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr)
  if (!m) return null
  const month = MONTHS[Number(m[2]) - 1]
  if (!month) return null
  return `${month} ${Number(m[3])}, ${m[1]}`
}

/**
 * Share of the full release checklist (pre-launch + launch campaign) that's
 * ticked off, 0–100. Used both for the in-app progress bar and the exported
 * plan's context line, so the two always report the same number.
 */
export function releaseCompletionPercent(release: Release): number {
  const items = [...PRE_LAUNCH_ITEMS, ...LAUNCH_CAMPAIGN_ITEMS]
  const done = items.filter(c => release[c.key]).length
  return Math.round((done / items.length) * 100)
}

// Parse a YYYY-MM-DD string to a UTC-midnight millisecond value, or null if
// blank/malformed. Date.UTC reads no clock, so this stays pure and testable.
// Exported for reuse by the DistroKid/waterfall helpers in distrokid.ts.
export function ymdUtc(dateStr: string | null): number | null {
  if (!dateStr) return null
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return null
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

/**
 * Format a YYYY-MM-DD release date for display, on the SAME UTC calendar basis
 * the rest of this module computes on.
 *
 * `new Date('2026-08-07').toLocaleDateString('en-US', …)` parses the string as
 * UTC midnight and then renders it in the viewer's local zone — so at any
 * negative UTC offset it prints the PREVIOUS day. Every US user saw a Friday
 * drop date as Thursday, directly contradicting the planner's own "drop dates
 * snap to Fridays" promise. Pinning `timeZone: 'UTC'` makes the rendered day
 * match the stored day for every viewer, everywhere.
 *
 * Returns '' for a blank/malformed date so callers can render it directly.
 */
export function formatReleaseDate(
  dateStr: string | null,
  opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' },
): string {
  const ms = ymdUtc(dateStr)
  if (ms === null) return ''
  return new Date(ms).toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' })
}

// Whole-day difference from `todayStr` to `dateStr` (positive = future), or null
// if either side is blank/malformed. Both parsed on the same UTC calendar basis.
//
// Exported because every "how far away is this release" question in the app must
// be answered on ONE calendar basis. The pipeline board previously differenced a
// UTC-parsed release date against `Date.now()` — a wall-clock instant — so from
// roughly 7pm local onward, every countdown west of UTC read a day short.
export function daysUntilDate(todayStr: string, dateStr: string | null): number | null {
  const a = ymdUtc(todayStr)
  const b = ymdUtc(dateStr)
  if (a === null || b === null) return null
  return Math.round((b - a) / 86_400_000)
}

/**
 * Is this release still ahead of (or exactly on) today?
 *
 * This is the single most load-bearing date predicate on the pipeline board, and
 * it is the one that got the basis wrong. The board used to compare
 * `new Date(release_date)` — which parses `'2026-08-03'` as UTC midnight —
 * against `now.setHours(0,0,0,0)`, which is LOCAL midnight. At any negative UTC
 * offset the release instant is always the smaller number, so a release dated
 * today sorted as PAST: on drop day the card silently left "Upcoming" and was
 * filed into the collapsed, dimmed "Past" group — while its own countdown badge
 * still said "Today" and its status still said "At risk". Three parts of one
 * card disagreeing is the tell that two calendars were in play.
 *
 * Undated releases count as upcoming: they're plans that haven't been scheduled
 * yet, not history.
 */
export function isUpcomingRelease(todayStr: string, dateStr: string | null): boolean {
  if (!dateStr) return true
  const days = daysUntilDate(todayStr, dateStr)
  // A malformed date can't be judged as past — keep it visible rather than
  // hiding it in a collapsed group where the user would never find it.
  return days === null || days >= 0
}

/**
 * Chronological comparator for two release dates on the shared UTC basis.
 * `undatedLast` puts blank dates at the end (upcoming: plans without a date sit
 * below scheduled ones); flip it for the past list, which is sorted newest-first.
 */
export function compareReleaseDates(
  a: string | null,
  b: string | null,
  { undatedLast = true } = {},
): number {
  const av = ymdUtc(a)
  const bv = ymdUtc(b)
  if (av === null && bv === null) return 0
  if (av === null) return undatedLast ? 1 : -1
  if (bv === null) return undatedLast ? -1 : 1
  return av - bv
}

// At-a-glance health of a release relative to its target date. Returns null when
// there's nothing actionable to flag, so the board only shows a badge when it
// carries signal (avoids badge-on-everything noise).
export type ReleaseStatusKey = 'ready' | 'at-risk' | 'due-soon'
export type ReleaseStatus = { key: ReleaseStatusKey; label: string }

/**
 * Decide whether a release needs attention, given today's date as a
 * `YYYY-MM-DD` string (injected so this stays pure and unit-testable — the
 * caller passes the real local date).
 *
 * Only the PRE_LAUNCH checklist counts toward "ready" — those are the steps
 * that must be true before a track can go out; the launch-campaign items are
 * post-release promo and don't gate readiness.
 *
 *   - pre-launch complete (and not already shipped) → "Ready"
 *   - date is today or past + pre-launch incomplete → "At risk"  (the drop date
 *     arrived and the track isn't ready — the one state that always needs action)
 *   - within the next 7 days + pre-launch incomplete → "Due soon"
 *   - everything else (comfortably future, undated, or already-shipped) → null
 *     (the countdown + progress bar already tell that story)
 */
export function getReleaseStatus(release: Release, todayStr: string): ReleaseStatus | null {
  const days = daysUntilDate(todayStr, release.release_date)
  const preLaunchDone = PRE_LAUNCH_ITEMS.every(i => release[i.key])

  // Everything needed to ship is done — only worth a badge if it hasn't gone out
  // yet (a past, completed release is just "Released", which the countdown owns).
  if (preLaunchDone) return days !== null && days < 0 ? null : { key: 'ready', label: 'Ready' }

  // Incomplete from here. Undated releases can't be assessed on timing.
  if (days === null) return null
  if (days <= 0) return { key: 'at-risk', label: 'At risk' } // drop date here/passed, not ready
  if (days <= 7) return { key: 'due-soon', label: 'Due soon' }
  return null
}

// A quick-pick release date: the label shown on the chip, the YYYY-MM-DD value it
// writes, and a friendly "Jul 10, 2026" rendering for the tooltip.
export type DatePreset = { label: string; date: string; friendly: string }

// Advance a UTC-midnight ms value to the next Friday on or after it. Friday is
// weekday 5 (Sun = 0). Pure — operates only on the passed ms, reads no clock.
export function nextFriday(ms: number): number {
  const add = (5 - new Date(ms).getUTCDay() + 7) % 7 // 0 when already a Friday
  return ms + add * 86_400_000
}

// Render a UTC-midnight ms value back to the YYYY-MM-DD column format.
export function toYmd(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

/**
 * Friday-anchored quick-pick release dates, given today as a YYYY-MM-DD string
 * (injected so this stays pure and unit-testable). Music releases conventionally
 * drop on a Friday and DSP playlist pitching wants a few weeks' lead, so every
 * option lands on a Friday — the label says how far out, and `friendly` shows the
 * resolved calendar date so the choice is never ambiguous. Returns [] on a
 * malformed today string.
 */
export function releaseDatePresets(todayStr: string): DatePreset[] {
  const today = ymdUtc(todayStr)
  if (today === null) return []
  const thisFri = nextFriday(today)
  return [
    { label: 'This Friday', off: 0 },
    { label: 'Next Friday', off: 7 },
    { label: 'In 2 weeks', off: 14 },
    { label: 'In 4 weeks', off: 28 },
    { label: 'In 6 weeks', off: 42 },
  ].map(({ label, off }) => {
    const date = toYmd(thisFri + off * 86_400_000)
    return { label, date, friendly: formatDate(date) ?? date }
  })
}

// One Markdown checklist line: "- [x] Mixing done" / "- [ ] Meta ad live (Hypeddit · evergreen)".
function line(release: Release, item: ChecklistItem): string {
  const box = release[item.key] ? 'x' : ' '
  const hint = item.hint ? ` (${item.hint})` : ''
  return `- [${box}] ${item.label}${hint}`
}

/**
 * Turn a release into a Markdown "release plan" the musician can paste into a
 * doc, a message to a collaborator, or a distributor checklist. One heading, a
 * single context line (date · project · genre · label · ISRC · NN% complete),
 * then the Pre-Launch and Launch Campaign checklists with each box reflecting
 * its saved state, and the notes at the end. Mirrors the punch-list / mix-report
 * exports so all of mixBASE's exports read as a matching set.
 *
 * Pure and dependency-free (parses the date string itself, no Date constructor)
 * so it can be unit-tested and reused server-side.
 */
export function buildReleasePlan(release: Release, projectTitle?: string | null): string {
  const ctx: string[] = []
  const date = formatDate(release.release_date)
  ctx.push(date ? `Releases ${date}` : 'No release date set')
  if (projectTitle) ctx.push(projectTitle)
  if (release.genre) ctx.push(release.genre)
  if (release.label) ctx.push(release.label)
  if (release.isrc) ctx.push(`ISRC ${release.isrc}`)
  ctx.push(`${releaseCompletionPercent(release)}% complete`)

  const out: string[] = [`# ${release.title} — release plan`, '', ctx.join(' · '), '']
  out.push('## Pre-Launch', ...PRE_LAUNCH_ITEMS.map(i => line(release, i)), '')
  out.push('## Launch Campaign', ...LAUNCH_CAMPAIGN_ITEMS.map(i => line(release, i)), '')

  const notes = release.notes?.trim()
  if (notes) out.push('## Notes', notes, '')

  return out.join('\n').trimEnd() + '\n'
}
