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
