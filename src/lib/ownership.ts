import { supabaseAdmin } from './supabase'

export async function verifyProjectOwner(projectId: string | null | undefined, userId: string): Promise<boolean> {
  if (!projectId) return false

  const { data } = await supabaseAdmin
    .from('mb_projects')
    .select('id')
    .eq('id', projectId)
    .eq('user_id', userId)
    .maybeSingle()

  return !!data
}

export type VersionOwnership = {
  id: string
  project_id: string
}

export async function verifyVersionOwner(versionId: string | null | undefined, userId: string): Promise<VersionOwnership | null> {
  if (!versionId) return null

  const { data } = await supabaseAdmin
    .from('mb_versions')
    .select('id, project_id, mb_projects!inner(user_id)')
    .eq('id', versionId)
    .eq('mb_projects.user_id', userId)
    .maybeSingle()

  if (!data) return null
  return { id: data.id, project_id: data.project_id }
}
