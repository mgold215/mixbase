'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase-browser'

const STYLES = `
  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(12px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes pulseGlow {
    0%, 100% { box-shadow: 0 0 0px 0px rgba(45,212,191,0); }
    50%       { box-shadow: 0 0 18px 4px rgba(45,212,191,0.35); }
  }
  .reset-btn:hover:not(:disabled) {
    animation: pulseGlow 1.4s ease infinite;
  }
`

export default function ResetPasswordPage() {
  const router = useRouter()
  // 'checking' → verifying the recovery link · 'ready' → let them set a password
  // · 'invalid' → link expired/opened in a different browser (PKCE verifier gone)
  const [status, setStatus] = useState<'checking' | 'ready' | 'invalid'>('checking')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const supabase = createClient()
    let resolved = false

    // The @supabase/ssr browser client processes the recovery code/hash from the
    // URL on load and fires PASSWORD_RECOVERY / SIGNED_IN once the recovery
    // session is established. Watch for it, and also poll getSession as a fallback.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session && !resolved) { resolved = true; setStatus('ready') }
    })

    supabase.auth.getSession().then(({ data }) => {
      if (data.session && !resolved) { resolved = true; setStatus('ready') }
    })

    // If no recovery session materializes shortly, the link is invalid/expired or
    // was opened in a different browser than the one that requested it.
    const timer = setTimeout(() => {
      if (!resolved) { resolved = true; setStatus('invalid') }
    }, 4000)

    return () => { sub.subscription.unsubscribe(); clearTimeout(timer) }
  }, [])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    if (password !== confirm) { setError('Passwords do not match'); return }
    if (password.length < 8) { setError('Password must be at least 8 characters'); return }

    setSaving(true)
    const supabase = createClient()
    const { error } = await supabase.auth.updateUser({ password })
    if (error) {
      setError(error.message || 'Could not update password. Try requesting a new link.')
      setSaving(false)
      return
    }
    // Clear the temporary recovery session so the user signs in fresh with the
    // new password through the app's normal cookie-based login.
    await supabase.auth.signOut()
    router.push('/login?reset=1')
  }

  return (
    <>
      <style>{STYLES}</style>
      <div
        className="min-h-screen flex items-center justify-center px-4"
        style={{ backgroundColor: 'var(--bg-page)', position: 'relative', overflow: 'hidden' }}
      >
        <div
          aria-hidden="true"
          style={{
            position: 'absolute', inset: 0,
            background: 'radial-gradient(ellipse 70% 50% at 50% 50%, rgba(45,212,191,0.07) 0%, transparent 70%)',
            pointerEvents: 'none',
          }}
        />

        <div className="w-full max-w-sm" style={{ position: 'relative', zIndex: 1 }}>
          <div className="text-center mb-10" style={{ animation: 'fadeUp 0.5s ease both' }}>
            <h1 className="text-3xl font-bold tracking-[0.04em] font-[family-name:var(--font-jost)]">
              <span style={{ color: 'var(--text)' }}>mix</span>
              <span style={{ color: 'var(--accent)' }}>BASE</span>
            </h1>
            <p className="text-xs uppercase tracking-[0.2em] mt-1" style={{ color: '#4ade80' }}>ROUGH-TO-RELEASE</p>
            <p className="text-sm mt-2" style={{ color: 'var(--text-muted)' }}>Choose a new password</p>
          </div>

          <div
            className="rounded-2xl p-8"
            style={{
              animation: 'fadeUp 0.5s ease 0.1s both',
              backgroundColor: 'rgba(15,21,19,0.82)',
              border: '1px solid var(--border)',
              backdropFilter: 'blur(8px)',
              WebkitBackdropFilter: 'blur(8px)',
            }}
          >
            {status === 'checking' && (
              <p className="text-sm text-center" style={{ color: 'var(--text-muted)' }}>Verifying your reset link…</p>
            )}

            {status === 'invalid' && (
              <div className="text-center space-y-3">
                <p className="text-sm" style={{ color: 'var(--text)' }}>
                  This reset link is invalid or has expired.
                </p>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  Open the link in the same browser you requested it from, or request a new one.
                </p>
                <Link href="/forgot-password" style={{ color: 'var(--accent)' }} className="hover:underline text-sm block">
                  Request a new reset link
                </Link>
              </div>
            )}

            {status === 'ready' && (
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label htmlFor="new-password" className="block text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>New password</label>
                  <input
                    id="new-password"
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="Min. 8 characters"
                    autoFocus
                    required
                    className="w-full rounded-xl px-4 py-3 focus:outline-none transition-colors"
                    style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
                  />
                </div>
                <div>
                  <label htmlFor="confirm-password" className="block text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>Confirm new password</label>
                  <input
                    id="confirm-password"
                    type="password"
                    value={confirm}
                    onChange={e => setConfirm(e.target.value)}
                    placeholder="••••••••"
                    required
                    className="w-full rounded-xl px-4 py-3 focus:outline-none transition-colors"
                    style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
                  />
                </div>

                {error && <p className="text-red-400 text-sm">{error}</p>}

                <button
                  type="submit"
                  disabled={saving || !password || !confirm}
                  className="reset-btn w-full font-semibold rounded-xl py-3 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ backgroundColor: 'var(--accent)', color: 'var(--bg)' }}
                >
                  {saving ? 'Saving…' : 'Update password'}
                </button>
              </form>
            )}

            <p className="text-center text-sm mt-6" style={{ color: 'var(--text-muted)' }}>
              <Link href="/login" style={{ color: 'var(--accent)' }} className="hover:underline">
                Back to sign in
              </Link>
            </p>
          </div>
        </div>
      </div>
    </>
  )
}
