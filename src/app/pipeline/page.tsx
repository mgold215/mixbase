import { supabaseAdmin } from '@/lib/supabase'
import Nav from '@/components/Nav'
import PipelineClient from './PipelineClient'

export const dynamic = 'force-dynamic'

export default async function PipelinePage() {
  const [releasesRes, projectsRes, versionsRes] = await Promise.all([
    supabaseAdmin
      .from('mf_releases')
      .select('*, mf_projects(title, artwork_url)')
      .order('release_date', { ascending: true, nullsFirst: false }),
    supabaseAdmin
      .from('mf_projects')
      .select('id, title')
      .order('title'),
    supabaseAdmin
      .from('mf_versions')
      .select('id, project_id, version_number, label, status')
      .order('version_number', { ascending: false }),
  ])

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
