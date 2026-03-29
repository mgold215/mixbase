import { supabaseAdmin, formatDuration, formatFileSize, STATUS_CONFIG, STATUSES } from '@/lib/supabase'
import { notFound } from 'next/navigation'
import Nav from '@/components/Nav'
import ProjectClient from './ProjectClient'

export const dynamic = 'force-dynamic'

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const [projectRes, versionsRes] = await Promise.all([
    supabaseAdmin.from('mf_projects').select('*').eq('id', id).single(),
    supabaseAdmin
      .from('mf_versions')
      .select('*, mf_feedback(*)')
      .eq('project_id', id)
      .order('version_number', { ascending: false }),
  ])

  if (projectRes.error || !projectRes.data) notFound()

  return (
    <div className="min-h-screen bg-[#080808]">
      <Nav />
      <ProjectClient
        project={projectRes.data}
        initialVersions={versionsRes.data ?? []}
      />
    </div>
  )
}
