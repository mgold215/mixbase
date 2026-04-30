import { supabaseAdmin } from '@/lib/supabase'
import { getUserId } from '@/lib/auth'
import Link from 'next/link'
import Nav from '@/components/Nav'
import { Plus } from 'lucide-react'
import ActivityFeed from '@/components/ActivityFeed'
import ProjectGrid from './ProjectGrid'

export const dynamic = 'force-dynamic'

type WorkflowStage = 'start' | 'wip' | 'mix_master' | 'finished' | 'in_pipeline' | 'released'

function getWorkflowStage(
  versions: { status: string }[],
  releases: { id: string }[]
): WorkflowStage {
  if (versions.some(v => v.status === 'Released')) return 'released'
  if (releases.length > 0) return 'in_pipeline'
  if (versions.some(v => v.status === 'Finished')) return 'finished'
  if (versions.some(v => v.status === 'Mix/Master')) return 'mix_master'
  if (versions.length > 0) return 'wip'
  return 'start'
}

export default async function DashboardPage() {
  const userId = await getUserId()

  const projectsRes = await supabaseAdmin
    .from('mb_projects')
    .select('*, mb_versions(id, status, created_at), mb_releases(id)')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })

  const projects = projectsRes.data ?? []
  const projectIds = projects.map(p => p.id)

  const activityRes = projectIds.length > 0
    ? await supabaseAdmin
        .from('mb_activity')
        .select('*')
        .in('project_id', projectIds)
        .order('created_at', { ascending: false })
        .limit(20)
    : { data: [] }

  const activity = activityRes.data ?? []

  const stats = {
    total: projects.length,
    wip: projects.filter(p => p.mb_versions?.some((v: { status: string }) => v.status === 'WIP')).length,
    finished: projects.filter(p => p.mb_versions?.some((v: { status: string }) => v.status === 'Finished')).length,
    released: projects.filter(p => p.mb_versions?.some((v: { status: string }) => v.status === 'Released')).length,
  }

  // Pre-compute stage for each project so the client component doesn't need mb_versions
  const projectRows = projects.map(p => ({
    id: p.id,
    title: p.title,
    artwork_url: p.artwork_url,
    genre: p.genre,
    bpm: p.bpm,
    stage: getWorkflowStage(p.mb_versions ?? [], p.mb_releases ?? []) as WorkflowStage,
    hasRelease: (p.mb_releases ?? []).length > 0,
  }))

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-page)' }}>
      <Nav />
      <div className="pt-14">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 pb-36 md:pb-12 py-6 sm:py-8">

          {/* Header */}
          <div className="flex items-center justify-between mb-2">
            <div>
              <h1 className="text-xl font-semibold" style={{ color: 'var(--text)' }}>Projects</h1>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                {stats.total} total
                {stats.wip > 0 && <> · <span style={{ color: 'var(--accent)' }}>{stats.wip} WIP</span></>}
                {stats.finished > 0 && <> · {stats.finished} finished</>}
                {stats.released > 0 && <> · {stats.released} released</>}
              </p>
            </div>
            <Link
              href="/projects/new"
              className="flex items-center gap-1.5 text-sm font-semibold px-3 sm:px-4 py-2 sm:py-2.5 rounded-xl transition-colors"
              style={{ background: 'var(--accent)', color: '#0d0b08' }}
            >
              <Plus size={14} strokeWidth={2.5} />
              <span className="hidden sm:inline">New Project</span>
              <span className="sm:hidden">New</span>
            </Link>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[1fr_260px] gap-0 lg:gap-8 mt-4">

            {/* Track list */}
            <div>
              {projects.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-24 gap-3 text-center">
                  <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No projects yet</p>
                  <Link
                    href="/projects/new"
                    className="flex items-center gap-1.5 text-sm transition-colors"
                    style={{ color: 'var(--accent)' }}
                  >
                    <Plus size={13} />
                    Create your first project
                  </Link>
                </div>
              ) : (
                <ProjectGrid projects={projectRows} />
              )}
            </div>

            {/* Activity feed */}
            <div className="hidden lg:block">
              <ActivityFeed activity={activity} projects={projects} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
