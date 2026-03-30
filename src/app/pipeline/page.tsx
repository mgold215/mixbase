import { supabaseAdmin } from '@/lib/supabase'
import Nav from '@/components/Nav'
import PipelineClient from './PipelineClient'

export const dynamic = 'force-dynamic'

export default async function PipelinePage() {
  const [releasesRes, projectsRes] = await Promise.all([
    supabaseAdmin
      .from('mf_releases')
      .select('*, mf_projects(id, title, artwork_url), mf_versions(id, version_number, label, audio_url, status)')
      .order('release_date', { ascending: true, nullsFirst: false }),
    supabaseAdmin
      .from('mf_projects')
      .select('id, title')
      .order('title'),
  ])

  return (
    <div className="min-h-screen bg-[#080808]">
      <Nav />
      <div className="pt-14">
        <PipelineClient
          initialReleases={releasesRes.data ?? []}
          projects={projectsRes.data ?? []}
        />
      </div>
    </div>
  )
}
