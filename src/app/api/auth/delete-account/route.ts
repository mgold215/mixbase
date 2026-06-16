import { NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import { supabaseAdmin } from '@/lib/supabase'

// POST /api/auth/delete-account — permanently delete user and all their data
// Deletes storage files first (GDPR), then DB rows, then the auth user.
export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  // Gather projects (with artwork_url) and version IDs before deleting anything.
  // Folding artwork_url into this select avoids a second full projects scan.
  const { data: projects } = await supabaseAdmin
    .from('mb_projects')
    .select('id, artwork_url')
    .eq('user_id', userId)

  const projectIds = (projects ?? []).map(p => p.id)

  let versionIds: string[] = []
  let audioPaths: string[] = []

  if (projectIds.length > 0) {
    const { data: versions } = await supabaseAdmin
      .from('mb_versions')
      .select('id, audio_url')
      .in('project_id', projectIds)

    versionIds = (versions ?? []).map(v => v.id)

    // Extract storage paths from audio URLs for deletion
    // URL format: https://<project>.supabase.co/storage/v1/object/public/mf-audio/<path>
    const marker = '/storage/v1/object/public/mf-audio/'
    audioPaths = (versions ?? [])
      .map(v => {
        const idx = v.audio_url?.indexOf(marker) ?? -1
        return idx !== -1 ? v.audio_url.slice(idx + marker.length) : null
      })
      .filter((p): p is string => !!p)
  }

  const artworkMarker = '/storage/v1/object/public/mf-artwork/'
  const artworkPaths = (projects ?? [])
    .map(p => {
      const idx = p.artwork_url?.indexOf(artworkMarker) ?? -1
      return idx !== -1 ? p.artwork_url.slice(idx + artworkMarker.length) : null
    })
    .filter((p): p is string => !!p)

  // Delete storage objects. A storage failure must NOT trap the user in an
  // undeletable account, so we log loudly (for a later orphan sweep) and press
  // on — DB-row deletion below is what actually gates the irreversible step.
  if (audioPaths.length > 0) {
    const { error } = await supabaseAdmin.storage.from('mf-audio').remove(audioPaths)
    if (error) {
      console.error('[delete-account] mf-audio cleanup failed for', userId, error.message)
      // Surface orphaned-object candidates to Sentry so a future sweep can find them.
      Sentry.captureMessage('delete-account: mf-audio cleanup failed', {
        level: 'warning',
        extra: { userId, objectCount: audioPaths.length, error: error.message },
      })
    }
  }
  if (artworkPaths.length > 0) {
    const { error } = await supabaseAdmin.storage.from('mf-artwork').remove(artworkPaths)
    if (error) {
      console.error('[delete-account] mf-artwork cleanup failed for', userId, error.message)
      Sentry.captureMessage('delete-account: mf-artwork cleanup failed', {
        level: 'warning',
        extra: { userId, objectCount: artworkPaths.length, error: error.message },
      })
    }
  }

  // Delete DB rows in dependency order, capturing every error. If ANY row
  // deletion fails we abort before auth.admin.deleteUser — otherwise the auth
  // user would be destroyed while PII rows keyed to that id linger as zombies.
  const dbErrors: string[] = []
  const del = async (p: PromiseLike<{ error: { message: string } | null }>, label: string) => {
    const { error } = await p
    if (error) dbErrors.push(`${label}: ${error.message}`)
  }

  if (versionIds.length > 0) {
    await del(supabaseAdmin.from('mb_feedback').delete().in('version_id', versionIds), 'mb_feedback')
  }
  if (projectIds.length > 0) {
    await del(supabaseAdmin.from('mb_activity').delete().in('project_id', projectIds), 'mb_activity')
    await del(supabaseAdmin.from('mb_versions').delete().in('project_id', projectIds), 'mb_versions')
  }

  const { data: collections } = await supabaseAdmin
    .from('mb_collections')
    .select('id')
    .eq('user_id', userId)
  const collectionIds = (collections ?? []).map(c => c.id)

  if (collectionIds.length > 0) {
    await del(supabaseAdmin.from('mb_collection_items').delete().in('collection_id', collectionIds), 'mb_collection_items')
  }

  await del(supabaseAdmin.from('mb_collections').delete().eq('user_id', userId), 'mb_collections')
  await del(supabaseAdmin.from('mb_releases').delete().eq('user_id', userId), 'mb_releases')
  await del(supabaseAdmin.from('mb_projects').delete().eq('user_id', userId), 'mb_projects')

  if (dbErrors.length > 0) {
    // Leave the account intact and retryable rather than half-deleting it.
    console.error('[delete-account] aborting before auth deletion for', userId, dbErrors)
    Sentry.captureMessage('delete-account: aborted before auth deletion (partial DB delete)', {
      level: 'error',
      extra: { userId, dbErrors },
    })
    return NextResponse.json(
      { error: 'Failed to delete account data — no changes were finalized. Please try again.' },
      { status: 500 }
    )
  }

  // Delete the auth user last (cascades to profiles via FK)
  const { error } = await supabaseAdmin.auth.admin.deleteUser(userId)
  if (error) {
    return NextResponse.json({ error: 'Failed to delete account' }, { status: 500 })
  }

  const response = NextResponse.json({ ok: true })
  response.cookies.delete('sb-access-token')
  response.cookies.delete('sb-refresh-token')
  response.cookies.delete('sb-authed')
  response.cookies.delete('sb-expires-at')
  return response
}
