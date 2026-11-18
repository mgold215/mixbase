// The released-library sync, shared by the "Sync Catalog" button
// (POST /api/library) and the release-day ISRC check (release-isrc-job.ts).
// Fetches the artist's public catalog and merges it into mb_library_tracks:
// match by ISRC first, then by title+release; new facts win over blanks, a
// blank never erases a known code, and a manual project link is never touched.

import { supabaseAdmin } from './supabase'
import { fetchArtistCatalog, flattenCatalogTracks, mergeLibraryRow } from './catalog'
import { ensureLibraryTracksTable, isMissingLibraryTracksTable } from './schema-heal'

// Heal-and-retry for the missing-table failure. Even after the heal's DDL
// lands (and its `notify pgrst` fires), PostgREST reloads its schema cache
// asynchronously — an immediate retry can still see PGRST205. Retry a few
// times with a pause so the very first request after a fresh deploy succeeds
// instead of surfacing "table not found in schema cache" to the user.
export async function withLibraryHeal<T>(
  run: () => PromiseLike<{ data: T | null; error: { code?: string; message?: string } | null }>,
): Promise<{ data: T | null; error: { code?: string; message?: string } | null }> {
  let res = await run()
  if (res.error && isMissingLibraryTracksTable(res.error) && await ensureLibraryTracksTable()) {
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise(r => setTimeout(r, 1200))
      res = await run()
      if (!res.error || !isMissingLibraryTracksTable(res.error)) break
    }
  }
  return res
}

export type LibrarySyncResult = {
  source: string
  artistName: string
  created: number
  updated: number
  failed: number
  error?: string
  total: number
}

/** Thrown when the stored library can't be read, so nothing was merged. */
export class LibraryReadError extends Error {}

/**
 * Sync one user's released library from the public catalog. Throws
 * CatalogError when the lookup itself fails (nothing written), and
 * LibraryReadError when the stored rows can't be read.
 */
export async function syncLibraryForUser(userId: string, artist: string): Promise<LibrarySyncResult> {
  const catalog = await fetchArtistCatalog(artist)
  const rows = flattenCatalogTracks(catalog)

  // The projection must carry every field mergeLibraryRow() protects — a column
  // that isn't read back cannot be preserved, and would be silently nulled.
  const { data: existing, error: readErr } = await withLibraryHeal(() => supabaseAdmin
    .from('mb_library_tracks')
    .select('id, title, isrc, upc, release_title, release_date, source_url, artist_name, project_id')
    .eq('user_id', userId)
    .limit(1000))
  if (readErr) throw new LibraryReadError(readErr.message ?? 'Could not read the library')

  const byIsrc = new Map((existing ?? []).filter(r => r.isrc).map(r => [r.isrc as string, r]))
  const byTitle = new Map((existing ?? []).map(r => [`${r.title.trim().toLowerCase()}|${(r.release_title ?? '').trim().toLowerCase()}`, r]))

  // Auto-match each track to the user's project of the same name so the
  // original audio file is one click away in the library.
  const { data: projects } = await supabaseAdmin
    .from('mb_projects')
    .select('id, title')
    .eq('user_id', userId)
    .limit(1000)
  const projectByTitle = new Map((projects ?? []).map(p => [p.title.trim().toLowerCase(), p.id]))

  let created = 0
  let updated = 0
  // A sync that half-failed used to report success: every write error was
  // discarded, and the client rendered "Synced N tracks" from `total` regardless.
  // Count the failures and hand them back so the UI can tell the truth.
  let failed = 0
  let firstError: string | null = null
  const noteError = (message: string) => {
    failed++
    if (!firstError) {
      firstError = message
      console.error('[library-sync] write failed:', message)
    }
  }

  for (const row of rows) {
    const match = (row.isrc && byIsrc.get(row.isrc))
      || byTitle.get(`${row.title.trim().toLowerCase()}|${row.release_title.trim().toLowerCase()}`)
    const projectId = projectByTitle.get(row.title.trim().toLowerCase()) ?? null

    if (match) {
      const { error } = await supabaseAdmin
        .from('mb_library_tracks')
        // New facts win over blanks; a blank never erases a known code.
        .update({
          ...mergeLibraryRow(match, row),
          // Keep an existing manual/auto project link unless we found one now.
          project_id: match.project_id ?? projectId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', match.id)
        .eq('user_id', userId)
      if (error) noteError(error.message)
      else updated++
    } else {
      const { error } = await supabaseAdmin
        .from('mb_library_tracks')
        .insert({ ...row, user_id: userId, project_id: projectId })
      if (error) noteError(error.message)
      else created++
    }
  }

  return {
    source: catalog.source,
    artistName: catalog.artistName,
    created, updated, failed,
    // Surfaced so a partial sync can say so instead of claiming a clean run.
    error: failed > 0 ? (firstError ?? 'Some tracks could not be saved') : undefined,
    total: rows.length,
  }
}
