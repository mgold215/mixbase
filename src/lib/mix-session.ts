// Mix Session — the open notes on each song's CURRENT mix, as one worklist.
//
// Notes (mb_feedback: the artist's own mix notes + listener feedback) belong to
// one mix. When a new mix is uploaded it supersedes the old one, so the notes
// that still matter are the ones on each song's latest mix. This module turns
// the raw rows into that worklist, the shareable text version of it, and the
// prompt + schema + validation for the AI session plan.
//
// Pure on purpose: GET /api/mix-session, POST /api/mix-session/plan and the
// unit suite (scripts/mix-session-test.mjs) all use it, and it is the ONE
// definition of "current mix", note order and plan shape for both clients — the
// web page and the native app render what these functions return, they never
// re-derive it. No '@/…' imports (the suite loads it through Node's type
// stripping).

import { versionDisplayLabel } from './mix-status.ts'

export type SessionProjectRow = {
  id: string
  title: string
  artwork_url: string | null
  finalized_artwork_url?: string | null
  visualizer_url?: string | null
  genre?: string | null
  bpm?: number | null
  key_signature?: string | null
}

// The columns GET /api/mix-session selects — enough that the native app can
// decode its own Version model straight from `song.version` and play it.
export type SessionVersionRow = {
  id: string
  project_id: string
  version_number: number
  label: string | null
  audio_url: string
  audio_filename: string | null
  duration_seconds: number | null
  status: string
  allow_download: boolean
  share_token: string | null
  created_at: string
}

export type SessionNoteRow = {
  id: string
  version_id: string
  reviewer_name: string | null
  rating: number | null
  comment: string | null
  timestamp_seconds: number | null
  created_at: string
  resolved_at?: string | null
}

export type SessionNote = {
  id: string
  comment: string
  /** Where in the mix the note was pinned, whole seconds; null = whole-mix note. */
  at_seconds: number | null
  reviewer: string
  /** The artist's own mix note (vs. listener feedback). */
  own: boolean
  rating: number | null
  created_at: string
  done: boolean
  done_at: string | null
}

export type SessionSong = {
  project_id: string
  title: string
  artwork_url: string | null
  visualizer_url: string | null
  /** The current mix: its row, plus the name every screen calls it. */
  version: SessionVersionRow & { display_label: string }
  open_count: number
  done_count: number
  notes: SessionNote[]
}

export type MixSession = {
  songs: SessionSong[]
  open_count: number
  done_count: number
}

/**
 * The current mix of each project: highest version_number, newest upload on a
 * tie. Every later upload supersedes the mixes before it — the same rule as the
 * app's "Play Latest" and the web's version history.
 */
export function currentVersionByProject(versions: SessionVersionRow[]): Map<string, SessionVersionRow> {
  const current = new Map<string, SessionVersionRow>()
  for (const v of versions) {
    const best = current.get(v.project_id)
    if (
      !best ||
      v.version_number > best.version_number ||
      (v.version_number === best.version_number && v.created_at > best.created_at)
    ) {
      current.set(v.project_id, v)
    }
  }
  return current
}

/** Pinned notes in track order first (how you work through a mix), then whole-mix notes, oldest first. */
export function compareNotes(a: SessionNote, b: SessionNote): number {
  if (a.at_seconds != null && b.at_seconds != null && a.at_seconds !== b.at_seconds) return a.at_seconds - b.at_seconds
  if (a.at_seconds != null && b.at_seconds == null) return -1
  if (a.at_seconds == null && b.at_seconds != null) return 1
  return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0
}

/**
 * Build the session. `notes` may include notes on older mixes — only those on
 * each song's current mix are kept. Songs with no notes on their current mix
 * are left out (nothing to do); songs with open notes come first, newest mix
 * first, then songs whose notes are all done.
 */
