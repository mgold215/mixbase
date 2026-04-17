'use client'

import { useState, useRef, useEffect } from 'react'
import { FolderPlus, Check, Plus, ChevronRight } from 'lucide-react'

type Collection = { id: string; title: string; type: string }

type Props = { projectId: string }

const TYPE_SHORT: Record<string, string> = { album: 'Album', ep: 'EP', playlist: 'Playlist' }

export default function AddToCollectionButton({ projectId }: Props) {
  const [open, setOpen] = useState(false)
  const [collections, setCollections] = useState<Collection[]>([])
  const [loading, setLoading] = useState(false)
  const [added, setAdded] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newType, setNewType] = useState<'playlist' | 'ep' | 'album'>('playlist')
  const [saving, setSaving] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false)
        setCreating(false)
        setNewTitle('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  async function openPanel() {
    setOpen(true)
    setLoading(true)
    const res = await fetch('/api/collections')
    if (res.ok) setCollections(await res.json())
    setLoading(false)
  }

  async function addToCollection(collectionId: string) {
    const res = await fetch(`/api/collections/${collectionId}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, position: 999 }),
    })
    if (res.ok) {
      setAdded(collectionId)
      setTimeout(() => { setAdded(null); setOpen(false) }, 1000)
    }
  }

  async function createAndAdd() {
    if (!newTitle.trim() || saving) return
    setSaving(true)
    const res = await fetch('/api/collections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle.trim(), type: newType }),
    })
    if (res.ok) {
      const col = await res.json()
      setCollections(prev => [col, ...prev])
      await addToCollection(col.id)
      setCreating(false)
      setNewTitle('')
    }
    setSaving(false)
  }

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={open ? () => setOpen(false) : openPanel}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors"
        style={open
          ? { backgroundColor: 'var(--surface)', color: 'var(--accent)', border: '1px solid var(--accent)' }
          : { backgroundColor: 'var(--surface)', color: 'var(--text-muted)', border: '1px solid var(--surface-2)' }
        }
        title="Add to collection"
      >
        <FolderPlus size={14} />
        <span className="hidden sm:inline">Add to</span>
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1.5 w-60 rounded-xl overflow-hidden shadow-2xl z-50"
          style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--surface-2)' }}
        >
          {loading ? (
            <p className="px-4 py-3 text-sm" style={{ color: 'var(--text-muted)' }}>Loading…</p>
          ) : creating ? (
            <div className="p-3 space-y-2">
              <input
                autoFocus
                type="text"
                value={newTitle}
                onChange={e => setNewTitle(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') createAndAdd(); if (e.key === 'Escape') setCreating(false) }}
                placeholder="Collection name…"
                className="w-full px-2.5 py-1.5 rounded-lg text-sm outline-none"
                style={{ backgroundColor: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--surface-3)' }}
              />
              <div className="flex gap-1">
                {(['playlist', 'ep', 'album'] as const).map(t => (
                  <button
                    key={t}
                    onClick={() => setNewType(t)}
                    className="flex-1 py-1 rounded-md text-[11px] font-medium capitalize transition-colors"
                    style={newType === t
                      ? { backgroundColor: 'var(--accent)', color: 'var(--bg-page)' }
                      : { backgroundColor: 'var(--surface-3)', color: 'var(--text-muted)' }
                    }
                  >
                    {t}
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={createAndAdd}
                  disabled={!newTitle.trim() || saving}
                  className="flex-1 py-1.5 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors"
                  style={{ backgroundColor: 'var(--accent)', color: 'var(--bg-page)' }}
                >
                  {saving ? 'Creating…' : 'Create & Add'}
                </button>
                <button
                  onClick={() => { setCreating(false); setNewTitle('') }}
                  className="px-3 py-1.5 rounded-lg text-sm transition-colors"
                  style={{ color: 'var(--text-muted)' }}
                >
                  Back
                </button>
              </div>
            </div>
          ) : (
            <>
              {collections.length === 0 && (
                <p className="px-4 py-3 text-sm" style={{ color: 'var(--text-muted)' }}>No collections yet.</p>
              )}
              {collections.map(c => (
                <button
                  key={c.id}
                  onClick={() => addToCollection(c.id)}
                  className="w-full flex items-center justify-between px-4 py-2.5 text-left transition-colors hover:bg-white/5"
                  style={{ borderBottom: '1px solid var(--surface-2)' }}
                >
                  <span className="text-sm truncate flex-1 mr-2" style={{ color: 'var(--text)' }}>{c.title}</span>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{TYPE_SHORT[c.type] ?? c.type}</span>
                    {added === c.id
                      ? <Check size={13} style={{ color: 'var(--accent)' }} />
                      : <ChevronRight size={13} style={{ color: 'var(--surface-3)' }} />
                    }
                  </div>
                </button>
              ))}
              <button
                onClick={() => setCreating(true)}
                className="w-full flex items-center gap-2 px-4 py-2.5 text-sm transition-colors hover:bg-white/5"
                style={{ color: 'var(--accent)' }}
              >
                <Plus size={14} />
                New collection
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
