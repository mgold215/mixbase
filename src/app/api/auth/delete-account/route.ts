import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// POST /api/auth/delete-account — permanently delete user and all their data
export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  // Delete all user data in dependency order
  // 1. Activity (references projects)
  const { data: projects } = await supabaseAdmin
    .from('mb_projects')
    .select('id')
    .eq('user_id', userId)

  const projectIds = (projects ?? []).map(p => p.id)

  if (projectIds.length > 0) {
    // Feedback on user's versions
    const { data: versions } = await supabaseAdmin
      .from('mb_versions')
      .select('id')
      .in('project_id', projectIds)
    const versionIds = (versions ?? []).map(v => v.id)

    if (versionIds.length > 0) {
      await supabaseAdmin.from('mb_feedback').delete().in('version_id', versionIds)
    }

    // Activity, versions
    await supabaseAdmin.from('mb_activity').delete().in('project_id', projectIds)
    await supabaseAdmin.from('mb_versions').delete().in('project_id', projectIds)
  }

  // Collection items, then collections
  const { data: collections } = await supabaseAdmin
    .from('mb_collections')
    .select('id')
    .eq('user_id', userId)
  const collectionIds = (collections ?? []).map(c => c.id)

  if (collectionIds.length > 0) {
    await supabaseAdmin.from('mb_collection_items').delete().in('collection_id', collectionIds)
  }

  // Top-level tables
  await supabaseAdmin.from('mb_collections').delete().eq('user_id', userId)
  await supabaseAdmin.from('mb_releases').delete().eq('user_id', userId)
  await supabaseAdmin.from('mb_projects').delete().eq('user_id', userId)

  // Delete the auth user last
  const { error } = await supabaseAdmin.auth.admin.deleteUser(userId)
  if (error) {
    return NextResponse.json({ error: 'Failed to delete account' }, { status: 500 })
  }

  // Clear session cookies
  const response = NextResponse.json({ ok: true })
  response.cookies.delete('sb-access-token')
  response.cookies.delete('sb-refresh-token')
  return response
}
