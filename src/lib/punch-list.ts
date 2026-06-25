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

// One context line summarizing the feedback set — "4 notes · avg ★ 4.5", or just
// the count when nothing is rated. Shared by both exports so they read as a set.
function contextLine(feedback: Feedback[]): string {
  const rated = feedback.filter(f => f.rating != null)
  const avg = rated.length
    ? (rated.reduce((s, f) => s + f.rating!, 0) / rated.length).toFixed(1)
    : null
  const count = `${feedback.length} note${feedback.length === 1 ? '' : 's'}`
  return avg ? `${count} · avg ★ ${avg}` : count
}

// Build the checklist body — a "## Timestamped" block (notes pinned to a moment,
// earliest first) followed by a "## General" block (un-pinned notes, oldest
// first). Returns the Markdown lines with no document heading/context, so both
// the standalone punch list and the combined mix report can drop it in.
function punchSections(feedback: Feedback[]): string[] {
  const timestamped = feedback
    .filter(f => f.timestamp_seconds != null)
    .sort((a, b) => a.timestamp_seconds! - b.timestamp_seconds!)
  const general = feedback
    .filter(f => f.timestamp_seconds == null)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))

  const out: string[] = []
  if (timestamped.length) {
    out.push('## Timestamped', ...timestamped.map(line), '')
  }
  if (general.length) {
    out.push('## General', ...general.map(line), '')
  }
  return out
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
  const out: string[] = [`# ${heading} — feedback punch list`, '', contextLine(feedback), '', ...punchSections(feedback)]
  return out.join('\n').trimEnd() + '\n'
}

/**
 * Wrap an AI-generated feedback summary as a standalone Markdown document the
 * musician can copy out of the app (so the model's read of the room can travel
 * into a session doc, a message to a collaborator, or release notes). The
 * summary text is already Markdown from the model; we only prepend a heading and
 * the same note-count/avg-rating context line buildPunchList uses, so the two
 * exports read as a matching set. Returns just the heading + context when the
 * summary is blank (e.g. nothing to summarize), never an empty string.
 *
 * Pure and dependency-free so it can be unit-tested and reused server-side.
 */
export function buildSummaryExport(heading: string, summary: string, feedback: Feedback[]): string {
  const out: string[] = [`# ${heading} — AI feedback summary`, '', contextLine(feedback), '', summary.trim()]
  return out.join('\n').trimEnd() + '\n'
}

/**
 * Build one combined "mix report" — the AI summary (the model's read of the
 * room) followed by the full timestamped punch list (the concrete to-dos) — as a
 * single Markdown document. This is what a musician actually wants to carry into
 * a session or hand a collaborator: the narrative and the checklist together,
 * under one heading with one shared context line. The "## AI summary" section is
 * omitted when no summary has been generated, so the report degrades to a plain
 * punch list rather than emitting an empty section.
 *
 * Reuses the same context line and checklist sections as the two single-purpose
 * exports, so all three read as a matching set. Pure and dependency-free.
 */
export function buildMixReport(heading: string, summary: string, feedback: Feedback[]): string {
  const out: string[] = [`# ${heading} — mix report`, '', contextLine(feedback), '']
  const trimmed = summary.trim()
  if (trimmed) {
    out.push('## AI summary', '', trimmed, '')
  }
  out.push(...punchSections(feedback))
  return out.join('\n').trimEnd() + '\n'
}
