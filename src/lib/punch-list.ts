import type { Feedback } from './supabase'

// Format a second-offset as m:ss. Unlike formatDuration() in supabase.ts this
// renders 0 as "0:00" (a comment can legitimately be pinned at the very start)
// and never returns the "--:--" placeholder.
function clock(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

// Build one Markdown checklist line for a single feedback item. Shape:
//   - [ ] 1:30 — Alex · ★4 — vocal sits too loud
// The timestamp prefix is omitted for un-pinned notes, the rating is omitted
// when unrated, and the comment is omitted when blank.
function line(f: Feedback): string {
  const parts: string[] = []
  if (f.timestamp_seconds != null) parts.push(clock(f.timestamp_seconds))
  const who = f.rating != null ? `${f.reviewer_name} · ★${f.rating}` : f.reviewer_name
  parts.push(who)
  const comment = f.comment?.trim()
  if (comment) parts.push(comment)
  return `- [ ] ${parts.join(' — ')}`
}

/**
 * Turn a version's listener feedback into a Markdown "punch list" a musician can
 * paste straight into their DAW notes, a doc, or a message. Timestamped notes
 * come first, ordered by their moment in the track (earliest first), so the list
 * reads as an ordered pass through the mix; un-pinned general notes follow,
 * oldest first. Every line is a `- [ ]` checkbox so it renders as a real
 * checklist in Markdown-aware tools (GitHub, Notion, Obsidian, …).
 *
 * Pure and dependency-free so it can be unit-tested and reused server-side.
 */
export function buildPunchList(heading: string, feedback: Feedback[]): string {
  const timestamped = feedback
    .filter(f => f.timestamp_seconds != null)
    .sort((a, b) => a.timestamp_seconds! - b.timestamp_seconds!)
  const general = feedback
    .filter(f => f.timestamp_seconds == null)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))

  const rated = feedback.filter(f => f.rating != null)
  const avg = rated.length
    ? (rated.reduce((s, f) => s + f.rating!, 0) / rated.length).toFixed(1)
    : null

  const out: string[] = [`# ${heading} — feedback punch list`, '']
  const count = `${feedback.length} note${feedback.length === 1 ? '' : 's'}`
  out.push(avg ? `${count} · avg ★ ${avg}` : count, '')

  if (timestamped.length) {
    out.push('## Timestamped', ...timestamped.map(line), '')
  }
  if (general.length) {
    out.push('## General', ...general.map(line), '')
  }

  return out.join('\n').trimEnd() + '\n'
}
