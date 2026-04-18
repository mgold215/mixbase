import { supabaseAdmin } from '@/lib/supabase'
import Link from 'next/link'
import Image from 'next/image'
import Nav from '@/components/Nav'
import { Music, Plus } from 'lucide-react'
import DashPlayButton from '@/components/DashPlayButton'
import AddToPipelineButton from '@/components/AddToPipelineButton'
import ActivityFeed from '@/components/ActivityFeed'

export const dynamic = 'force-dynamic'

type WorkflowStage = 'start' | 'wip' | 'mix_master' | 'finished' | 'in_pipeline' | 'released'

const STAGE_LABEL: Record<WorkflowStage, string> = {
  start:       'No audio',
  wip:         'Mixing',
  mix_master:  'Mix/Master',
  finished:    'Finished',
  in_pipeline: 'In pipeline',
  released:    'Released',
}

const STAGE_COLOR: Record<WorkflowStage, string> = {
  start:       '#6b6050',
  wip:         '#2dd4bf',
  mix_master:  '#60a5fa',
  finished:    '#4ade80',
  in_pipeline: '#2dd4bf',
  released:    '#4ade80',
}

const STAGE_BG: Record<WorkflowStage, string> = {
  start:       'transparent',
  wip:         'rgba(45, 212, 191, 0.1)',
  mix_master:  'rgba(96, 165, 250, 0.1)',
  finished:    'rgba(74, 222, 128, 0.1)',
  in_pipeline: 'rgba(45, 212, 191, 0.1)',
  released:    'rgba(74, 222, 128, 0.1)',
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
  const [projectsRes, activityRes] = await Promise.all([
    supabaseAdmin
      .from('mb_projects')
      .select('*, mb_versions(id, status, created_at), mb_releases(id)')
      .order('updated_at', { ascending: false }),
    supabaseAdmin
      .from('mb_activity')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20),
  ])

  const projects = projectsRes.data ?? []
  const activity = activityRes.data ?? []

  const stats = {
    total: projects.length,
    wip: projects.filter(p => p.mb_versions?.some((v: { status: string }) => v.status === 'WIP')).length,
    finished: projects.filter(p => p.mb_versions?.some((v: { status: string }) => v.status === 'Finished')).length,
    released: projects.filter(p => p.mb_versions?.some((v: { status: string }) => v.status === 'Released')).length,
  }

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
                {stats.wip > 0 && <> · <span style={{ color: 'var(--accent)' }}>{stats.wip} mixing</span></>}
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
              {/* Column headers — desktop only */}
              <div
                className="hidden sm:grid mb-1"
                style={{
                  gridTemplateColumns: '44px 1fr 60px 100px 80px',
                  gap: 12,
                  paddingBottom: 8,
                  borderBottom: '1px solid var(--border)',
                }}
              >
                {['', 'Title', 'Version', 'Stage', ''].map((col, i) => (
                  <div key={i} style={{
                    fontFamily: 'var(--font-mono), monospace',
                    fontSize: 9,
                    letterSpacing: '0.14em',
                    color: 'var(--text-muted)',
                    textTransform: 'uppercase',
                    textAlign: i === 2 ? 'center' : i >= 3 ? 'right' : 'left',
                  }}>
                    {col}
                  </div>
                ))}
              </div>

              {projects.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-24 gap-3 text-center">
                  <Music size={24} style={{ color: 'var(--text-muted)', opacity: 0.35 }} />
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
                <div>
                  {projects.map(project => {
                    const versions: { status: string }[] = project.mb_versions ?? []
                    const releases: { id: string }[] = project.mb_releases ?? []
                    const stage = getWorkflowStage(versions, releases)

                    return (
                      <div
                        key={project.id}
                        className="group flex items-center gap-3 sm:gap-3"
                        style={{
                          borderBottom: '1px solid var(--border)',
                          padding: '10px 0',
                          position: 'relative',
                        }}
                      >
                        {/* Amber left accent on hover */}
                        <div style={{
                          position: 'absolute',
                          left: -16,
                          top: 0,
                          bottom: 0,
                          width: 2,
                          background: 'var(--accent)',
                          opacity: 0,
                          transition: 'opacity 0.15s',
                        }} className="group-hover:opacity-100" />

                        {/* Artwork */}
                        <Link href={`/projects/${project.id}`} style={{ flexShrink: 0 }}>
                          <div style={{
                            width: 44,
                            height: 44,
                            background: 'var(--surface-2)',
                            overflow: 'hidden',
                            position: 'relative',
                            borderRadius: 4,
                          }}>
                            {project.artwork_url ? (
                              <Image
                                src={project.artwork_url}
                                alt={project.title}
                                fill
                                className="object-cover"
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center">
                                <Music size={14} style={{ color: 'var(--text-muted)', opacity: 0.4 }} />
                              </div>
                            )}
                          </div>
                        </Link>

                        {/* Title + meta */}
                        <Link
                          href={`/projects/${project.id}`}
                          className="flex-1 min-w-0"
                          style={{ textDecoration: 'none' }}
                        >
                          <div
                            className="text-sm font-medium truncate transition-colors"
                            style={{ color: 'var(--text)', lineHeight: 1.3 }}
                          >
                            {project.title}
                          </div>
                          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                            {project.genre && (
                              <span style={{
                                fontFamily: 'var(--font-mono), monospace',
                                fontSize: 10,
                                color: 'var(--text-muted)',
                              }}>
                                {project.genre}
                              </span>
                            )}
                            {project.bpm && (
                              <span style={{
                                fontFamily: 'var(--font-mono), monospace',
                                fontSize: 10,
                                color: 'var(--text-muted)',
                              }}>
                                {project.bpm} BPM
                              </span>
                            )}
                          </div>
                        </Link>

                        {/* Version count */}
                        <div
                          className="hidden sm:block"
                          style={{
                            fontFamily: 'var(--font-mono), monospace',
                            fontSize: 11,
                            color: 'var(--text-muted)',
                            flexShrink: 0,
                            width: 60,
                            textAlign: 'center',
                          }}
                        >
                          {versions.length}v
                        </div>

                        {/* Stage pill */}
                        <div
                          className="hidden sm:block"
                          style={{ flexShrink: 0, width: 100, display: 'flex', justifyContent: 'flex-end' }}
                        >
                          {stage === 'start' ? (
                            <span style={{
                              fontFamily: 'var(--font-mono), monospace',
                              fontSize: 10,
                              color: STAGE_COLOR[stage],
                              opacity: 0.55,
                            }}>
                              {STAGE_LABEL[stage]}
                            </span>
                          ) : (
                            <span style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              fontFamily: 'var(--font-mono), monospace',
                              fontSize: 10,
                              letterSpacing: '0.04em',
                              color: STAGE_COLOR[stage],
                              background: STAGE_BG[stage],
                              border: `1px solid ${STAGE_COLOR[stage]}50`,
                              borderRadius: 4,
                              padding: '2px 8px',
                              whiteSpace: 'nowrap',
                            }}>
                              {STAGE_LABEL[stage]}
                            </span>
                          )}
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          <DashPlayButton projectId={project.id} />
                          <div className="hidden sm:block">
                            <AddToPipelineButton
                              projectId={project.id}
                              projectTitle={project.title}
                              hasRelease={releases.length > 0}
                            />
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
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