export function buildMixSession(
  projects: SessionProjectRow[],
  versions: SessionVersionRow[],
  notes: SessionNoteRow[],
  ownAuthor: string,
): MixSession {
  const current = currentVersionByProject(versions)
  const currentIds = new Set([...current.values()].map(v => v.id))
  const byVersion = new Map<string, SessionNote[]>()
  for (const n of notes) {
    if (!currentIds.has(n.version_id)) continue
    const comment = n.comment?.trim()
    if (!comment) continue
    const list = byVersion.get(n.version_id) ?? []
    list.push({
      id: n.id,
      comment,
      at_seconds: n.timestamp_seconds != null && n.timestamp_seconds >= 0 ? Math.floor(n.timestamp_seconds) : null,
      reviewer: n.reviewer_name?.trim() || 'Anonymous',
      own: n.reviewer_name === ownAuthor,
      rating: n.rating ?? null,
      created_at: n.created_at,
      done: !!n.resolved_at,
      done_at: n.resolved_at ?? null,
    })
    byVersion.set(n.version_id, list)
  }

  const songs: SessionSong[] = []
  for (const p of projects) {
    const v = current.get(p.id)
    if (!v) continue
    const list = byVersion.get(v.id)
    if (!list?.length) continue
    list.sort(compareNotes)
    const open = list.filter(n => !n.done).length
    songs.push({
      project_id: p.id,
      title: p.title,
      artwork_url: p.finalized_artwork_url ?? p.artwork_url ?? null,
      visualizer_url: p.visualizer_url ?? null,
      version: { ...v, display_label: versionDisplayLabel(v) },
      open_count: open,
      done_count: list.length - open,
      notes: list,
    })
  }
  songs.sort((a, b) => {
    if ((a.open_count > 0) !== (b.open_count > 0)) return a.open_count > 0 ? -1 : 1
    return a.version.created_at < b.version.created_at ? 1 : a.version.created_at > b.version.created_at ? -1 : 0
  })
  return {
    songs,
    open_count: songs.reduce((n, s) => n + s.open_count, 0),
    done_count: songs.reduce((n, s) => n + s.done_count, 0),
  }
}

/** 83 → "1:23". */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * The session as plain text — the list both clients copy / share (take it into
 * the studio, paste it into the DAW's notes). Open notes only: it is a to-do
 * list.
 */
export function mixSessionText(session: MixSession): string {
  const songs = session.songs.filter(s => s.open_count > 0)
  if (!songs.length) return 'Mix session — no open notes. Nice.'
  const lines = [
    `Mix session — ${session.open_count} open ${session.open_count === 1 ? 'note' : 'notes'} on ${songs.length} ${songs.length === 1 ? 'song' : 'songs'}`,
  ]
  for (const s of songs) {
    lines.push('', `${s.title} — ${s.version.display_label}`)
    for (const n of s.notes) {
      if (n.done) continue
      const at = n.at_seconds != null ? clock(n.at_seconds) : 'whole mix'
      const who = n.own ? '' : ` (${n.reviewer})`
      lines.push(`[ ] ${at.padEnd(9)} ${n.comment.replace(/\s+/g, ' ')}${who}`)
    }
  }
  return lines.join('\n')
}

// ── AI session plan ──────────────────────────────────────────────────────────

// Where in the mix a step's work happens — the plan groups by these, and both
// clients label them from PLAN_AREAS.
export const PLAN_AREAS = [
  { value: 'balance', label: 'Balance' },
  { value: 'low-end', label: 'Low end' },
  { value: 'vocals', label: 'Vocals' },
  { value: 'tone', label: 'Tone / EQ' },
  { value: 'dynamics', label: 'Dynamics' },
  { value: 'space', label: 'Space / FX' },
  { value: 'stereo', label: 'Stereo' },
  { value: 'arrangement', label: 'Arrangement' },
  { value: 'master', label: 'Master' },
  { value: 'other', label: 'Other' },
] as const
export type PlanArea = (typeof PLAN_AREAS)[number]['value']
export const PLAN_PRIORITIES = ['high', 'medium', 'low'] as const
export type PlanPriority = (typeof PLAN_PRIORITIES)[number]
const PRIORITY_LABELS: Record<PlanPriority, string> = { high: 'High', medium: 'Medium', low: 'Low' }

/** Above this many open notes in one request the plan would be too long to be useful — plan fewer songs. */
export const PLAN_MAX_NOTES = 200

export type SessionPlanStep = {
  action: string
  area: PlanArea
  /** Display names, sent so the app labels steps from the server's list rather than a copy. */
  area_label: string
  priority: PlanPriority
  priority_label: string
  note_ids: string[]
  /** Earliest pinned moment among the step's notes — where to start listening. */
  at_seconds: number | null
}

export type SessionPlanSong = {
  project_id: string
  title: string
  version_id: string
  focus: string
  steps: SessionPlanStep[]
  conflicts: string[]
}

export type SessionPlan = { overview: string; songs: SessionPlanSong[] }

/** JSON schema for the model's structured output (output_config.format). */
export const PLAN_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    overview: { type: 'string' },
    songs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          song: { type: 'string' },
          focus: { type: 'string' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                action: { type: 'string' },
                area: { type: 'string', enum: PLAN_AREAS.map(a => a.value) },
                priority: { type: 'string', enum: [...PLAN_PRIORITIES] },
                notes: { type: 'array', items: { type: 'string' } },
              },
              required: ['action', 'area', 'priority', 'notes'],
              additionalProperties: false,
            },
          },
          conflicts: { type: 'array', items: { type: 'string' } },
        },
        required: ['song', 'focus', 'steps', 'conflicts'],
        additionalProperties: false,
      },
    },
  },
  required: ['overview', 'songs'],
  additionalProperties: false,
} as const

