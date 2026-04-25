import { supabaseAdmin } from '@/lib/supabase'
import { getUserId } from '@/lib/auth'
import { notFound } from 'next/navigation'
import Nav from '@/components/Nav'
import ProjectClient from './ProjectClient'

export const dynamic = 'force-dynamic'

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
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

  if (projectRes.error || !projectRes.data) notFound()

  return (
    <div className="min-h-screen bg-[#080808]">
      <Nav />
      <ProjectClient
        project={projectRes.data}
        initialVersions={versionsRes.data ?? []}
        initialRelease={releaseRes.data ?? null}
      />
    </div>
  )
}
