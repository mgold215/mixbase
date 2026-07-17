'use client'

import { useState, useEffect } from 'react'
import Nav from '@/components/Nav'
import { LogOut, Trash2, ArrowLeft, ExternalLink, Check, Sparkles } from 'lucide-react'
import Link from 'next/link'
import { spotifySearchUrl, youtubeSearchUrl } from '@/lib/social-links'

export default function ProfilePage() {
  const [email, setEmail] = useState('')
  const [artistName, setArtistName] = useState('')
  const [savedArtistName, setSavedArtistName] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [profileError, setProfileError] = useState('')
  const [loading, setLoading] = useState(true)

  // Artist links — auto-included in every curator submission.
  const [spotifyUrl, setSpotifyUrl] = useState('')
  const [youtubeUrl, setYoutubeUrl] = useState('')
  const [savedSpotifyUrl, setSavedSpotifyUrl] = useState('')
  const [savedYoutubeUrl, setSavedYoutubeUrl] = useState('')
  const [linksSaving, setLinksSaving] = useState(false)
  const [linksSaved, setLinksSaved] = useState(false)
  const [linksError, setLinksError] = useState('')
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

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.json())
      .then(data => {
        setEmail(data.email ?? '')
        setArtistName(data.artist_name ?? '')
        setSavedArtistName(data.artist_name ?? '')
        setSpotifyUrl(data.spotify_url ?? '')
        setSavedSpotifyUrl(data.spotify_url ?? '')
        setYoutubeUrl(data.youtube_url ?? '')
        setSavedYoutubeUrl(data.youtube_url ?? '')
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  async function handleSaveLinks() {
    setLinksSaving(true)
    setLinksError('')
    const res = await fetch('/api/auth/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spotify_url: spotifyUrl.trim(), youtube_url: youtubeUrl.trim() }),
    })
    setLinksSaving(false)
    if (res.ok) {
      setSavedSpotifyUrl(spotifyUrl.trim())
      setSavedYoutubeUrl(youtubeUrl.trim())
      setLinksSaved(true)
      setTimeout(() => setLinksSaved(false), 2000)
    } else {
      const body = await res.json().catch(() => ({}))
      setLinksError(body.error ?? "Couldn't save your links. Please try again.")
    }
  }

  // Fill the link fields with keyless name-search URLs derived from the artist
  // name — the same links the submission portal falls back to. The artist can
  // then replace either with their exact profile URL.
  function autoDetectLinks() {
    const name = artistName.trim()
    if (!name) { setLinksError('Add your artist / producer name above first.'); return }
    setLinksError('')
    setSpotifyUrl(spotifySearchUrl(name))
    setYoutubeUrl(youtubeSearchUrl(name))
  }

  const hasLinkChanges = spotifyUrl.trim() !== savedSpotifyUrl || youtubeUrl.trim() !== savedYoutubeUrl

  async function handleSaveProfile() {
    setSaving(true)
    setProfileError('')
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
    } else {
      const body = await res.json().catch(() => ({}))
      setProfileError(body.error ?? "Couldn't save your name. Please try again.")
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
      // Hard navigation — resets the client router cache on auth-state change
      window.location.assign('/login')
    } else {
      const body = await res.json().catch(() => ({}))
      setError(body.error ?? 'Failed to delete account')
      setDeleting(false)
    }
  }

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    // Hard navigation — resets the client router cache on auth-state change
    window.location.assign('/login')
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
                  {profileError && <p className="text-xs text-red-400 mt-2">{profileError}</p>}
                </div>
              </div>
            </div>

            {/* Artist links section */}
            <div>
              <h2 className="text-xs uppercase tracking-[0.14em] mb-3 font-semibold" style={{ color: 'var(--accent)' }}>Artist Links</h2>
              <div className="rounded-xl p-5 space-y-4" style={sectionStyle}>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  Auto-included in every curator submission alongside your listening &amp; download links. Leave blank to use an
                  automatic search link from your artist name, or paste your exact profile URLs.
                </p>
                <div>
                  <label className="block text-xs uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-muted)' }}>Spotify</label>
                  <input
                    type="url"
                    inputMode="url"
                    value={spotifyUrl}
                    onChange={e => setSpotifyUrl(e.target.value)}
                    placeholder="https://open.spotify.com/artist/…"
                    className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label className="block text-xs uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-muted)' }}>YouTube</label>
                  <input
                    type="url"
                    inputMode="url"
                    value={youtubeUrl}
                    onChange={e => setYoutubeUrl(e.target.value)}
                    placeholder="https://youtube.com/@yourchannel"
                    className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
                    style={inputStyle}
                  />
                </div>
                {linksError && <p className="text-xs text-red-400">{linksError}</p>}
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={autoDetectLinks}
                    className="inline-flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg font-medium transition-colors"
                    style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
                  >
                    <Sparkles size={14} />
                    Auto-detect from my name
                  </button>
                  <button
                    onClick={handleSaveLinks}
                    disabled={!hasLinkChanges || linksSaving}
                    className="text-sm px-4 py-2 rounded-lg font-medium transition-all disabled:opacity-30 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
                    style={{ backgroundColor: linksSaved ? '#4ade80' : 'var(--accent)', color: '#0d0b08' }}
                  >
                    {linksSaved ? <Check size={14} /> : linksSaving ? 'Saving...' : 'Save links'}
                  </button>
                </div>
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
