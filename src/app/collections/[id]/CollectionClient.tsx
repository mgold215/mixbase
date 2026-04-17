'use client'

import { useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Play, Plus, Trash2, Music, Search, X } from 'lucide-react'
import { usePlayer } from '@/contexts/PlayerContext'

type Collection = { id: string; title: string; type: string }
type CollectionItem = {
  id: string
  collection_id: string
  project_id: string
  position: number
  mb_projects: { title: string; artwork_url: string | null; genre: string | null } | null
}
type Project = { id: string; title: string; artwork_url: string | null }

const TYPE_LABEL: Record<string, string> = { album: 'Album', ep: 'EP', playlist: 'Playlist' }

type Props = {
  collection: Collection
  initialItems: CollectionItem[]
  allProjects: Project[]
}

export default function CollectionClient({ collection, initialItems, allProjects }: Props) {
  const router = useRouter()
  const { playTrack } = usePlayer()
  const [items, setItems] = useState(initialItems)
  const [showPicker, setShowPicker] = useState(false)
  const [search, setSearch] = useState('')
  const [adding, setAdding] = useState<string | null>(null)

  const inCollection = new Set(items.map(i => i.project_id))
  const available = allProjects.filter(
    p => !inCollection.has(p.id) &&
      (!search.trim() || p.title.toLowerCase().includes(search.toLowerCase()))
  )

  async function addProject(projectId: string) {
    setAdding(projectId)
    const res = await fetch(`/api/collections/${collection.id}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, position: items.length }),
    })
    if (res.ok) {
      const newItem = await res.json()
      const project = allProjects.find(p => p.id === projectId)
      setItems(prev => [...prev, {
        ...newItem,
        mb_projects: project
          ? { title: project.title, artwork_url: project.artwork_url, genre: null }
          : null,
      }])
    }
    setAdding(null)
  }

  async function removeItem(itemId: string) {
    const res = await fetch(
      `/api/collections/${collection.id}/items?itemId=${itemId}`,
      { method: 'DELETE' }
    )
    if (res.ok) setItems(prev => prev.filter(i => i.id !== itemId))
  }

  async function deleteCollection() {
    if (!confirm(`Delete "${collection.title}"? This can't be undone.`)) return
    await fetch(`/api/collections/${collection.id}`, { method: 'DELETE' })
    router.push('/collections')
  }

  return (
    <div className="min-h-screen pb-28" style={{ backgroundColor: 'var(--bg-page)' }}>
      <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-16 sm:pt-20">

        {/* Header */}
        <div className="flex items-start gap-3 mb-8 pt-4">
          <Link
            href="/collections"
            className="mt-0.5 p-1.5 rounded-lg transition-colors flex-shrink-0"
            style={{ color: 'var(--text-muted)' }}
          >
            <ArrowLeft size={18} />
          </Link>
          <div className="flex-1 min-w-0">
            <span
              className="inline-block text-xs font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full mb-2"
              style={{ backgroundColor: 'var(--accent-dim)', color: 'var(--accent)' }}
            >
              {TYPE_LABEL[collection.type] ?? collection.type}
            </span>
            <h1 className="text-2xl font-bold" style={{ color: 'var(--text)' }}>{collection.title}</h1>
            <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>
              {items.length} {items.length === 1 ? 'track' : 'tracks'}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0 mt-1">
            {items.length > 0 && (
              <button
                onClick={() => playTrack(items[0].project_id)}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-colors"
                style={{ backgroundColor: 'var(--accent)', color: 'var(--bg-page)' }}
              >
                <Play size={14} fill="currentColor" />
                <span className="hidden sm:inline">Play All</span>
              </button>
            )}
            <button
              onClick={deleteCollection}
              className="p-2 rounded-lg transition-colors"
              style={{ color: 'var(--text-muted)' }}
              title="Delete collection"
            >
              <Trash2 size={16} />
            </button>
          </div>
        </div>

        {/* Track list */}
        <div className="space-y-1 mb-5">
          {items.length === 0 && (
            <p className="py-10 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
              No tracks yet — add some below.
            </p>
          )}
          {items.map((item, idx) => (
            <div
              key={item.id}
              className="flex items-center gap-3 px-3 py-2.5 rounded-xl group transition-colors"
              style={{ backgroundColor: 'var(--surface)' }}
            >
              {/* Track number */}
              <span
                className="w-5 text-right text-xs font-mono flex-shrink-0"
                style={{ color: 'var(--text-muted)' }}
              >
                {idx + 1}
              </span>

              {/* Artwork */}
              <div
                className="w-10 h-10 rounded-lg overflow-hidden flex-shrink-0 relative"
                style={{ backgroundColor: 'var(--surface-2)' }}
              >
                {item.mb_projects?.artwork_url ? (
                  <Image
                    src={item.mb_projects.artwork_url}
                    alt=""
                    fill
                    className="object-cover"
                    unoptimized
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <Music size={14} style={{ color: 'var(--surface-3)' }} />
                  </div>
                )}
              </div>

              {/* Title + genre */}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate" style={{ color: 'var(--text)' }}>
                  {item.mb_projects?.title ?? 'Untitled'}
                </p>
                {item.mb_projects?.genre && (
                  <p className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                    {item.mb_projects.genre}
                  </p>
                )}
              </div>

              {/* Hover actions */}
              <button
                onClick={() => playTrack(item.project_id)}
                className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg transition-all"
                style={{ color: 'var(--accent)' }}
                title="Play"
              >
                <Play size={14} fill="currentColor" />
              </button>
              <Link
                href={`/projects/${item.project_id}`}
                className="opacity-0 group-hover:opacity-100 px-2 py-1 rounded-lg text-xs font-medium transition-all"
                style={{ color: 'var(--text-muted)', backgroundColor: 'var(--surface-2)' }}
              >
                Open
              </Link>
              <button
                onClick={() => removeItem(item.id)}
                className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg transition-all"
                style={{ color: 'var(--text-muted)' }}
                title="Remove"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>

        {/* Add track */}
        {!showPicker ? (
          <button
            onClick={() => setShowPicker(true)}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors"
            style={{ backgroundColor: 'var(--surface)', color: 'var(--text-muted)', border: '1px solid var(--surface-2)' }}
          >
            <Plus size={16} />
            Add Track
          </button>
        ) : (
          <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--surface-2)' }}>
            {/* Search bar */}
            <div
              className="flex items-center gap-2 px-3 py-2.5"
              style={{ backgroundColor: 'var(--surface)' }}
            >
              <Search size={14} style={{ color: 'var(--text-muted)' }} />
              <input
                autoFocus
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search tracks…"
                className="flex-1 bg-transparent text-sm outline-none"
                style={{ color: 'var(--text)' }}
              />
              <button
                onClick={() => { setShowPicker(false); setSearch('') }}
                className="text-xs px-2 py-1 rounded-md transition-colors"
                style={{ color: 'var(--text-muted)' }}
              >
                Done
              </button>
            </div>

            {/* Project list */}
            <div className="max-h-64 overflow-y-auto">
              {available.length === 0 ? (
                <p className="px-4 py-4 text-sm" style={{ color: 'var(--text-muted)' }}>
                  {search ? 'No matches.' : 'All projects are already in this collection.'}
                </p>
              ) : (
                available.map(p => (
                  <button
                    key={p.id}
                    onClick={() => addProject(p.id)}
                    disabled={adding === p.id}
                    className="w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-white/5 disabled:opacity-50"
                    style={{ borderTop: '1px solid var(--surface-2)' }}
                  >
                    <div
                      className="w-8 h-8 rounded-md overflow-hidden flex-shrink-0 relative"
                      style={{ backgroundColor: 'var(--surface-2)' }}
                    >
                      {p.artwork_url ? (
                        <Image src={p.artwork_url} alt="" fill className="object-cover" unoptimized />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <Music size={11} style={{ color: 'var(--surface-3)' }} />
                        </div>
                      )}
                    </div>
                    <span className="flex-1 text-sm truncate" style={{ color: 'var(--text)' }}>{p.title}</span>
                    {adding === p.id && (
                      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Adding…</span>
                    )}
                    {adding !== p.id && (
                      <Plus size={14} style={{ color: 'var(--text-muted)' }} />
                    )}
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
