'use client'

import { useState, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Nav from '@/components/Nav'
import { LogOut, Trash2, ArrowLeft, ExternalLink, Check } from 'lucide-react'
import Link from 'next/link'

export default function ProfilePage() {
  return (
    <Suspense fallback={null}>
      <ProfilePageInner />
    </Suspense>
  )
}

function ProfilePageInner() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [artistName, setArtistName] = useState('')
  const [savedArtistName, setSavedArtistName] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [loading, setLoading] = useState(true)
  const [sub, setSub] = useState<{ tier: string; price: string; hasStripeSubscription: boolean } | null>(null)
  const [showDelete, setShowDelete] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')

  // Password change
  const [showPassword, setShowPassword] = useState(false)
  const [currentPw, setCurrentPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [pwLoading, setPwLoading] = useState(false)
  const [pwError, setPwError] = useState('')
  const [pwSuccess, setPwSuccess] = useState(false)

  const searchParams = useSearchParams()
  const justSubscribed = searchParams.get('subscribed') === '1'

  useEffect(() => {
    Promise.all([
      fetch('/api/auth/me').then(r => r.json()),
      fetch('/api/subscription').then(r => r.json()),
    ]).then(([meData, subData]) => {
      setEmail(meData.email ?? '')
      setArtistName(meData.artist_name ?? '')
      setSavedArtistName(meData.artist_name ?? '')
      setSub(subData)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  async function handleSaveProfile() {
    setSaving(true)
    const res = await fetch('/api/auth/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ artist_name: artistName }),
    })
    setSaving(false)
    if (res.ok) {
      setSavedArtistName(artistName)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    }
  }

  async function handleChangePassword() {
    setPwError('')
    if (newPw.length < 8) { setPwError('Password must be at least 8 characters'); return }
    if (newPw !== confirmPw) { setPwError('Passwords do not match'); return }

    setPwLoading(true)
    const res = await fetch('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_password: currentPw, new_password: newPw }),
    })
    const body = await res.json().catch(() => ({}))
    setPwLoading(false)

    if (res.ok) {
      setPwSuccess(true)
      setCurrentPw(''); setNewPw(''); setConfirmPw('')
      setTimeout(() => { setPwSuccess(false); setShowPassword(false) }, 2000)
    } else {
      setPwError(body.error ?? 'Failed to change password')
    }
  }

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

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    router.push('/login')
  }

  const hasProfileChanges = artistName.trim() !== savedArtistName

  const sectionStyle = {
    backgroundColor: 'var(--surface)',
    border: '1px solid var(--border)',
  }

  const inputStyle = {
    backgroundColor: 'var(--input-bg)',
    border: '1px solid var(--border)',
    color: 'var(--text)',
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

        <h1 className="text-xl font-semibold mb-6" style={{ color: 'var(--text)' }}>Settings</h1>

        {loading ? (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading...</p>
        ) : (
          <div className="space-y-6">

            {/* Subscribed success banner */}
            {justSubscribed && (
              <div className="rounded-xl px-5 py-3 text-sm font-medium" style={{ backgroundColor: '#4ade8022', border: '1px solid #4ade8055', color: '#4ade80' }}>
                You&apos;re now subscribed. Welcome to Pro!
              </div>
            )}

            {/* Account section */}
            <div>
              <h2 className="text-xs uppercase tracking-[0.14em] mb-3 font-semibold" style={{ color: 'var(--accent)' }}>Account</h2>
              <div className="rounded-xl p-5 space-y-4" style={sectionStyle}>
                <div>
                  <label className="block text-xs uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-muted)' }}>Email</label>
                  <p className="text-sm" style={{ color: 'var(--text)' }}>{email}</p>
                </div>
                <div>
                  <label className="block text-xs uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-muted)' }}>Artist / Producer name</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={artistName}
                      onChange={e => setArtistName(e.target.value)}
                      placeholder="Your artist or producer name"
                      className="flex-1 rounded-lg px-3 py-2 text-sm focus:outline-none"
                      style={inputStyle}
                    />
                    <button
                      onClick={handleSaveProfile}
                      disabled={!hasProfileChanges || saving}
                      className="text-sm px-4 py-2 rounded-lg font-medium transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                      style={{ backgroundColor: saved ? '#4ade80' : 'var(--accent)', color: '#0d0b08' }}
                    >
                      {saved ? <Check size={14} /> : saving ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Plan section */}
            <div>
              <h2 className="text-xs uppercase tracking-[0.14em] mb-3 font-semibold" style={{ color: 'var(--accent)' }}>Plan</h2>
              <div className="rounded-xl p-5 flex items-center justify-between" style={sectionStyle}>
                <div>
                  <p className="text-sm font-semibold capitalize" style={{ color: 'var(--text)' }}>
                    {sub?.tier ?? 'Free'}
                  </p>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    {sub?.price ?? '$0/mo'}
                  </p>
                </div>
                {sub?.hasStripeSubscription ? (
                  <button
                    onClick={async () => {
                      const res = await fetch('/api/stripe/portal', { method: 'POST' })
                      const data = await res.json()
                      if (data.url) window.location.href = data.url
                    }}
                    className="text-xs px-3 py-1.5 rounded-lg font-medium transition-colors"
                    style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)' }}
                  >
                    Manage
                  </button>
                ) : (
                  <Link
                    href="/upgrade"
                    className="text-xs px-3 py-1.5 rounded-lg font-medium transition-colors"
                    style={{ backgroundColor: 'var(--accent)', color: '#0d0b08' }}
                  >
                    Upgrade
                  </Link>
                )}
              </div>
            </div>

            {/* Security section */}
            <div>
              <h2 className="text-xs uppercase tracking-[0.14em] mb-3 font-semibold" style={{ color: 'var(--accent)' }}>Security</h2>
              <div className="rounded-xl p-5" style={sectionStyle}>
                {!showPassword ? (
                  <button
                    onClick={() => setShowPassword(true)}
                    className="text-sm transition-colors"
                    style={{ color: 'var(--accent)' }}
                  >
                    Change password
                  </button>
                ) : (
                  <div className="space-y-3">
                    <input
                      type="password"
                      value={currentPw}
                      onChange={e => setCurrentPw(e.target.value)}
                      placeholder="Current password"
                      className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
                      style={inputStyle}
                    />
                    <input
                      type="password"
                      value={newPw}
                      onChange={e => setNewPw(e.target.value)}
                      placeholder="New password (min. 8 characters)"
                      className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
                      style={inputStyle}
                    />
                    <input
                      type="password"
                      value={confirmPw}
                      onChange={e => setConfirmPw(e.target.value)}
                      placeholder="Confirm new password"
                      className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
                      style={inputStyle}
                    />
                    {pwError && <p className="text-xs text-red-400">{pwError}</p>}
                    {pwSuccess && <p className="text-xs text-green-400">Password changed successfully</p>}
                    <div className="flex gap-2">
                      <button
                        onClick={handleChangePassword}
                        disabled={pwLoading || !currentPw || !newPw || !confirmPw}
                        className="text-sm px-4 py-2 rounded-lg font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        style={{ backgroundColor: 'var(--accent)', color: '#0d0b08' }}
                      >
                        {pwLoading ? 'Updating...' : 'Update password'}
                      </button>
                      <button
                        onClick={() => { setShowPassword(false); setCurrentPw(''); setNewPw(''); setConfirmPw(''); setPwError('') }}
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

            {/* Legal section */}
            <div>
              <h2 className="text-xs uppercase tracking-[0.14em] mb-3 font-semibold" style={{ color: 'var(--accent)' }}>Legal</h2>
              <div className="rounded-xl divide-y" style={{ ...sectionStyle, borderColor: 'var(--border)' }}>
                {[
                  { href: '/privacy', label: 'Privacy Policy' },
                  { href: '/terms', label: 'Terms of Service' },
                  { href: '/support', label: 'Support' },
                ].map(link => (
                  <Link
                    key={link.href}
                    href={link.href}
                    className="flex items-center justify-between px-5 py-3.5 transition-colors hover:opacity-80"
                    style={{ borderColor: 'var(--border)' }}
                  >
                    <span className="text-sm" style={{ color: 'var(--text)' }}>{link.label}</span>
                    <ExternalLink size={13} style={{ color: 'var(--text-muted)' }} />
                  </Link>
                ))}
              </div>
            </div>

            {/* Sign out */}
            <button
              onClick={handleLogout}
              className="flex items-center gap-2 text-sm px-5 py-3.5 rounded-xl w-full transition-colors"
              style={{ ...sectionStyle, color: 'var(--accent)' }}
            >
              <LogOut size={14} />
              Sign out
            </button>

            {/* Danger zone */}
            <div>
              <h2 className="text-xs uppercase tracking-[0.14em] mb-3 font-semibold" style={{ color: '#ef4444' }}>Danger Zone</h2>
              <div
                className="rounded-xl p-5"
                style={{ backgroundColor: 'var(--surface)', border: '1px solid rgba(239, 68, 68, 0.2)' }}
              >
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
                      style={inputStyle}
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

          </div>
        )}
      </div>
    </div>
  )
}
