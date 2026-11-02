// THUMB DRIVE — every account's built-in "all my songs" playlist.
//
// It's an ordinary mb_collections playlist (is_thumb_drive = true, migration
// 042), so every existing surface — the web collection page, the public
// /album/... share player, the iOS app, the tracklist export — works on it
// unchanged. What's special is that the SERVER keeps it filled:
//
//   ensureThumbDrive     — find the account's THUMB DRIVE, or create it and fill
//                          it with every song that has a mix. Called wherever
//                          the collections list is loaded (web page, GET
//                          /api/collections, GET /api/collections/thumb-drive
//                          for the app), so new accounts get one on first look.
//   addSongToThumbDrive  — called by POST /api/versions when a song's FIRST mix
//                          is uploaded; puts the song at the top.
//   isSongInThumbDrive / setSongInThumbDrive
//                        — the "Include in THUMB DRIVE" switch on each song's
//                          page (web + app, via /api/projects/[id]/thumb-drive).
//                          Switching off removes the song, and it stays out.
//
// "Newest mix" needs no code here: items point at the song (project), and
// every player resolves the song's highest version_number when it plays.
//
// ensureThumbDrive, addSongToThumbDrive and isSongInThumbDrive never throw. A
// THUMB DRIVE hiccup must never fail an upload or blank a page — it's logged
// and the caller carries on. setSongInThumbDrive DOES throw, because the switch
// has to tell the artist when flipping it didn't work.

import { supabaseAdmin } from '@/lib/supabase'
import { ensureThumbDriveColumn, isMissingThumbDriveColumn } from '@/lib/schema-heal'
import { THUMB_DRIVE_TITLE, thumbDriveFillOrder, positionForNewSong } from '@/lib/thumb-drive-plan'

export type ThumbDrive = { id: string; created: boolean }

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  const message = (err as { message?: unknown } | null)?.message
  return typeof message === 'string' ? message : String(err)
}

function lookupThumbDrive(userId: string) {
  return supabaseAdmin
    .from('mb_collections')
    .select('id')
    .eq('user_id', userId)
    .eq('is_thumb_drive', true)
    .limit(1)
    .maybeSingle()
}

