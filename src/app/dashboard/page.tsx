import { supabaseAdmin } from '@/lib/supabase'
import Link from 'next/link'
import Image from 'next/image'
import Nav from '@/components/Nav'
import { StatusBadge } from '@/components/StatusBadge'
import { Plus, Music, Clock } from 'lucide-react'
import AddToPipelineButton from '@/components/AddToPipelineButton'

export const dynamic = 'force-dynamic'

type WorkflowStage = 'start' | 'wip' | 'mix_master' | 'finished' | 'in_pipeline' | 'released'

const STAGE_CONFIG: Record<WorkflowStage, { label: string; color: string }> = {
  start:       { label: 'Start',       color: 'text-[#555] bg-[#1a1a1a]' },
  wip:         { label: 'Mixing',      color: 'text-yellow-400 bg-yellow-400/10' },
  mix_master:  { label: 'Mix/Master',  color: 'text-blue-400 bg-blue-400/10' },
  finished:    { label: 'Finished',    color: 'text-emerald-400 bg-emerald-400/10' },
  in_pipeline: { label: 'In Pipeline', color: 'text-[#a78bfa] bg-[#a78bfa]/10' },
  released:    { label: 'Released',    color: 'text-purple-300 bg-purple-300/10' },
}

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
  // Fetch projects, recent activity, and stats in parallel
  const [projectsRes, activityRes] = await Promise.all([
    supabaseAdmin
      .from('mf_projects')
      .select('*, mf_versions(id, status, created_at), mf_releases(id)')
      .order('updated_at', { ascending: false }),
    supabaseAdmin
      .from('mf_activity')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20),
  ])

  const projects = projectsRes.data ?? []
  const activity = activityRes.data ?? []

  // Compute stats
  const stats = {
    total: projects.length,
    wip: projects.filter(p => p.mf_versions?.some((v: { status: string }) => v.status === 'WIP')).length,
    finished: projects.filter(p => p.mf_versions?.some((v: { status: string }) => v.status === 'Finished')).length,
    released: projects.filter(p => p.mf_versions?.some((v: { status: string }) => v.status === 'Released')).length,
  }

  function activityIcon(type: string) {
    if (type === 'version_upload') return '↑'
    if (type === 'status_change') return '→'
    if (type === 'feedback_received') return '★'
    if (type === 'release_created') return '◆'
    return '·'
  }

  function timeAgo(date: string) {
    const diff = Date.now() - new Date(date).getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    return `${Math.floor(hrs / 24)}d ago`
  }

  return (
    <div className="min-h-screen bg-[#080808]">
      <Nav />
      <div className="pt-14">
        <div className="max-w-7xl mx-auto px-6 py-8">

          {/* Header */}
          <div className="flex items-center justify-between mb-8">
            <div>
              <h1 className="text-2xl font-bold text-white">Your Projects</h1>
              <p className="text-[#555] text-sm mt-0.5">Track every version from first idea to release</p>
            </div>
            <Link
              href="/projects/new"
              className="flex items-center gap-2 bg-[#a78bfa] hover:bg-[#9370f0] text-white text-sm font-semibold px-4 py-2.5 rounded-xl transition-colors"
            >
              <Plus size={16} />
              New Project
            </Link>
          </div>

          {/* Stats bar */}
          <div className="grid grid-cols-4 gap-3 mb-8">
            {[
              { label: 'Total', value: stats.total, color: 'text-white' },
              { label: 'WIP', value: stats.wip, color: 'text-yellow-400' },
              { label: 'Finished', value: stats.finished, color: 'text-emerald-400' },
              { label: 'Released', value: stats.released, color: 'text-purple-400' },
            ].map(stat => (
              <div key={stat.label} className="bg-[#111] border border-[#1a1a1a] rounded-xl p-4">
                <p className={`text-2xl font-bold ${stat.color}`}>{stat.value}</p>
                <p className="text-[#555] text-xs mt-0.5">{stat.label}</p>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-8">
            {/* Projects grid */}
            <div>
              {projects.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-24 text-center">
                  <div className="w-16 h-16 rounded-2xl bg-[#111] border border-[#1e1e1e] flex items-center justify-center mb-4">
                    <Music size={24} className="text-[#333]" />
                  </div>
                  <p className="text-[#555] mb-4">No projects yet</p>
                  <Link
                    href="/projects/new"
                    className="flex items-center gap-2 text-[#a78bfa] text-sm hover:text-[#9370f0] transition-colors"
                  >
                    <Plus size={14} />
                    Create your first project
                  </Link>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                  {projects.map(project => {
                    const versions: { status: string }[] = project.mf_versions ?? []
                    const releases: { id: string }[] = project.mf_releases ?? []
                    const latestVersion = versions[versions.length - 1] as { status: string } | undefined
                    const latestStatus = latestVersion?.status ?? 'WIP'
                    const stage = getWorkflowStage(versions, releases)
                    const stageConf = STAGE_CONFIG[stage]
                    const showPipelineLink = stage === 'finished' || stage === 'in_pipeline' || stage === 'released'

                    return (
                      <div key={project.id} className="group bg-[#111] border border-[#1a1a1a] hover:border-[#2a2a2a] rounded-2xl overflow-hidden transition-colors flex flex-col">
                        <Link href={`/projects/${project.id}`} className="block">
                          {/* Artwork */}
                          <div className="relative aspect-square bg-[#0f0f0f]">
                            {project.artwork_url ? (
                              <Image
                                src={project.artwork_url}
                                alt={project.title}
                                fill
                                className="object-cover"
                              />
                            ) : (
                              <div className="absolute inset-0 flex items-center justify-center">
                                <Music size={32} className="text-[#222]" />
                              </div>
                            )}
                            {/* Status badge overlay */}
                            <div className="absolute top-3 right-3">
                              <StatusBadge status={latestStatus} size="sm" />
                            </div>
                            {/* Workflow stage badge */}
                            <div className="absolute top-3 left-3">
                              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${stageConf.color}`}>
                                {stageConf.label}
                              </span>
                            </div>
                          </div>

                          {/* Info */}
                          <div className="p-4 pb-3">
                            <h3 className="font-semibold text-white text-sm truncate group-hover:text-[#a78bfa] transition-colors">
                              {project.title}
                            </h3>
                            <div className="flex items-center gap-3 mt-1.5">
                              {project.genre && (
                                <span className="text-xs text-[#555]">{project.genre}</span>
                              )}
                              {project.bpm && (
                                <span className="text-xs text-[#444]">{project.bpm} BPM</span>
                              )}
                            </div>
                            <div className="flex items-center gap-1.5 mt-2 text-[#444] text-xs">
                              <Clock size={11} />
                              <span>{versions.length} version{versions.length !== 1 ? 's' : ''}</span>
                            </div>
                          </div>
                        </Link>

                        {/* Pipeline CTA */}
                        {showPipelineLink && (
                          <div className="px-4 pb-4">
                            <AddToPipelineButton
                              projectId={project.id}
                              projectTitle={project.title}
                              hasRelease={releases.length > 0}
                            />
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Activity feed */}
            <div className="bg-[#111] border border-[#1a1a1a] rounded-2xl p-5 h-fit">
              <h2 className="text-sm font-semibold text-white mb-4">Recent Activity</h2>
              {activity.length === 0 ? (
                <p className="text-[#444] text-xs">No activity yet</p>
              ) : (
                <div className="space-y-3">
                  {activity.map(item => (
                    <div key={item.id} className="flex gap-3">
                      <span className="text-[#a78bfa] text-sm mt-0.5 flex-shrink-0 w-4 text-center">
                        {activityIcon(item.type)}
                      </span>
                      <div className="min-w-0">
                        <p className="text-xs text-[#888] leading-relaxed">{item.description}</p>
                        <p className="text-[10px] text-[#444] mt-0.5">{timeAgo(item.created_at)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
