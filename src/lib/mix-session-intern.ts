// Mix Session → the mixing intern: handing every song's open notes over at once.
//
// The Mix Session lists the open notes on each song's CURRENT mix. This module
// decides, song by song, what handing "all of it" to the intern means:
//
//   ready         open notes, and at least one is a measured Mix Check note the
//                 intern has a rule for — a job would have something to do
//   queued        a job for this mix is already waiting for the Mac
//   working       the Mac is on it now
//   written-only  open notes, but none the intern can act on (notes a person
//                 wrote, or measured ones with no rule). Handing these would
//                 cost about ten minutes of Logic per song and change nothing,
//                 so they are named and left for the owner.
//
// Pure on purpose (no '@/…' imports): GET/POST /api/mix-session/intern and the
// unit suite (scripts/mix-session-test.mjs) both use it, and both clients
// render what it returns.

import { internCanFix } from './intern-jobs.ts'
import type { MixSession } from './mix-session.ts'

/** The Mac helper works one job at a time; a song takes about this long. */
export const HANDOFF_MINUTES_PER_SONG = 10

export type HandoffState = 'ready' | 'queued' | 'working' | 'written-only'

export type HandoffSong = {
  project_id: string
  title: string
  version_id: string
  version_label: string
  open_count: number
  state: HandoffState
  /** What the Mac last said it was doing, while a job is in flight. */
  stage: string | null
  /** A working job gone quiet (the Mac slept, the app was quit). */
  stalled: boolean
}

export type HandoffStatus = {
  songs: HandoffSong[]
  /** Songs a hand-off would start a job for. */
  ready_count: number
  /** Songs with a job already waiting or working. */
  in_flight_count: number
  /** Songs with open notes the intern cannot act on. */
  left_count: number
  /** Roughly how long the Mac needs for everything ready plus everything in flight. */
  minutes: number
}

export type HandoffFinding = { code: string; note_id?: string | null }
export type HandoffJob = { status: string; stage?: string | null; stalled?: boolean }

/**
 * What a hand-off of the whole session would do. `findings` is each current
 * mix's Mix Check findings by version id; `jobs` is the newest job per version
 * id. A measured note the owner has already ticked off does not count: only
 * findings whose note is still open make a song ready.
 */
export function handoffStatus(
  session: Pick<MixSession, 'songs'>,
  findings: Map<string, HandoffFinding[] | null | undefined>,
  jobs: Map<string, HandoffJob>,
): HandoffStatus {
  const songs: HandoffSong[] = []
  for (const song of session.songs) {
    if (song.open_count <= 0) continue
    const open = new Set(song.notes.filter(n => !n.done).map(n => n.id))
    const stillOpen = (findings.get(song.version.id) ?? []).filter(f => !!f.note_id && open.has(f.note_id))
    const job = jobs.get(song.version.id)
    const inFlight = job && (job.status === 'queued' || job.status === 'working')
    const state: HandoffState = inFlight
      ? (job.status as 'queued' | 'working')
      : internCanFix(stillOpen) ? 'ready' : 'written-only'
    songs.push({
      project_id: song.project_id,
      title: song.title,
      version_id: song.version.id,
      version_label: song.version.display_label,
      open_count: song.open_count,
      state,
      stage: inFlight ? job.stage ?? null : null,
      stalled: !!inFlight && job.stalled === true,
    })
  }
  const count = (...states: HandoffState[]) => songs.filter(s => states.includes(s.state)).length
  const ready = count('ready'), inFlight = count('queued', 'working')
  return {
    songs,
    ready_count: ready,
    in_flight_count: inFlight,
    left_count: count('written-only'),
    minutes: (ready + inFlight) * HANDOFF_MINUTES_PER_SONG,
  }
}
