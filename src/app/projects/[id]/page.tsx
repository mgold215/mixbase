import { getProject } from '@/lib/localdb'
import { notFound } from 'next/navigation'
import Nav from '@/components/Nav'
import ProjectClient from './ProjectClient'

export const dynamic = 'force-dynamic'

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const data = getProject(id)
  if (!data) notFound()

  const { mf_versions, ...project } = data

  return (
    <div className="min-h-screen bg-[#080808]">
      <Nav />
      <ProjectClient
        project={project}
        initialVersions={mf_versions}
      />
    </div>
  )
}
