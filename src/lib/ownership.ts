// Shared ownership checks. The server uses the RLS-bypassing service-role client
// (supabaseAdmin) for all reads/writes, so every route that accepts a client-supplied
// resource id MUST verify the resource belongs to the requesting user before using it.
// Without this an authenticated user can reference another user's rows by id (IDOR).
//
// These mirror the inline ownsProject/ownsCollection helpers already used in the
// collections-items route; promoted here so the upload and release routes can reuse
// the exact same check instead of re-implementing it.
import { supabaseAdmin } from '@/lib/supabase'

// True if the project exists AND belongs to this user.
export async function ownsProject(projectId: string, userId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('mb_projects')
    .select('id')
    .eq('id', projectId)
    .eq('user_id', userId)
    .single()
  return !!data
}

// True if the version exists AND its parent project belongs to this user.
// Versions have no user_id column of their own — ownership flows through the
// project (mb_versions.project_id → mb_projects.user_id).
export async function ownsVersion(versionId: string, userId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('mb_versions')
    .select('id, mb_projects!inner(user_id)')
    .eq('id', versionId)
    .eq('mb_projects.user_id', userId)
    .single()
  return !!data
}