export const PLAN_SYSTEM_PROMPT = `You plan mixing sessions for a music producer. You receive the open notes on the current mix of one or more songs: the producer's own notes and listener feedback. Some notes are pinned to a moment in the track, shown as [@ m:ss]. Each song has an id (S1, S2, …) and each note has an id (N1, N2, …).

Turn the notes into a plan the producer can work through at the desk:
- For each song, order the steps the way a mix engineer would work: changes that affect everything downstream first (gain staging, low end, overall balance), then tone, dynamics, space and effects, then detail, automation and the master.
- Merge notes that ask for the same fix into one step, and list the id of every note the step covers. Cover every note in exactly one step.
- Write each action as something concrete to do in the session (what to change, roughly by how much, and where in the track), not a restatement of the note. Mention the moment (m:ss) when the notes behind the step are pinned to one. Never invent problems that no note raises, and never invent timestamps.
- Priority: high for what a listener would notice on the first play, low for polish.
- When notes contradict each other (one listener wants more reverb, another less), list the disagreement under conflicts rather than silently picking a side. Use an empty list when there is none.
- focus: one line on what the song's session is about. overview: one or two lines on the whole session, including which song to start with and why.`

export type PlanRefs = {
  songs: Map<string, SessionSong>
  /** note ref → [song ref, note] */
  notes: Map<string, { song: string; note: SessionNote }>
}

/**
 * The model's input for the songs given (open notes only), plus the short-ref
 * maps used to translate its answer back to real ids. Short refs (S1, N1) keep
 * the prompt small and mean the model never has to copy a UUID.
 */
export function buildPlanInput(
  songs: SessionSong[],
  meta: Map<string, Pick<SessionProjectRow, 'genre' | 'bpm' | 'key_signature'>> = new Map(),
): { text: string; refs: PlanRefs; noteCount: number } {
  const refs: PlanRefs = { songs: new Map(), notes: new Map() }
  const blocks: string[] = []
  let n = 0
  songs.forEach((song, i) => {
    const open = song.notes.filter(x => !x.done)
    if (!open.length) return
    const sref = `S${i + 1}`
    refs.songs.set(sref, song)
    const m = meta.get(song.project_id)
    const details = [m?.genre, m?.bpm ? `${m.bpm} BPM` : null, m?.key_signature ? `key ${m.key_signature}` : null]
      .filter(Boolean)
      .join(', ')
    const lines = [`${sref}: "${song.title}" — ${song.version.display_label}${details ? ` (${details})` : ''}`]
    for (const note of open) {
      n++
      const nref = `N${n}`
      refs.notes.set(nref, { song: sref, note })
      const at = note.at_seconds != null ? ` [@ ${clock(note.at_seconds)}]` : ''
      const who = note.own ? 'Producer' : `${note.reviewer}${note.rating ? ` (${note.rating}/5)` : ''}`
      lines.push(`${nref}${at} ${who}: ${note.comment.replace(/\s+/g, ' ')}`)
    }
    blocks.push(lines.join('\n'))
  })
  return { text: blocks.join('\n\n'), refs, noteCount: n }
}

