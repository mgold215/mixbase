'use client'

import { useState, type FormEvent } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase-browser'
import { isTransientAuthError } from '@/lib/auth-errors'

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

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    const supabase = createClient()
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/reset-password`,
    })

    // Only a TRANSIENT failure (network status 0, rate-limit 429, Supabase 5xx)
    // means the reset email may not have gone out — surface a retry instead of a
    // false "we've sent a link". Every other outcome (success, or a definitive
    // 4xx) shows the same enumeration-safe confirmation, so account existence is
    // never revealed. The old `>= 500`-only check (plus the `error.status &&`
    // truthiness guard, which also dropped status 0) reported a false success on
    // an offline submit or a rate-limited request.
    if (isTransientAuthError(error)) {
      setError('Something went wrong. Please try again.')
      setLoading(false)
      return
    }
    setSent(true)
    setLoading(false)
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
            <p className="text-sm mt-2" style={{ color: 'var(--text-muted)' }}>Reset your password</p>
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
            {sent ? (
              <div className="text-center space-y-3">
                <p className="text-sm" style={{ color: 'var(--text)' }}>
                  If an account exists for <span style={{ color: 'var(--accent)' }}>{email.trim()}</span>, we&apos;ve sent a link to reset your password.
                </p>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  Check your inbox (and spam). The link expires in about an hour.
                </p>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                <p className="text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>
                  Enter your email and we&apos;ll send you a link to set a new password.
                </p>
                <div>
                  <label htmlFor="reset-email" className="block text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>Email</label>
                  <input
                    id="reset-email"
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    autoFocus
                    required
                    className="w-full rounded-xl px-4 py-3 focus:outline-none transition-colors"
                    style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
                  />
                </div>

                {error && <p className="text-red-400 text-sm">{error}</p>}

                <button
                  type="submit"
                  disabled={loading || !email}
                  className="reset-btn w-full font-semibold rounded-xl py-3 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ backgroundColor: 'var(--accent)', color: 'var(--bg)' }}
                >
                  {loading ? 'Sending…' : 'Send reset link'}
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
