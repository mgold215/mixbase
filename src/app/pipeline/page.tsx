import { getReleases, getProjects } from '@/lib/localdb'
import Nav from '@/components/Nav'
import PipelineClient from './PipelineClient'

export const dynamic = 'force-dynamic'

export default async function PipelinePage() {
  const releases = getReleases()
  const projects = getProjects()

  return (
    <div className="min-h-screen bg-[#080808]">
      <Nav />
      <div className="pt-14">
        <PipelineClient
          initialReleases={releases}
          projects={projects.map(p => ({ id: p.id, title: p.title }))}
        />
      </div>
    </div>
  )
}
