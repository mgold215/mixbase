'use client'
import { useState, useEffect, useCallback } from 'react'
import { Plus, Trash2, RefreshCw } from 'lucide-react'

type AdminUser = {
  id: string
  email: string
  created_at: string
  subscription_tier: string
  artwork_used: number
  video_used: number
}

const TIERS = ['free', 'pro', 'studio', 'admin'] as const
const TIER_COLORS: Record<string, string> = {
  free: '#555', pro: '#2dd4bf', studio: '#a78bfa', admin: '#f59e0b',
}

export default function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newEmail, setNewEmail] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newTier, setNewTier] = useState<string>('free')
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const res = await fetch('/api/admin/users')
    if (res.ok) setUsers(await res.json())
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  async function changeTier(userId: string, tier: string) {
    await fetch(`/api/admin/users/${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier }),
    })
    setUsers(prev => prev.map(u => u.id === userId ? { ...u, subscription_tier: tier } : u))
  }

  async function resetUsage(userId: string) {
    await fetch(`/api/admin/users/${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resetUsage: true }),
    })
    setUsers(prev => prev.map(u => u.id === userId ? { ...u, artwork_used: 0, video_used: 0 } : u))
  }

  async function deleteUser(userId: string, email: string) {
    if (!confirm(`Delete account for ${email}? This cannot be undone.`)) return
    await fetch(`/api/admin/users/${userId}`, { method: 'DELETE' })
    setUsers(prev => prev.filter(u => u.id !== userId))
  }

  async function createUser(e: React.FormEvent) {
    e.preventDefault()
    setCreating(true)
    setError(null)
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: newEmail, password: newPassword, tier: newTier }),
    })
    if (res.ok) {
      setShowCreate(false)
      setNewEmail('')
      setNewPassword('')
      setNewTier('free')
      load()
    } else {
      const d = await res.json()
      setError(d.error ?? 'Failed to create user')
    }
    setCreating(false)
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          {loading ? 'Loading…' : `${users.length} accounts`}
        </p>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg transition-colors"
          style={{ background: '#2dd4bf', color: '#0a0a0a' }}
        >
          <Plus size={13} /> New User
        </button>
      </div>

      {/* Create modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <form
            onSubmit={createUser}
            className="rounded-2xl p-6 w-full max-w-sm space-y-4"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
          >
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>New User</h2>
            <input
              type="email"
              placeholder="Email"
              value={newEmail}
              onChange={e => setNewEmail(e.target.value)}
              required
              className="w-full text-sm px-3 py-2 rounded-lg outline-none"
              style={{ background: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
            />
            <input
              type="password"
              placeholder="Password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              required
              className="w-full text-sm px-3 py-2 rounded-lg outline-none"
              style={{ background: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
            />
            <select
              value={newTier}
              onChange={e => setNewTier(e.target.value)}
              className="w-full text-sm px-3 py-2 rounded-lg outline-none"
              style={{ background: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
            >
              {TIERS.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            {error && <p className="text-xs text-red-400">{error}</p>}
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="px-4 py-2 text-sm rounded-lg"
                style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={creating}
                className="px-4 py-2 text-sm font-medium rounded-lg disabled:opacity-40"
                style={{ background: '#2dd4bf', color: '#0a0a0a' }}
              >
                {creating ? 'Creating…' : 'Create'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Users table */}
      <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
        <table className="w-full text-sm">
          <thead>
            <tr style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
              <th className="text-left px-4 py-3 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Email</th>
              <th className="text-left px-4 py-3 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Tier</th>
              <th className="text-left px-4 py-3 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Artwork</th>
              <th className="text-left px-4 py-3 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Joined</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {users.map((u, i) => (
              <tr
                key={u.id}
                style={{
                  background: i % 2 === 0 ? 'var(--surface)' : 'var(--surface-2)',
                  borderBottom: '1px solid var(--border)',
                }}
              >
                <td className="px-4 py-3" style={{ color: 'var(--text)' }}>{u.email}</td>
                <td className="px-4 py-3">
                  <select
                    value={u.subscription_tier}
                    onChange={e => changeTier(u.id, e.target.value)}
                    className="text-xs font-medium px-2 py-1 rounded-lg outline-none"
                    style={{
                      background: (TIER_COLORS[u.subscription_tier] ?? '#555') + '22',
                      color: TIER_COLORS[u.subscription_tier] ?? 'var(--text)',
                      border: 'none',
                    }}
                  >
                    {TIERS.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </td>
                <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                  {u.artwork_used} used
                </td>
                <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                  {new Date(u.created_at).toLocaleDateString()}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2 justify-end">
                    <button
                      onClick={() => resetUsage(u.id)}
                      title="Reset this month's usage"
                      className="p-1.5 rounded-lg transition-colors hover:opacity-80"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      <RefreshCw size={13} />
                    </button>
                    <button
                      onClick={() => deleteUser(u.id, u.email)}
                      title="Delete account"
                      className="p-1.5 rounded-lg transition-colors hover:opacity-80"
                      style={{ color: '#f87171' }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
