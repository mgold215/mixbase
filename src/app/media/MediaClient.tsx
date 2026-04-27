'use client'

import { useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { Check, X, ExternalLink } from 'lucide-react'

type Project = { id: string; title: string; artwork_url: string | null }
type Collection = { id: string; title: string; type: string }

type Props = {
  projects: Project[]
  collections: Collection[]
}

type AssignTarget = { type: 'collection'; id: string; title: string } | { type: 'track'; id: string; title: string }

const TYPE_LABEL: Record<string, string> = { album: 'Album', ep: 'EP', playlist: 'Playlist' }

export default function MediaClient({ projects, collections }: Props) {
  const [selected, setSelected] = useState<Project | null>(null)
  const [assigning, setAssigning] = useState(false)
  const [assigned, setAssigned] = useState<string | null>(null)

  async function assignToCollection(collectionId: string) {
    if (!selected?.artwork_url) return
    setAssigning(true)
    const res = await fetch(`/api/collections/${collectionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cover_url: selected.artwork_url }),
    })
    if (res.ok) {
      setAssigned(collectionId)
      setTimeout(() => setAssigned(null), 1500)
    }
    setAssigning(false)
  }

  async function assignToTrack(projectId: string) {
    if (!selected?.artwork_url) return
    setAssigning(true)
    const res = await fetch(`/api/projects/${projectId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ artwork_url: selected.artwork_url }),
    })
    if (res.ok) {
      setAssigned(projectId)
      setTimeout(() => setAssigned(null), 1500)
    }
    setAssigning(false)
  }

  return (
    <div className="min-h-screen pb-36 md:pb-12" style={{ backgroundColor: 'var(--bg-page)' }}>
      <div className="max-w-5xl mx-auto px-4 sm:px-6 pt-16 sm:pt-20">
        <div className="pt-4 mb-6">
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text)' }}>Media Library</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
            All generated artwork — click any image to assign it to a track or collection.
          </p>
        </div>

        <div className="flex gap-6">
          {/* Grid */}
          <div className="flex-1 min-w-0">
            {projects.length === 0 ? (
              <p className="py-16 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                No artwork yet. Generate some from a project page.
              </p>
            ) : (
              <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 gap-2">
                {projects.map(p => (
                  <button
                    key={p.id}
                    onClick={() => setSelected(selected?.id === p.id ? null : p)}
                    className="relative aspect-square rounded-xl overflow-hidden group transition-transform hover:scale-[1.03]"
                    style={{
                      backgroundColor: 'var(--surface-2)',
                      outline: selected?.id === p.id ? '2px solid var(--accent)' : '2px solid transparent',
                      outlineOffset: 2,
                    }}
                  >
                    {p.artwork_url && (
                      <Image src={p.artwork_url} alt={p.title} fill className="object-cover" unoptimized />
                    )}
                    {/* Title overlay on hover */}
                    <div className="absolute inset-0 bg-black/60 flex items-end p-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <p className="text-[11px] text-white font-medium leading-tight text-left line-clamp-2">{p.title}</p>
                    </div>
                    {/* Selected check */}
                    {selected?.id === p.id && (
                      <div
                        className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full flex items-center justify-center"
                        style={{ backgroundColor: 'var(--accent)' }}
                      >
                        <Check size={11} className="text-black" strokeWidth={3} />
                      </div>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Assignment panel — shows when image is selected */}
          {selected && (
            <div
              className="w-56 flex-shrink-0 rounded-xl overflow-hidden h-fit sticky top-20"
              style={{ border: '1px solid var(--surface-2)', backgroundColor: 'var(--surface)' }}
            >
              {/* Preview */}
              <div className="aspect-square relative">
                {selected.artwork_url && (
                  <Image src={selected.artwork_url} alt={selected.title} fill className="object-cover" unoptimized />
                )}
                <button
                  onClick={() => setSelected(null)}
                  className="absolute top-2 right-2 w-6 h-6 rounded-full bg-black/60 flex items-center justify-center"
                >
                  <X size={12} className="text-white" />
                </button>
              </div>

              <div className="p-3">
                <p className="text-sm font-medium truncate mb-3" style={{ color: 'var(--text)' }}>{selected.title}</p>
                <Link
                  href={`/projects/${selected.id}`}
                  className="flex items-center gap-1.5 text-xs mb-4 transition-colors"
                  style={{ color: 'var(--text-muted)' }}
                >
                  <ExternalLink size={11} />
                  Open project
                </Link>

                {/* Assign to collection */}
                {collections.length > 0 && (
                  <>
                    <p className="text-[10px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-muted)' }}>
                      Set as collection cover
                    </p>
                    <div className="space-y-0.5 mb-4">
                      {collections.map(c => (
                        <button
                          key={c.id}
                          onClick={() => assignToCollection(c.id)}
                          disabled={assigning}
                          className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-left transition-colors hover:bg-white/5 disabled:opacity-50 text-xs"
                          style={{ color: 'var(--text)' }}
                        >
                          <span className="truncate flex-1 mr-1">{c.title}</span>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <span style={{ color: 'var(--text-muted)' }}>{TYPE_LABEL[c.type] ?? c.type}</span>
                            {assigned === c.id && <Check size={11} style={{ color: 'var(--accent)' }} />}
                          </div>
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {/* Assign to another track */}
                {projects.filter(p => p.id !== selected.id).length > 0 && (
                  <>
                    <p className="text-[10px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-muted)' }}>
                      Set as track artwork
                    </p>
                    <div className="space-y-0.5">
                      {projects.filter(p => p.id !== selected.id).map(p => (
                        <button
                          key={p.id}
                          onClick={() => assignToTrack(p.id)}
                          disabled={assigning}
                          className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-left transition-colors hover:bg-white/5 disabled:opacity-50 text-xs"
                          style={{ color: 'var(--text)' }}
                        >
                          <span className="truncate flex-1 mr-1">{p.title}</span>
                          {assigned === p.id && <Check size={11} style={{ color: 'var(--accent)' }} />}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
