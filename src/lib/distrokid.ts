import type { Release } from './supabase'
import { ymdUtc, nextFriday, toYmd } from './release-plan'

// ─── DistroKid prep + waterfall sequencing ───────────────────────────────────
// DistroKid has no public API, so this module makes mixBASE the system of
// record instead: it derives the exact tracklist each waterfall drop needs,
// validates a release against DistroKid's actual form requirements, and builds
// a copy-ready submission sheet in the same order as distrokid.com/new. Pure
// and dependency-free (no clock, no Date constructor on user strings) so it
// can be unit-tested and reused server-side.

// One track row on a DistroKid release. In a waterfall run, the release at
// position N carries N tracks: its own new track first, then every earlier
// drop's track re-released under its original ISRC so streams/playlists carry
// over instead of starting from zero.
export type DistroKidTrack = {
  trackNumber: number
  title: string
  versionInfo: string | null
  isrc: string | null
  isNew: boolean // false = re-released from an earlier drop (must reuse its ISRC)
  releaseId: string
}

// All releases in the same waterfall run as `release`, in drop order.
// Falls back to just the release itself when it isn't part of a run.
export function waterfallSiblings(release: Release, all: Release[]): Release[] {
  if (!release.waterfall_group_id) return [release]
  return all
    .filter(r => r.waterfall_group_id === release.waterfall_group_id)
    .sort((a, b) => (a.waterfall_position ?? 0) - (b.waterfall_position ?? 0))
}

/**
 * The tracklist DistroKid should be given for this release. For a standalone
 * release that's one track; for waterfall drop N it's the new track plus every
 * earlier drop's track (newest first — the standard waterfall track order).
 */
export function distroKidTracklist(release: Release, all: Release[]): DistroKidTrack[] {
  const pos = release.waterfall_position ?? 1
  const included = waterfallSiblings(release, all)
    .filter(r => (r.waterfall_position ?? 1) <= pos)
    .sort((a, b) => (b.waterfall_position ?? 0) - (a.waterfall_position ?? 0)) // newest first
  return included.map((r, i) => ({
    trackNumber: i + 1,
    title: r.title,
    versionInfo: r.version_info,
    isrc: r.isrc,
    isNew: r.id === release.id,
    releaseId: r.id,
  }))
}

// A readiness problem found by validateForDistroKid. Errors block a clean
// submission; warnings are strong conventions (Friday drops, pitch lead time).
export type DistroKidIssue = { level: 'error' | 'warn'; message: string }

// Facts the pure validator can't derive from the release row alone — the
// caller looks these up (linked version, project artwork) and passes them in.
export type DistroKidContext = {
  hasFinalVersion: boolean
  hasArtwork: boolean
  tracklist: DistroKidTrack[]
  todayStr: string // YYYY-MM-DD, injected so this stays pure
}

/**
 * Everything that would stall or sabotage the DistroKid submission, checked
 * against what their upload form actually requires (artist, legal songwriter
 * names, audio, artwork) plus the waterfall gotchas (re-released tracks must
 * reuse their original ISRCs) and release-strategy conventions (Friday drops,
 * ~2 weeks of playlist-pitch lead time).
 */
export function validateForDistroKid(release: Release, ctx: DistroKidContext): DistroKidIssue[] {
  const issues: DistroKidIssue[] = []
  const err = (message: string) => issues.push({ level: 'error', message })
  const warn = (message: string) => issues.push({ level: 'warn', message })

  if (!release.artist_name?.trim()) err('Artist name is missing — DistroKid needs it exactly as it appears on your Spotify/Apple Music profile.')
  if (!release.songwriters?.trim()) err('Songwriter legal names are missing — DistroKid requires real first + last names, not artist names.')
  if (!ctx.hasFinalVersion) err('No final mix version is linked — link the version you\'ll upload so the right file ships.')
  if (!ctx.hasArtwork) err('No artwork on the linked project — DistroKid needs 3000×3000 JPG/PNG with no social handles or URLs.')
  if (!release.mastering_done) warn('Mastering isn\'t checked off — upload the final master, not the mix.')
  if (!release.genre?.trim()) warn('No primary genre set.')

  // Re-released waterfall tracks must carry the ISRC from their original drop,
  // or streams/playlist placements restart from zero — the whole point of the
  // waterfall is lost. The new track's ISRC is optional (DistroKid assigns one).
  for (const t of ctx.tracklist) {
    if (!t.isNew && !t.isrc?.trim()) {
      err(`Track ${t.trackNumber} ("${t.title}") is a re-release but has no ISRC — open its original release and add the ISRC DistroKid assigned, or its stream history won't carry over.`)
    }
  }

  const releaseMs = ymdUtc(release.release_date)
  const todayMs = ymdUtc(ctx.todayStr)
  if (releaseMs === null) {
    warn('No release date set.')
  } else if (todayMs !== null) {
    const days = Math.round((releaseMs - todayMs) / 86_400_000)
    if (days < 0) warn('Release date has passed — pick a new date before submitting.')
    else if (days < 10) warn(`Only ${days} day${days === 1 ? '' : 's'} until the drop — Spotify playlist pitching wants ~2+ weeks of lead time.`)
    if (new Date(releaseMs).getUTCDay() !== 5) warn('Release date isn\'t a Friday — DSP playlists and charts refresh on Fridays.')
  }

  return issues
}

