'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

const STYLES = `
  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(12px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes pulseGlow {
    0%, 100% { box-shadow: 0 0 0px 0px rgba(45,212,191,0); }
    50%       { box-shadow: 0 0 18px 4px rgba(45,212,191,0.35); }
  }
  .signup-btn:hover:not(:disabled) {
    animation: pulseGlow 1.4s ease infinite;
  }
`

export default function SignupPage() {
  const [artistName, setArtistName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')

    if (password !== confirm) {
      setError('Passwords do not match')
      return
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }

    setLoading(true)

    const res = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, artist_name: artistName.trim() || undefined }),
    })

    const body = await res.json().catch(() => ({}))

    if (res.ok) {
      router.push(body.redirect ?? '/dashboard')
      router.refresh()
    } else {
      setError(body.error ?? 'Sign up failed. Try again.')
      setLoading(false)
    }
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
            <p className="text-xs uppercase tracking-[0.2em] mt-1" style={{ color: '#86efac' }}>ROUGH-TO-RELEASE</p>
            <p className="text-sm mt-2" style={{ color: 'var(--text-muted)' }}>Start tracking your music today</p>
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
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>Artist / Producer name</label>
                <input
                  type="text"
                  value={artistName}
                  onChange={e => setArtistName(e.target.value)}
                  placeholder="Your artist or producer name"
                  autoFocus
                  className="w-full rounded-xl px-4 py-3 focus:outline-none transition-colors"
                  style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
                />
              </div>

              <div>
                <label className="block text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  required
                  className="w-full rounded-xl px-4 py-3 focus:outline-none transition-colors"
                  style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
                />
              </div>

              <div>
                <label className="block text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Min. 8 characters"
                  required
                  className="w-full rounded-xl px-4 py-3 focus:outline-none transition-colors"
                  style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
                />
              </div>

              <div>
                <label className="block text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>Confirm password</label>
                <input
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
                disabled={loading || !email || !password || !confirm}
                className="signup-btn w-full font-semibold rounded-xl py-3 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ backgroundColor: 'var(--accent)', color: 'var(--bg)' }}
              >
                {loading ? 'Creating account…' : 'Create account'}
              </button>
            </form>

            <p className="text-center text-sm mt-6" style={{ color: 'var(--text-muted)' }}>
              Already have an account?{' '}
              <Link href="/login" style={{ color: 'var(--accent)' }} className="hover:underline">
                Sign in
              </Link>
            </p>

            <p className="text-center text-xs mt-4" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>
              By creating an account you agree to our{' '}
              <Link href="/privacy" style={{ color: 'var(--accent)' }} className="hover:underline">
                Privacy Policy
              </Link>
            </p>
          </div>
        </div>
      </div>
    </>
  )
}
