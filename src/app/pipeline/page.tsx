import { supabaseAdmin } from '@/lib/supabase'
import { getUserId } from '@/lib/auth'
import Nav from '@/components/Nav'
import PipelineClient from './PipelineClient'

export const dynamic = 'force-dynamic'

export default async function PipelinePage() {
  const userId = await getUserId()

  // mb_versions has no user_id column — scope it through the project join so
  // all three queries can run in parallel instead of waiting on project ids.
  const [releasesRes, projectsRes, versionsRes] = await Promise.all([
    supabaseAdmin
      .from('mb_releases')
      .select('*, mb_projects(title, artwork_url, finalized_artwork_url)')
      .eq('user_id', userId)
      .order('release_date', { ascending: true, nullsFirst: false }),
    supabaseAdmin
      .from('mb_projects')
      .select('id, title')
      .eq('user_id', userId)
      .order('title'),
    supabaseAdmin
      .from('mb_versions')
      .select('id, project_id, version_number, label, status, mb_projects!inner(user_id)')
      .eq('mb_projects.user_id', userId)
      .order('version_number', { ascending: false }),
  ])

  // Strip the join helper column so PipelineClient's prop shape is unchanged.
  const versions = (versionsRes.data ?? []).map(v => ({
    id: v.id,
    project_id: v.project_id,
    version_number: v.version_number,
    label: v.label,
    status: v.status,
  }))

  return (
    <div className="min-h-screen bg-[#080808]">
      <Nav />
      <div className="pt-14">
        <PipelineClient
          initialReleases={releasesRes.data ?? []}
          projects={projectsRes.data ?? []}
          versions={versions}
        />
      </div>
    </div>
  )
}
