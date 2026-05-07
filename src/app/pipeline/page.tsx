import { supabaseAdmin } from '@/lib/supabase'
import { getUserId } from '@/lib/auth'
import Nav from '@/components/Nav'
import PipelineClient from './PipelineClient'

export const dynamic = 'force-dynamic'

export default async function PipelinePage() {
  const userId = await getUserId()

  const [releasesRes, projectsRes] = await Promise.all([
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
  ])

  const projectIds = (projectsRes.data ?? []).map(p => p.id)
  const versionsRes = projectIds.length > 0
    ? await supabaseAdmin
        .from('mb_versions')
        .select('id, project_id, version_number, label, status')
        .in('project_id', projectIds)
        .order('version_number', { ascending: false })
    : { data: [] }

  return (
    <div className="min-h-screen bg-[#080808]">
      <Nav />
      <div className="pt-14">
        <PipelineClient
          initialReleases={releasesRes.data ?? []}
          projects={projectsRes.data ?? []}
          versions={versionsRes.data ?? []}
        />
      </div>
    </div>
  )
}