// A label/value pair for the click-to-copy grid — one per DistroKid form field,
// in the order the upload form asks for them.
export type DistroKidField = { label: string; value: string }

const RELEASE_TYPE_LABEL: Record<string, string> = { single: 'Single', ep: 'EP', album: 'Album' }

/**
 * The DistroKid upload form's fields with this release's answers, in form
 * order, blanks included (so nothing gets skipped while copy-pasting).
 */
export function distroKidFields(release: Release, tracklist: DistroKidTrack[]): DistroKidField[] {
  const fields: DistroKidField[] = [
    { label: 'Artist name', value: release.artist_name ?? '' },
    { label: 'Release type', value: `${RELEASE_TYPE_LABEL[release.release_type] ?? release.release_type} (${tracklist.length} track${tracklist.length === 1 ? '' : 's'})` },
    { label: 'Release title', value: release.title },
    { label: 'Record label', value: release.label ?? '' },
    { label: 'Release date', value: release.release_date ?? '' },
    { label: 'Primary genre', value: release.genre ?? '' },
    { label: 'Secondary genre', value: release.secondary_genre ?? '' },
    { label: 'Language', value: release.language || 'English' },
    { label: 'UPC', value: release.upc?.trim() || 'Leave blank — DistroKid assigns one free' },
  ]
  for (const t of tracklist) {
    const suffix = tracklist.length === 1 ? '' : ` (track ${t.trackNumber})`
    fields.push({ label: `Title${suffix}`, value: t.versionInfo ? `${t.title} (${t.versionInfo})` : t.title })
    fields.push({
      label: `ISRC${suffix}`,
      value: t.isrc?.trim() || (t.isNew ? 'Leave blank — DistroKid assigns one free' : ''),
    })
  }
  fields.push(
    { label: 'Songwriters (legal names)', value: release.songwriters ?? '' },
    { label: 'Producers', value: release.producers ?? '' },
    { label: 'Featured artists', value: release.featured_artists ?? '' },
    { label: 'Explicit lyrics', value: release.explicit ? 'Yes' : 'No' },
    { label: 'Instrumental', value: release.instrumental ? 'Yes' : 'No' },
  )
  return fields
}

/**
 * The whole submission as one Markdown sheet — field answers in form order,
 * the tracklist with reuse-ISRC flags, outstanding issues, and the waterfall
 * rules that make or break stream carry-over. Mirrors the release-plan /
 * punch-list exports so all of mixBASE's exports read as a matching set.
 */
export function buildDistroKidSheet(
  release: Release,
  tracklist: DistroKidTrack[],
  issues: DistroKidIssue[],
  projectTitle?: string | null,
): string {
  const out: string[] = [`# ${release.title} — DistroKid submission sheet`, '']
  const ctx: string[] = []
  if (release.artist_name) ctx.push(release.artist_name)
  if (projectTitle) ctx.push(projectTitle)
  if (release.waterfall_position && release.waterfall_group_id) ctx.push(`Waterfall drop #${release.waterfall_position}`)
  ctx.push('Upload at https://distrokid.com/new/')
  out.push(ctx.join(' · '), '')

  out.push('## Form answers (in upload order)')
  for (const f of distroKidFields(release, tracklist)) out.push(`- **${f.label}:** ${f.value || '—'}`)
  out.push('')

  if (tracklist.length > 1) {
    out.push('## Tracklist')
    for (const t of tracklist) {
      const tag = t.isNew ? 'NEW' : `re-release — reuse ISRC ${t.isrc?.trim() || '(missing!)'}`
      out.push(`${t.trackNumber}. ${t.title}${t.versionInfo ? ` (${t.versionInfo})` : ''} — ${tag}`)
    }
    out.push('')
    out.push('## Waterfall rules')
    out.push('- Re-released tracks: identical audio file, identical title/version, and the original ISRC — that\'s what carries streams and playlist placements over.')
    out.push('- Leave UPC blank on every drop (each release gets a fresh one).')
    out.push('- After DistroKid assigns the new track\'s ISRC, paste it back into this release in mixBASE so the next drop can reuse it.')
    out.push('')
  }

  if (issues.length) {
    out.push('## Outstanding before you submit')
    for (const i of issues) out.push(`- [ ] ${i.level === 'error' ? '⛔' : '⚠️'} ${i.message}`)
    out.push('')
  }

  const notes = release.notes?.trim()
  if (notes) out.push('## Notes', notes, '')

  return out.join('\n').trimEnd() + '\n'
}

/**
 * Friday-anchored drop dates for a waterfall run: the first on/after
 * `startYmd`, then one every `cadenceDays`, each snapped forward to a Friday.
 * Returns [] on a malformed start date. Pure — no clock.
 */
export function waterfallDates(startYmd: string, count: number, cadenceDays: number): string[] {
  const start = ymdUtc(startYmd)
  if (start === null || count < 1) return []
  const first = nextFriday(start)
  return Array.from({ length: count }, (_, i) => toYmd(nextFriday(first + i * cadenceDays * 86_400_000)))
}

// DistroKid types releases by track count; waterfall drop N carries N tracks.
export function releaseTypeForTrackCount(count: number): 'single' | 'ep' | 'album' {
  if (count <= 3) return 'single'
  if (count <= 6) return 'ep'
  return 'album'
}
