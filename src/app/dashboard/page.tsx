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
  start:       'NO AUDIO',
  wip:         'MIXING',
  mix_master:  'MIX/MASTER',
  finished:    'FINISHED',
  in_pipeline: 'IN PIPELINE',
  released:    'RELEASED',
}

// amber for active stages, muted for inactive, green for done/released
const STAGE_COLOR: Record<WorkflowStage, string> = {
  start:       '#4a3e28',
  wip:         '#e8961e',
  mix_master:  '#60a5fa',
  finished:    '#4ade80',
  in_pipeline: '#e8961e',
  released:    '#4ade80',
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
        <div className="max-w-7xl mx-auto px-4 sm:px-6 pb-36 md:pb-12">

          {/* ── CATALOG HEADER ── */}
          <div style={{
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            paddingTop: 'clamp(24px, 4vw, 48px)',
            paddingBottom: 16,
            borderBottom: '1px solid var(--border)',
            gap: 16,
          }}>
            <h1 style={{
              fontFamily: 'var(--font-bebas), sans-serif',
              fontSize: 'clamp(48px, 7vw, 80px)',
              lineHeight: 1,
              color: 'var(--text)',
              letterSpacing: '0.01em',
            }}>
              CATALOG
            </h1>

            {/* Stats + new button */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 'clamp(16px, 3vw, 32px)', flexShrink: 0 }}>
              <div style={{ display: 'flex', gap: 'clamp(12px, 2vw, 24px)', alignItems: 'baseline' }}>
                {[
                  { n: stats.total,    label: 'TRACKS'   },
                  { n: stats.wip,      label: 'MIXING'   },
                  { n: stats.finished, label: 'DONE'     },
                  { n: stats.released, label: 'RELEASED' },
                ].map(s => (
                  <div key={s.label} style={{ textAlign: 'right' }}>
                    <div style={{
                      fontFamily: 'var(--font-mono), monospace',
                      fontSize: 'clamp(18px, 2.5vw, 28px)',
                      fontWeight: 700,
                      color: s.n > 0 ? 'var(--accent)' : 'var(--text-muted)',
                      lineHeight: 1,
                    }}>
                      {String(s.n).padStart(2, '0')}
                    </div>
                    <div style={{
                      fontFamily: 'var(--font-mono), monospace',
                      fontSize: 8,
                      letterSpacing: '0.18em',
                      color: 'var(--text-muted)',
                      marginTop: 3,
                    }}>
                      {s.label}
                    </div>
                  </div>
                ))}
              </div>

              <Link
                href="/projects/new"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  background: 'var(--accent)',
                  color: '#0d0b08',
                  fontFamily: 'var(--font-bebas), sans-serif',
                  fontSize: 14,
                  letterSpacing: '0.15em',
                  padding: '10px 16px',
                  textDecoration: 'none',
                  flexShrink: 0,
                  transition: 'background 0.15s',
                }}
                onMouseOver={e => (e.currentTarget.style.background = 'var(--accent-hover)')}
                onMouseOut={e => (e.currentTarget.style.background = 'var(--accent)')}
              >
                <Plus size={13} strokeWidth={2.5} />
                <span className="hidden sm:inline">NEW TRACK</span>
                <span className="sm:hidden">NEW</span>
              </Link>
            </div>
          </div>

          {/* ── MAIN CONTENT ── */}
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_260px] gap-0 lg:gap-8 mt-0">

            {/* ── TRACK LIST ── */}
            <div>
              {projects.length === 0 ? (
                /* Empty state */
                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '80px 0',
                  gap: 16,
                }}>
                  <Music size={28} style={{ color: 'var(--text-muted)', opacity: 0.4 }} />
                  <div style={{
                    fontFamily: 'var(--font-mono), monospace',
                    fontSize: 11,
                    letterSpacing: '0.15em',
                    color: 'var(--text-muted)',
                    textTransform: 'uppercase',
                  }}>
                    No tracks yet
                  </div>
                  <Link
                    href="/projects/new"
                    style={{
                      fontFamily: 'var(--font-mono), monospace',
                      fontSize: 10,
                      letterSpacing: '0.15em',
                      color: 'var(--accent)',
                      textDecoration: 'none',
                      textTransform: 'uppercase',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    <Plus size={11} />
                    Add first track
                  </Link>
                </div>
              ) : (
                projects.map((project, idx) => {
                  const versions: { status: string }[] = project.mb_versions ?? []
                  const releases: { id: string }[] = project.mb_releases ?? []
                  const stage = getWorkflowStage(versions, releases)
                  const stageColor = STAGE_COLOR[stage]
                  const catalogNum = String(idx + 1).padStart(2, '0')

                  return (
                    <div
                      key={project.id}
                      className="group"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 'clamp(10px, 2vw, 20px)',
                        borderBottom: '1px solid var(--border)',
                        padding: 'clamp(10px, 1.5vw, 16px) 0',
                        position: 'relative',
                        transition: 'background 0.15s',
                      }}
                    >
                      {/* Amber left hover accent */}
                      <div style={{
                        position: 'absolute',
                        left: -16,
                        top: 0,
                        bottom: 0,
                        width: 3,
                        background: 'var(--accent)',
                        opacity: 0,
                        transition: 'opacity 0.15s',
                      }} className="group-hover:opacity-100" />

                      {/* Catalog number */}
                      <div style={{
                        fontFamily: 'var(--font-mono), monospace',
                        fontSize: 11,
                        color: 'var(--text-muted)',
                        flexShrink: 0,
                        width: 22,
                        textAlign: 'right',
                      }}>
                        {catalogNum}
                      </div>

                      {/* Artwork thumbnail */}
                      <Link href={`/projects/${project.id}`} style={{ flexShrink: 0 }}>
                        <div style={{
                          width: 'clamp(40px, 6vw, 52px)',
                          height: 'clamp(40px, 6vw, 52px)',
                          background: 'var(--surface-2)',
                          overflow: 'hidden',
                          position: 'relative',
                          flexShrink: 0,
                        }}>
                          {project.artwork_url ? (
                            <Image
                              src={project.artwork_url}
                              alt={project.title}
                              fill
                              className="object-cover transition-transform duration-300 group-hover:scale-105"
                            />
                          ) : (
                            <div style={{
                              width: '100%', height: '100%',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                            }}>
                              <Music size={16} style={{ color: 'var(--text-muted)', opacity: 0.4 }} />
                            </div>
                          )}
                        </div>
                      </Link>

                      {/* Title + meta */}
                      <Link
                        href={`/projects/${project.id}`}
                        style={{ flex: 1, minWidth: 0, textDecoration: 'none' }}
                      >
                        <div style={{
                          fontFamily: 'var(--font-bebas), sans-serif',
                          fontSize: 'clamp(16px, 2.2vw, 22px)',
                          color: 'var(--text)',
                          letterSpacing: '0.02em',
                          lineHeight: 1.1,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          transition: 'color 0.15s',
                        }} className="group-hover:text-[var(--accent)]">
                          {project.title.toUpperCase()}
                        </div>
                        <div style={{
                          display: 'flex',
                          gap: 10,
                          marginTop: 4,
                          alignItems: 'center',
                          flexWrap: 'wrap',
                        }}>
                          {project.genre && (
                            <span style={{
                              fontFamily: 'var(--font-mono), monospace',
                              fontSize: 9,
                              letterSpacing: '0.12em',
                              color: 'var(--text-muted)',
                              textTransform: 'uppercase',
                            }}>
                              {project.genre}
                            </span>
                          )}
                          {project.bpm && (
                            <span style={{
                              fontFamily: 'var(--font-mono), monospace',
                              fontSize: 9,
                              letterSpacing: '0.12em',
                              color: 'var(--text-muted)',
                            }}>
                              {project.bpm} BPM
                            </span>
                          )}
                        </div>
                      </Link>

                      {/* Version count — hide on small mobile */}
                      <div className="hidden sm:block" style={{
                        fontFamily: 'var(--font-mono), monospace',
                        fontSize: 10,
                        letterSpacing: '0.1em',
                        color: 'var(--text-muted)',
                        flexShrink: 0,
                        width: 28,
                        textAlign: 'center',
                      }}>
                        V{versions.length}
                      </div>

                      {/* Stage label — hide on small mobile */}
                      <div className="hidden sm:block" style={{
                        fontFamily: 'var(--font-mono), monospace',
                        fontSize: 9,
                        letterSpacing: '0.14em',
                        color: stageColor,
                        flexShrink: 0,
                        width: 88,
                        textAlign: 'right',
                      }}>
                        {STAGE_LABEL[stage]}
                      </div>

                      {/* Actions */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
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
                })
              )}
            </div>

            {/* Activity feed sidebar */}
            <div className="hidden lg:block pt-2">
              <ActivityFeed activity={activity} projects={projects} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
