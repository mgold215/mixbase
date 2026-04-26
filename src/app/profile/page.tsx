'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Nav from '@/components/Nav'
import { LogOut, Trash2, ArrowLeft } from 'lucide-react'
import Link from 'next/link'

export default function ProfilePage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(true)
  const [showDelete, setShowDelete] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    // Fetch user info from a lightweight API
    fetch('/api/auth/me')
      .then(r => r.json())
      .then(data => {
        setEmail(data.email ?? '')
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  async function handleDeleteAccount() {
    if (deleteConfirm !== 'DELETE') return
    setDeleting(true)
    setError('')

    const res = await fetch('/api/auth/delete-account', { method: 'POST' })
    if (res.ok) {
      router.push('/login')
    } else {
      const body = await res.json().catch(() => ({}))
      setError(body.error ?? 'Failed to delete account')
      setDeleting(false)
    }
  }

  return (
    <div className="min-h-screen" style={{ backgroundColor: 'var(--bg-page)' }}>
      <Nav />
      <div className="max-w-lg mx-auto px-5 pt-20 pb-36 md:pb-10">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1 text-sm mb-6 transition-colors"
          style={{ color: 'var(--text-muted)' }}
        >
          <ArrowLeft size={14} />
          Back
        </Link>

        <h1 className="text-xl font-semibold mb-6" style={{ color: 'var(--text)' }}>Account</h1>

        {loading ? (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading...</p>
        ) : (
          <div className="space-y-6">
            {/* Email display */}
            <div
              className="rounded-xl p-5"
              style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
            >
              <label className="block text-xs uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-muted)' }}>
                Email
              </label>
              <p className="text-sm" style={{ color: 'var(--text)' }}>{email}</p>
            </div>

            {/* Danger zone */}
            <div
              className="rounded-xl p-5"
              style={{ backgroundColor: 'var(--surface)', border: '1px solid rgba(239, 68, 68, 0.2)' }}
            >
              <h2 className="text-sm font-semibold mb-1" style={{ color: '#ef4444' }}>Danger Zone</h2>
              <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
                Permanently delete your account and all data. This cannot be undone.
              </p>

              {!showDelete ? (
                <button
                  onClick={() => setShowDelete(true)}
                  className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg transition-colors"
                  style={{ color: '#ef4444', border: '1px solid rgba(239, 68, 68, 0.3)' }}
                >
                  <Trash2 size={14} />
                  Delete Account
                </button>
              ) : (
                <div className="space-y-3">
                  <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    Type <strong style={{ color: '#ef4444' }}>DELETE</strong> to confirm:
                  </p>
                  <input
                    type="text"
                    value={deleteConfirm}
                    onChange={e => setDeleteConfirm(e.target.value)}
                    placeholder="DELETE"
                    className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
                    style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
                  />
                  {error && <p className="text-xs text-red-400">{error}</p>}
                  <div className="flex gap-2">
                    <button
                      onClick={handleDeleteAccount}
                      disabled={deleteConfirm !== 'DELETE' || deleting}
                      className="text-sm px-4 py-2 rounded-lg font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      style={{ backgroundColor: '#ef4444', color: 'white' }}
                    >
                      {deleting ? 'Deleting...' : 'Permanently Delete'}
                    </button>
                    <button
                      onClick={() => { setShowDelete(false); setDeleteConfirm('') }}
                      className="text-sm px-4 py-2 rounded-lg transition-colors"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
