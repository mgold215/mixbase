import { supabaseAdmin } from '@/lib/supabase'
import { getUserId } from '@/lib/auth'
import ModalShell from '@/components/ModalShell'
import ProjectClient from '@/app/projects/[id]/ProjectClient'

export const dynamic = 'force-dynamic'

// Intercepts client-side navigation to /projects/[id] (e.g. from the dashboard
// grid) and renders the project view in a modal over the current page. Hard
// loads and shared URLs still get the full page at src/app/projects/[id].
export default async function ProjectModalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const userId = await getUserId()

  const [projectRes, versionsRes, releaseRes] = await Promise.all([
    supabaseAdmin.from('mb_projects').select('*').eq('id', id).eq('user_id', userId).single(),
    supabaseAdmin
      .from('mb_versions')
      .select('*, mb_feedback(*)')
      .eq('project_id', id)
      .order('version_number', { ascending: false }),
    supabaseAdmin
      .from('mb_releases')
      .select('*')
      .eq('project_id', id)
      .maybeSingle(),
  ])

  if (projectRes.error || !projectRes.data) return null

  return (
    <ModalShell>
      <ProjectClient
        project={projectRes.data}
        initialVersions={versionsRes.data ?? []}
        initialRelease={releaseRes.data ?? null}
        inModal
      />
    </ModalShell>
  )
}
