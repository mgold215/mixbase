'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import Image from 'next/image'
import Link from 'next/link'
import { Check, X, ExternalLink, Download, Film, Trash2 } from 'lucide-react'
import { downloadImage } from '@/lib/download'
import { visualizerKindLabel, availableKinds, filterByKind } from '@/lib/visualizer-kinds'

const Visualizer = dynamic(() => import('@/components/Visualizer'), { ssr: false })

type Project = { id: string; title: string; artwork_url: string | null }
type Collection = { id: string; title: string; type: string }
type VisualizerItem = {
  id: string
  title: string | null
  video_url: string
  project_id: string | null
  kind: string
  created_at: string
}

type Props = {
  projects: Project[]
  collections: Collection[]
  visualizers: VisualizerItem[]
}

const TYPE_LABEL: Record<string, string> = { album: 'Album', ep: 'EP', playlist: 'Playlist' }

export default function MediaClient({ projects, collections, visualizers }: Props) {
  const router = useRouter()
  const [selected, setSelected] = useState<Project | null>(null)
  const [assigning, setAssigning] = useState(false)
  const [assigned, setAssigned] = useState<string | null>(null)
  const [visualizing, setVisualizing] = useState<Project | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [kindFilter, setKindFilter] = useState('all')

  // Kinds actually in the library, for the filter chips. Only worth showing
  // when there's more than one kind to choose between.
  const kinds = availableKinds(visualizers)
  // If the active filter's last video was just deleted (its chip is gone),
  // fall back to "all" so the grid never strands on an empty, chip-less filter.
  const activeKind = kindFilter !== 'all' && !kinds.includes(kindFilter) ? 'all' : kindFilter
  const shownVisualizers = filterByKind(visualizers, activeKind)

  async function deleteVisualizer(id: string) {
    // Deleting removes the video and unpins it from any project — confirm first,
    // matching the confirmation on project/collection/release deletes.
    if (!confirm('Delete this visualizer? It will be removed from any project it is pinned to. This cannot be undone.')) return
    setDeleting(id)
    try {
      const res = await fetch(`/api/visualizer/${id}`, { method: 'DELETE' })
      if (res.ok) router.refresh()
      else alert('Could not delete the visualizer — please try again.')
    } catch {
      alert('Could not delete the visualizer — check your connection.')
    } finally {
      setDeleting(null)
    }
  }

  // Pull in any newly generated video after the modal closes.
  function closeVisualizer() {
    setVisualizing(null)
    router.refresh()
  }

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
            All generated artwork and visualizers — click any image to assign it, or make a video from it.
          </p>
        </div>

        {/* Visualizers — every saved video the user owns (canvas + AI loops,
            plus finished YouTube/Shorts renders since PR #42) */}
        {visualizers.length > 0 && (
          <div className="mb-10">
            <h2 className="text-sm font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>
              Visualizers
            </h2>
            {/* Kind filter — only when there's more than one kind to sort */}
            {kinds.length > 1 && (
              <div className="flex flex-wrap gap-2 mb-3">
                {(['all', ...kinds]).map(k => {
                  const isActive = activeKind === k
                  const count = k === 'all' ? visualizers.length : visualizers.filter(v => v.kind === k).length
                  return (
                    <button
                      key={k}
                      onClick={() => setKindFilter(k)}
                      className="text-xs px-3 py-1 rounded-full border transition-colors"
                      style={{
                        borderColor: isActive ? 'var(--accent)' : 'var(--border)',
                        backgroundColor: isActive ? 'var(--accent)' : 'transparent',
                        color: isActive ? 'var(--bg-page)' : 'var(--text-muted)',
                      }}
                    >
                      {k === 'all' ? 'All' : visualizerKindLabel(k)} <span className="opacity-70">{count}</span>
                    </button>
                  )
                })}
              </div>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {shownVisualizers.map(v => (
                <div
                  key={v.id}
                  className="rounded-xl overflow-hidden"
                  style={{ border: '1px solid var(--surface-2)', backgroundColor: 'var(--surface)' }}
                >
                  <video
                    src={v.video_url}
                    controls
                    loop
                    muted
                    playsInline
                    preload="metadata"
                    className="w-full aspect-square object-cover bg-black"
                  />
                  <div className="p-2.5">
                    <p className="text-xs font-medium truncate" style={{ color: 'var(--text)' }}>
                      {v.title || 'Visualizer'}
                    </p>
                    <p className="text-[10px] mb-2" style={{ color: 'var(--text-muted)' }}>
                      {visualizerKindLabel(v.kind)}
                    </p>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => downloadImage(v.video_url, v.title || 'visualizer')}
                        className="flex-1 flex items-center justify-center gap-1 text-[11px] font-medium py-1.5 rounded-lg transition-colors"
                        style={{ backgroundColor: 'var(--surface-2)', color: 'var(--text)' }}
                      >
                        <Download size={11} />
                        Download
                      </button>
                      {v.project_id && (
                        <Link
                          href={`/projects/${v.project_id}`}
                          className="flex items-center justify-center px-2 py-1.5 rounded-lg transition-colors"
                          style={{ backgroundColor: 'var(--surface-2)', color: 'var(--text-muted)' }}
                          aria-label="Open project"
                        >
                          <ExternalLink size={12} />
                        </Link>
                      )}
                      <button
                        onClick={() => deleteVisualizer(v.id)}
                        disabled={deleting === v.id}
                        className="flex items-center justify-center px-2 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                        style={{ backgroundColor: 'var(--surface-2)', color: '#f87171' }}
                        aria-label="Delete visualizer"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex gap-6">
          {/* Grid */}
          <div className="flex-1 min-w-0">
            {visualizers.length > 0 && projects.length > 0 && (
              <h2 className="text-sm font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>
                Artwork
              </h2>
            )}
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
              className="w-56 flex-shrink-0 rounded-xl overflow-hidden h-fit sticky top-14"
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
                  className="flex items-center gap-1.5 text-xs mb-3 transition-colors"
                  style={{ color: 'var(--text-muted)' }}
                >
                  <ExternalLink size={11} />
                  Open project
                </Link>
                {selected.artwork_url && (
                  <>
                    <button
                      onClick={() => setVisualizing(selected)}
                      className="w-full flex items-center justify-center gap-1.5 text-xs font-medium py-1.5 rounded-lg mb-2 transition-colors"
                      style={{ backgroundColor: 'var(--accent)', color: 'var(--bg-page)' }}
                    >
                      <Film size={12} />
                      Make visualizer
                    </button>
                    <button
                      onClick={() => downloadImage(selected.artwork_url!, selected.title)}
                      className="w-full flex items-center justify-center gap-1.5 text-xs font-medium py-1.5 rounded-lg mb-4 transition-colors"
                      style={{ backgroundColor: 'var(--surface-2)', color: 'var(--text)' }}
                    >
                      <Download size={12} />
                      Download
                    </button>
                  </>
                )}

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

      {/* Visualizer modal — animate the selected photo into a video */}
      {visualizing && visualizing.artwork_url && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8"
          style={{ backgroundColor: 'rgba(0,0,0,0.7)' }}
          onClick={closeVisualizer}
        >
          <div
            className="w-full max-w-2xl rounded-2xl my-8"
            style={{ backgroundColor: 'var(--bg-page)', border: '1px solid var(--surface-2)' }}
            onClick={e => e.stopPropagation()}
          >
            <div
              className="flex items-center justify-between px-5 py-3 sticky top-0 rounded-t-2xl"
              style={{ backgroundColor: 'var(--bg-page)', borderBottom: '1px solid var(--surface-2)' }}
            >
              <div className="flex items-center gap-2">
                <Film size={16} style={{ color: 'var(--accent)' }} />
                <p className="text-sm font-semibold" style={{ color: 'var(--text)' }}>Make Visualizer</p>
              </div>
              <button
                onClick={closeVisualizer}
                className="w-7 h-7 rounded-full flex items-center justify-center transition-colors hover:bg-white/10"
                style={{ color: 'var(--text-muted)' }}
                aria-label="Close"
              >
                <X size={15} />
              </button>
            </div>
            <div className="p-5">
              <Visualizer
                projectId={visualizing.id}
                projectTitle={visualizing.title}
                artworkUrl={visualizing.artwork_url}
                onSwitchToArtwork={closeVisualizer}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
