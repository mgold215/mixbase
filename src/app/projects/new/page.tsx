'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import Nav from '@/components/Nav'
import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'

const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
               'Cm', 'C#m', 'Dm', 'D#m', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'A#m', 'Bm']

export default function NewProjectPage() {
  const router = useRouter()
  const [form, setForm] = useState({ title: '', genre: '', bpm: '', key_signature: '' })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  function set(field: string, value: string) {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!form.title.trim()) return
    setLoading(true)
    setError('')

    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: form.title,
        genre: form.genre || null,
        bpm: form.bpm ? parseInt(form.bpm) : null,
        key_signature: form.key_signature || null,
      }),
    })

    const data = await res.json()
    if (res.ok) {
      router.push(`/projects/${data.id}`)
    } else {
      setError(data.error ?? 'Something went wrong')
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen" style={{ backgroundColor: 'var(--bg-page)' }}>
      <Nav />
      <div className="pt-14">
        <div className="max-w-lg mx-auto px-6 py-12">
          <Link href="/dashboard" className="flex items-center gap-2 text-sm mb-8 transition-colors w-fit"
            style={{ color: 'var(--text-muted)' }}>
            <ArrowLeft size={14} />
            Back
          </Link>

          <h1 className="text-2xl font-bold mb-1" style={{ color: 'var(--text)' }}>New Project</h1>
          <p className="text-sm mb-8" style={{ color: 'var(--text-muted)' }}>Add a track to start tracking your mix versions</p>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>Track Title <span style={{ color: 'var(--accent)' }}>*</span></label>
              <input
                type="text"
                value={form.title}
                onChange={e => set('title', e.target.value)}
                placeholder="e.g. After Dark"
                autoFocus
                className="w-full rounded-xl px-4 py-3 focus:outline-none transition-colors"
                style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>Genre</label>
                <input
                  type="text"
                  value={form.genre}
                  onChange={e => set('genre', e.target.value)}
                  placeholder="e.g. R&B, Afrobeat"
                  className="w-full rounded-xl px-4 py-3 focus:outline-none transition-colors"
                  style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
                />
              </div>
              <div>
                <label className="block text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>BPM</label>
                <input
                  type="number"
                  value={form.bpm}
                  onChange={e => set('bpm', e.target.value)}
                  placeholder="e.g. 98"
                  min={40}
                  max={300}
                  className="w-full rounded-xl px-4 py-3 focus:outline-none transition-colors"
                  style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
                />
              </div>
            </div>

            <div>
              <label className="block text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>Key</label>
              <select
                value={form.key_signature}
                onChange={e => set('key_signature', e.target.value)}
                className="w-full rounded-xl px-4 py-3 focus:outline-none appearance-none transition-colors"
                style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
              >
                <option value="" style={{ backgroundColor: 'var(--input-bg)' }}>Select key</option>
                {KEYS.map(k => (
                  <option key={k} value={k} style={{ backgroundColor: 'var(--input-bg)' }}>{k}</option>
                ))}
              </select>
            </div>

            {error && <p className="text-red-400 text-sm">{error}</p>}

            <button
              type="submit"
              disabled={loading || !form.title.trim()}
              className="w-full font-semibold rounded-xl py-3 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ backgroundColor: 'var(--accent)', color: 'var(--bg)' }}
            >
              {loading ? 'Creating...' : 'Create Project'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
