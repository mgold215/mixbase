import { supabaseAdmin, MIX_NOTE_AUTHOR } from '@/lib/supabase'
import { ensureFeedbackResolvedColumn, isMissingFeedbackResolvedColumn } from '@/lib/schema-heal'
import {
  buildMixSession,
  currentVersionByProject,
  type MixSession,
  type SessionNoteRow,
  type SessionProjectRow,
  type SessionVersionRow,
} from '@/lib/mix-session'

// Loads one user's Mix Session — shared by GET /api/mix-session and
// POST /api/mix-session/plan so the list and the plan always see the same
// notes. Every read is scoped to the caller's own projects; notes and versions
// carry no user_id of their own, so the scope is the project-id list.

const PROJECT_COLS = 'id, title, artwork_url, finalized_artwork_url, visualizer_url, genre, bpm, key_signature'
const VERSION_COLS = 'id, project_id, version_number, label, audio_url, audio_filename, duration_seconds, status, allow_download, share_token, created_at'
const NOTE_COLS = 'id, version_id, reviewer_name, rating, comment, timestamp_seconds, created_at'

// PostgREST takes `in.(…)` filters in the query string; batching keeps a big
// catalog from producing a URL the gateway refuses.
const IN_BATCH = 100

export type LoadedMixSession = {
  session: MixSession
  projects: SessionProjectRow[]
  /** false only while migration 041 is missing AND its heal failed — notes then all read as open and can't be ticked. */
  doneSupported: boolean
}

export class MixSessionLoadError extends Error {}

function batches<T>(items: T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += IN_BATCH) out.push(items.slice(i, i + IN_BATCH))
  return out
}

async function selectIn<T>(table: string, cols: string, column: string, ids: string[]): Promise<T[]> {
  const rows: T[] = []
  for (const batch of batches(ids)) {
    const { data, error } = await supabaseAdmin.from(table).select(cols).in(column, batch)
    // Never mistake a failed read for an empty one: an empty session would
    // tell the artist they have nothing left to fix.
    if (error) throw Object.assign(new MixSessionLoadError(error.message), { cause: error })
    rows.push(...((data ?? []) as T[]))
  }
  return rows
}

async function loadNotes(versionIds: string[]): Promise<{ notes: SessionNoteRow[]; doneSupported: boolean }> {
  try {
    return { notes: await selectIn<SessionNoteRow>('mb_feedback', `${NOTE_COLS}, resolved_at`, 'version_id', versionIds), doneSupported: true }
  } catch (err) {
    const cause = (err as { cause?: { message?: string } }).cause ?? null
    if (!isMissingFeedbackResolvedColumn(cause)) throw err
    // Deploy beat migration 041: heal and retry once; if the heal can't run,
    // still show the list (everything open) rather than nothing.
    if (await ensureFeedbackResolvedColumn()) {
      return { notes: await selectIn<SessionNoteRow>('mb_feedback', `${NOTE_COLS}, resolved_at`, 'version_id', versionIds), doneSupported: true }
    }
    return { notes: await selectIn<SessionNoteRow>('mb_feedback', NOTE_COLS, 'version_id', versionIds), doneSupported: false }
  }
}

export async function loadMixSession(userId: string): Promise<LoadedMixSession> {
  const { data: projectData, error: projectError } = await supabaseAdmin
    .from('mb_projects')
    .select(PROJECT_COLS)
    .eq('user_id', userId)
  if (projectError) throw new MixSessionLoadError(projectError.message)
  const projects = (projectData ?? []) as SessionProjectRow[]
  if (!projects.length) return { session: buildMixSession([], [], [], MIX_NOTE_AUTHOR), projects, doneSupported: true }

  const versions = await selectIn<SessionVersionRow>('mb_versions', VERSION_COLS, 'project_id', projects.map(p => p.id))
  // Only the current mix's notes matter — don't fetch the whole history.
  const currentIds = [...currentVersionByProject(versions).values()].map(v => v.id)
  const { notes, doneSupported } = currentIds.length
    ? await loadNotes(currentIds)
    : { notes: [], doneSupported: true }

  return { session: buildMixSession(projects, versions, notes, MIX_NOTE_AUTHOR), projects, doneSupported }
}
