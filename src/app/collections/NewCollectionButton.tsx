'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus } from 'lucide-react'

type CollectionType = 'playlist' | 'ep' | 'album'

export default function NewCollectionButton() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [type, setType] = useState<CollectionType>('playlist')
  const [saving, setSaving] = useState(false)

  async function handleCreate() {
    if (!title.trim() || saving) return
    setSaving(true)
    const res = await fetch('/api/collections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title.trim(), type }),
    })
    if (res.ok) {
      const data = await res.json()
      router.push(`/collections/${data.id}`)
    }
    setSaving(false)
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-colors"
        style={{ backgroundColor: 'var(--accent)', color: 'var(--bg-page)' }}
      >
        <Plus size={16} />
        New Collection
      </button>
    )
  }

  return (
    <div className="flex items-center gap-2 flex-wrap justify-end">
      <input
        autoFocus
        type="text"
        value={title}
        onChange={e => setTitle(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setOpen(false) }}
        placeholder="Collection name…"
        className="px-3 py-1.5 rounded-lg text-sm outline-none"
        style={{ backgroundColor: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--surface-2)', minWidth: 160 }}
      />
      <div className="flex gap-1">
        {(['playlist', 'ep', 'album'] as CollectionType[]).map(t => (
          <button
            key={t}
            onClick={() => setType(t)}
            className="px-2.5 py-1.5 rounded-lg text-xs font-medium capitalize transition-colors"
            style={type === t
              ? { backgroundColor: 'var(--accent)', color: 'var(--bg-page)' }
              : { backgroundColor: 'var(--surface)', color: 'var(--text-muted)', border: '1px solid var(--surface-2)' }
            }
          >
            {t}
          </button>
        ))}
      </div>
      <button
        onClick={handleCreate}
        disabled={!title.trim() || saving}
        className="px-3 py-1.5 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors"
        style={{ backgroundColor: 'var(--accent)', color: 'var(--bg-page)' }}
      >
        {saving ? 'Creating…' : 'Create'}
      </button>
      <button
        onClick={() => { setOpen(false); setTitle('') }}
        className="px-3 py-1.5 rounded-lg text-sm transition-colors"
        style={{ color: 'var(--text-muted)' }}
      >
        Cancel
      </button>
    </div>
  )
}
