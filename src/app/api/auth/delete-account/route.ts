import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// POST /api/auth/delete-account — permanently delete user and all their data
// Deletes storage files first (GDPR), then DB rows, then the auth user.
export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  // Gather all project and version IDs before deleting anything
  const { data: projects } = await supabaseAdmin
    .from('mb_projects')
    .select('id')
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

  // Collect artwork paths from projects
  const { data: projectsWithArt } = await supabaseAdmin
    .from('mb_projects')
    .select('artwork_url')
    .eq('user_id', userId)

  const artworkMarker = '/storage/v1/object/public/mf-artwork/'
  const artworkPaths = (projectsWithArt ?? [])
    .map(p => {
      const idx = p.artwork_url?.indexOf(artworkMarker) ?? -1
      return idx !== -1 ? p.artwork_url.slice(idx + artworkMarker.length) : null
    })
    .filter((p): p is string => !!p)

  // Delete storage files (best-effort — don't block account deletion on storage errors)
  if (audioPaths.length > 0) {
    await supabaseAdmin.storage.from('mf-audio').remove(audioPaths)
  }
  if (artworkPaths.length > 0) {
    await supabaseAdmin.storage.from('mf-artwork').remove(artworkPaths)
  }

  // Delete DB rows in dependency order
  if (versionIds.length > 0) {
    await supabaseAdmin.from('mb_feedback').delete().in('version_id', versionIds)
  }

  if (projectIds.length > 0) {
    await supabaseAdmin.from('mb_activity').delete().in('project_id', projectIds)
    await supabaseAdmin.from('mb_versions').delete().in('project_id', projectIds)
  }

  const { data: collections } = await supabaseAdmin
    .from('mb_collections')
    .select('id')
    .eq('user_id', userId)
  const collectionIds = (collections ?? []).map(c => c.id)

  if (collectionIds.length > 0) {
    await supabaseAdmin.from('mb_collection_items').delete().in('collection_id', collectionIds)
  }

  await supabaseAdmin.from('mb_collections').delete().eq('user_id', userId)
  await supabaseAdmin.from('mb_releases').delete().eq('user_id', userId)
  await supabaseAdmin.from('mb_projects').delete().eq('user_id', userId)

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