const AREA_SET = new Set<string>(PLAN_AREAS.map(a => a.value))
const PRIORITY_SET = new Set<string>(PLAN_PRIORITIES)

/**
 * Validate the model's answer and translate refs back to real ids. Unknown
 * songs are dropped, notes are only accepted for their own song and only once,
 * and any open note the model left out is collected into a final step — the
 * plan never silently loses a note.
 */
export function resolvePlan(raw: unknown, refs: PlanRefs): SessionPlan {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const used = new Set<string>()
  const songs: SessionPlanSong[] = []
  const seenSongs = new Set<string>()

  const rawSongs = Array.isArray(obj.songs) ? obj.songs : []
  for (const rs of rawSongs) {
    const r = (rs && typeof rs === 'object' ? rs : {}) as Record<string, unknown>
    const sref = typeof r.song === 'string' ? r.song.trim() : ''
    const song = refs.songs.get(sref)
    if (!song || seenSongs.has(sref)) continue
    seenSongs.add(sref)
    const steps: SessionPlanStep[] = []
    for (const st of Array.isArray(r.steps) ? r.steps : []) {
      const s = (st && typeof st === 'object' ? st : {}) as Record<string, unknown>
      const action = typeof s.action === 'string' ? s.action.trim() : ''
      if (!action) continue
      const notes: SessionNote[] = []
      for (const ref of Array.isArray(s.notes) ? s.notes : []) {
        if (typeof ref !== 'string') continue
        const hit = refs.notes.get(ref.trim())
        if (!hit || hit.song !== sref || used.has(hit.note.id)) continue
        used.add(hit.note.id)
        notes.push(hit.note)
      }
      steps.push(planStep(
        action,
        typeof s.area === 'string' && AREA_SET.has(s.area) ? (s.area as PlanArea) : 'other',
        typeof s.priority === 'string' && PRIORITY_SET.has(s.priority) ? (s.priority as PlanPriority) : 'medium',
        notes,
      ))
    }
    songs.push({
      project_id: song.project_id,
      title: song.title,
      version_id: song.version.id,
      focus: typeof r.focus === 'string' ? r.focus.trim() : '',
      steps,
      conflicts: (Array.isArray(r.conflicts) ? r.conflicts : [])
        .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
        .map(c => c.trim()),
    })
  }

  // Anything the model skipped — a whole song, or single notes.
  for (const [sref, song] of refs.songs) {
    const missed = [...refs.notes.values()].filter(x => x.song === sref && !used.has(x.note.id)).map(x => x.note)
    if (!missed.length) continue
    const step = planStep('Remaining notes — work through these as written.', 'other', 'medium', missed)
    const planned = songs.find(s => s.project_id === song.project_id)
    if (planned) planned.steps.push(step)
    else songs.push({ project_id: song.project_id, title: song.title, version_id: song.version.id, focus: '', steps: [step], conflicts: [] })
  }

  return { overview: typeof obj.overview === 'string' ? obj.overview.trim() : '', songs }
}

function planStep(action: string, area: PlanArea, priority: PlanPriority, notes: SessionNote[]): SessionPlanStep {
  const pinned = notes.map(n => n.at_seconds).filter((t): t is number => t != null)
  return {
    action,
    area,
    area_label: PLAN_AREAS.find(a => a.value === area)?.label ?? 'Other',
    priority,
    priority_label: PRIORITY_LABELS[priority],
    note_ids: notes.map(n => n.id),
    at_seconds: pinned.length ? Math.min(...pinned) : null,
  }
}