// Put every song that has at least one mix into a just-created THUMB DRIVE,
// newest song first. Songs already in it (a racing first upload) are skipped.
async function fillThumbDrive(userId: string, collectionId: string): Promise<void> {
  const { data: songs, error } = await supabaseAdmin
    .from('mb_projects')
    .select('id, created_at, mb_versions(id)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1000)
  if (error) throw error

  const order = thumbDriveFillOrder(
    ((songs ?? []) as Array<{ id: string; created_at: string | null; mb_versions: unknown[] | null }>).map(s => ({
      id: s.id,
      created_at: s.created_at,
      mixCount: Array.isArray(s.mb_versions) ? s.mb_versions.length : 0,
    })),
  )
  if (order.length === 0) return

  const { data: present, error: presentError } = await supabaseAdmin
    .from('mb_collection_items')
    .select('project_id')
    .eq('collection_id', collectionId)
  if (presentError) throw presentError
  const have = new Set((present ?? []).map(r => r.project_id as string))

  const items = order
    .map((project_id, position) => ({ collection_id: collectionId, project_id, position }))
    .filter(item => !have.has(item.project_id))
  if (items.length === 0) return

  // One insert = all or nothing, so a failure can't leave half a fill behind.
  const { error: insertError } = await supabaseAdmin.from('mb_collection_items').insert(items)
  if (insertError) throw insertError
}

/**
 * The account's THUMB DRIVE, created (and filled with every song that has a
 * mix) if it doesn't exist yet. `created` tells the caller a fill just ran.
 * Resolves null — never throws — when it can't be set up.
 */
export async function ensureThumbDrive(userId: string): Promise<ThumbDrive | null> {
  try {
    let found = await lookupThumbDrive(userId)
    // Deploy beat migration 042: add the column via the Management API, retry.
    if (found.error && isMissingThumbDriveColumn(found.error) && await ensureThumbDriveColumn()) {
      found = await lookupThumbDrive(userId)
    }
    if (found.error) throw found.error
    if (found.data) return { id: found.data.id as string, created: false }

    const created = await supabaseAdmin
      .from('mb_collections')
      .insert({ user_id: userId, title: THUMB_DRIVE_TITLE, type: 'playlist', is_thumb_drive: true })
      .select('id')
      .single()
    if (created.error) {
      // 23505 = the one-per-account unique index: a concurrent request just
      // created it. Theirs is the THUMB DRIVE (and they run the fill).
      if (created.error.code === '23505') {
        const winner = await lookupThumbDrive(userId)
        if (winner.data) return { id: winner.data.id as string, created: false }
      }
      throw created.error
    }

    const id = created.data.id as string
    try {
      await fillThumbDrive(userId, id)
    } catch (fillError) {
      // Don't leave an empty THUMB DRIVE behind: the next call would find it and
      // never fill it. Remove it so the next request starts over cleanly.
      await supabaseAdmin.from('mb_collections').delete().eq('id', id).eq('is_thumb_drive', true)
      throw fillError
    }
    return { id, created: true }
  } catch (err) {
    console.error(`[thumb-drive] could not set up THUMB DRIVE for ${userId}: ${errorText(err)}`)
    return null
  }
}

// True when the song is already in this THUMB DRIVE. Throws on a read error.
async function containsSong(driveId: string, projectId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('mb_collection_items')
    .select('id')
    .eq('collection_id', driveId)
    .eq('project_id', projectId)
    .limit(1)
  if (error) throw error
  return (data ?? []).length > 0
}

// Bump updated_at so newest-first collection lists stay honest.
async function touchThumbDrive(driveId: string): Promise<void> {
  await supabaseAdmin
    .from('mb_collections')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', driveId)
}

// Put a song at the top of this THUMB DRIVE unless it's already in it (a song
// that's there is left where the artist put it). Throws on a database error.
async function insertSongAtTop(driveId: string, projectId: string): Promise<void> {
  if (await containsSong(driveId, projectId)) return

  const { data: top, error: topError } = await supabaseAdmin
    .from('mb_collection_items')
    .select('position')
    .eq('collection_id', driveId)
    .order('position', { ascending: true })
    .limit(1)
  if (topError) throw topError

  const { error: insertError } = await supabaseAdmin.from('mb_collection_items').insert({
    collection_id: driveId,
    project_id: projectId,
    position: positionForNewSong(top?.[0]?.position as number | undefined),
  })
  if (insertError) throw insertError
  await touchThumbDrive(driveId)
}

/**
 * Add a song to the top of its owner's THUMB DRIVE — called when the song's
 * first mix is uploaded. A song that's already there is left where it is.
 * Never throws.
 */
export async function addSongToThumbDrive(userId: string, projectId: string): Promise<void> {
  try {
    const drive = await ensureThumbDrive(userId)
    // null: couldn't set it up (already logged). created: the fill just put
    // every song with a mix in it — this one included.
    if (!drive || drive.created) return
    await insertSongAtTop(drive.id, projectId)
  } catch (err) {
    console.error(`[thumb-drive] could not add song ${projectId} for ${userId}: ${errorText(err)}`)
  }
}

/**
 * Is this song in its owner's THUMB DRIVE right now? Powers the switch on the
 * song page. Resolves null — never throws — when it can't be read, so the page
 * can hide the switch rather than show a guess. The caller must already have
 * checked that userId owns projectId.
 */
export async function isSongInThumbDrive(userId: string, projectId: string): Promise<boolean | null> {
  try {
    const drive = await ensureThumbDrive(userId)
    if (!drive) return null
    return await containsSong(drive.id, projectId)
  } catch (err) {
    console.error(`[thumb-drive] could not read song ${projectId} for ${userId}: ${errorText(err)}`)
    return null
  }
}

/**
 * The song page's switch: put a song in its owner's THUMB DRIVE (at the top)
 * or take it out. Taking it out removes every copy of it from THUMB DRIVE, and
 * it stays out — later mixes don't add it back (only a song's FIRST mix does).
 *
 * Unlike the upload hook this THROWS on failure: the switch has to tell the
 * artist when it didn't work. The caller must already have checked that userId
 * owns projectId.
 */
export async function setSongInThumbDrive(userId: string, projectId: string, included: boolean): Promise<void> {
  const drive = await ensureThumbDrive(userId)
  if (!drive) throw new Error('THUMB DRIVE could not be set up')

  if (included) {
    await insertSongAtTop(drive.id, projectId)
    return
  }

  const { error } = await supabaseAdmin
    .from('mb_collection_items')
    .delete()
    .eq('collection_id', drive.id)
    .eq('project_id', projectId)
  if (error) throw error
  await touchThumbDrive(drive.id)
}
