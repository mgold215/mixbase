'use client'

import { useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { Music } from 'lucide-react'
import DashPlayButton from '@/components/DashPlayButton'
import AddToPipelineButton from '@/components/AddToPipelineButton'

type WorkflowStage = 'start' | 'wip' | 'mix_master' | 'finished' | 'in_pipeline' | 'released'

const STAGE_LABEL: Record<WorkflowStage, string> = {
  start:       'No audio',
  wip:         'WIP',
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

const FILTER_ORDER: WorkflowStage[] = ['wip', 'mix_master', 'finished', 'in_pipeline', 'released', 'start']

export type ProjectRow = {
  id: string
  title: string
  artwork_url: string | null
  genre: string | null
  bpm: number | null
  stage: WorkflowStage
  hasRelease: boolean
}

export default function ProjectGrid({ projects }: { projects: ProjectRow[] }) {
  const [activeFilter, setActiveFilter] = useState<WorkflowStage | 'all'>('all')

  const availableStages = new Set(projects.map(p => p.stage))
  const filtered = activeFilter === 'all' ? projects : projects.filter(p => p.stage === activeFilter)
  const showFilters = availableStages.size > 1

  return (
    <div>
      {/* Filter pills — only show when there are multiple distinct stages */}
      {showFilters && (
        <div className="flex gap-2 mb-4 flex-wrap">
          <button
            onClick={() => setActiveFilter('all')}
            style={{
              fontFamily: 'var(--font-mono), monospace',
              fontSize: 10,
              letterSpacing: '0.04em',
              color: activeFilter === 'all' ? 'var(--text)' : 'var(--text-muted)',
              background: activeFilter === 'all' ? 'var(--surface-2)' : 'transparent',
              border: `1px solid ${activeFilter === 'all' ? 'var(--border)' : 'var(--border)'}`,
              borderRadius: 4,
              padding: '3px 10px',
              cursor: 'pointer',
              transition: 'all 0.15s',
              whiteSpace: 'nowrap',
            }}
          >
            All
            <span style={{ opacity: 0.5, marginLeft: 4 }}>{projects.length}</span>
          </button>

          {FILTER_ORDER.filter(s => availableStages.has(s)).map(stage => {
            const isActive = activeFilter === stage
            const count = projects.filter(p => p.stage === stage).length
            return (
              <button
                key={stage}
                onClick={() => setActiveFilter(stage)}
                style={{
                  fontFamily: 'var(--font-mono), monospace',
                  fontSize: 10,
                  letterSpacing: '0.04em',
                  color: isActive ? STAGE_COLOR[stage] : 'var(--text-muted)',
                  background: isActive ? STAGE_BG[stage] : 'transparent',
                  border: `1px solid ${isActive ? STAGE_COLOR[stage] + '66' : 'var(--border)'}`,
                  borderRadius: 4,
                  padding: '3px 10px',
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                  whiteSpace: 'nowrap',
                }}
              >
                {STAGE_LABEL[stage]}
                <span style={{ opacity: 0.5, marginLeft: 4 }}>{count}</span>
              </button>
            )
          })}
        </div>
      )}

      {/* Column headers — desktop only */}
      <div
        className="hidden sm:grid mb-1"
        style={{
          gridTemplateColumns: '44px 1fr 100px 70px',
          gap: 12,
          paddingBottom: 8,
          borderBottom: '1px solid var(--border)',
        }}
      >
        {['', 'Title', 'Stage', ''].map((col, i) => (
          <div key={i} style={{
            fontFamily: 'var(--font-mono), monospace',
            fontSize: 9,
            letterSpacing: '0.14em',
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            textAlign: i >= 2 ? 'right' : 'left',
          }}>
            {col}
          </div>
        ))}
      </div>

      {/* Rows */}
      {filtered.length === 0 ? (
        <div className="text-center py-12" style={{ color: 'var(--text-muted)' }}>
          <p className="text-sm">No projects in this stage</p>
        </div>
      ) : (
        filtered.map(project => {
          const { stage } = project
          return (
            <div
              key={project.id}
              className="group flex items-center gap-3 sm:grid"
              style={{
                gridTemplateColumns: '44px 1fr 100px 70px',
                gap: 12,
                alignItems: 'center',
                borderBottom: '1px solid var(--border)',
                padding: '10px 0',
                position: 'relative',
              }}
            >
              {/* Hover accent */}
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
                <div style={{ width: 44, height: 44, background: 'var(--surface-2)', overflow: 'hidden', position: 'relative', borderRadius: 4 }}>
                  {project.artwork_url ? (
                    <Image src={project.artwork_url} alt={project.title} fill className="object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <Music size={14} style={{ color: 'var(--text-muted)', opacity: 0.4 }} />
                    </div>
                  )}
                </div>
              </Link>

              {/* Title + meta */}
              <Link href={`/projects/${project.id}`} className="flex-1 min-w-0" style={{ textDecoration: 'none' }}>
                <div className="text-sm font-medium truncate" style={{ color: 'var(--text)', lineHeight: 1.3 }}>
                  {project.title}
                </div>
                <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                  {project.genre && (
                    <span style={{ fontFamily: 'var(--font-mono), monospace', fontSize: 10, color: 'var(--text-muted)' }}>
                      {project.genre}
                    </span>
                  )}
                  {project.bpm && (
                    <span style={{ fontFamily: 'var(--font-mono), monospace', fontSize: 10, color: 'var(--text-muted)' }}>
                      {project.bpm} BPM
                    </span>
                  )}
                  {/* Stage badge — mobile only */}
                  {stage !== 'start' && (
                    <span className="sm:hidden" style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      fontFamily: 'var(--font-mono), monospace',
                      fontSize: 9,
                      letterSpacing: '0.04em',
                      color: STAGE_COLOR[stage],
                      background: STAGE_BG[stage],
                      border: `1px solid ${STAGE_COLOR[stage]}50`,
                      borderRadius: 4,
                      padding: '1px 6px',
                      whiteSpace: 'nowrap',
                    }}>
                      {STAGE_LABEL[stage]}
                    </span>
                  )}
                </div>
              </Link>

              {/* Stage pill — desktop */}
              <div className="hidden sm:flex" style={{ justifyContent: 'flex-end', alignItems: 'center' }}>
                {stage === 'start' ? (
                  <span style={{ fontFamily: 'var(--font-mono), monospace', fontSize: 10, color: STAGE_COLOR[stage], opacity: 0.55 }}>
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
                    hasRelease={project.hasRelease}
                  />
                </div>
              </div>
            </div>
          )
        })
      )}
    </div>
  )
}
