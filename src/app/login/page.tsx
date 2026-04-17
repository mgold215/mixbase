'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'

/* ─── Keyframe animations injected once at module level ─────────────────────
   fadeUp: elements slide up 12px and fade in from transparent.
   Used on the logo (immediately) and the card (100ms delay) for a staggered
   entrance feel on page load.
   pulseGlow: used on the submit button hover to breathe a teal box-shadow. */
const STYLES = `
  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(12px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes pulseGlow {
    0%, 100% { box-shadow: 0 0 0px 0px rgba(45,212,191,0); }
    50%       { box-shadow: 0 0 18px 4px rgba(45,212,191,0.35); }
  }
  .login-btn:hover:not(:disabled) {
    animation: pulseGlow 1.4s ease infinite;
  }
`

export default function LoginPage() {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })

    if (res.ok) {
      router.push('/dashboard')
      router.refresh()
    } else {
      setError('Wrong password. Try again.')
      setLoading(false)
    }
  }

  return (
    <>
      {/* Inject keyframe CSS — safe in 'use client' components via a style tag */}
      <style>{STYLES}</style>

      {/* Outermost container: page background color + relative positioning anchor */}
      <div
        className="min-h-screen flex items-center justify-center px-4"
        style={{ backgroundColor: 'var(--bg-page)', position: 'relative', overflow: 'hidden' }}
      >
        {/* Atmospheric background glow — position:absolute so it sits behind all
            content without affecting flexbox layout. The radial gradient produces
            a faint teal halo at the center that bleeds into the dark bg. */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            background:
              'radial-gradient(ellipse 70% 50% at 50% 50%, rgba(45,212,191,0.07) 0%, transparent 70%)',
            pointerEvents: 'none',
          }}
        />

        <div className="w-full max-w-sm" style={{ position: 'relative', zIndex: 1 }}>

          {/* Logo — animates in immediately (no delay) */}
          <div
            className="text-center mb-10"
            style={{ animation: 'fadeUp 0.5s ease both' }}
          >
            <h1 className="text-3xl font-bold tracking-[0.04em] font-[family-name:var(--font-jost)]">
              <span style={{ color: 'var(--text)' }}>mix</span>
              <span style={{ color: 'var(--accent)' }}>BASE</span>
            </h1>
            <p className="text-xs uppercase tracking-[0.2em] mt-1" style={{ color: '#86efac' }}>ROUGH-TO-RELEASE</p>
            <p className="text-sm mt-2" style={{ color: 'var(--text-muted)' }}>Track the evolution of your mixes</p>
          </div>

          {/* Login card — animates in 100ms after the logo (staggered entrance).
              backdrop-filter blur gives a frosted-glass effect over the bg glow.
              Background opacity is slightly higher than --surface default so the
              card reads as a distinct layer without feeling opaque. */}
          <div
            className="rounded-2xl p-8"
            style={{
              animation: 'fadeUp 0.5s ease 0.1s both',
              backgroundColor: 'rgba(15,21,19,0.82)',   /* --surface (#0f1513) at 82% opacity */
              border: '1px solid var(--border)',
              backdropFilter: 'blur(8px)',
              WebkitBackdropFilter: 'blur(8px)',         /* Safari support */
            }}
          >
            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label className="block text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Enter password"
                  autoFocus
                  className="w-full rounded-xl px-4 py-3 focus:outline-none transition-colors"
                  style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
                />
              </div>

              {error && (
                <p className="text-red-400 text-sm">{error}</p>
              )}

              {/* Button: login-btn class triggers the pulseGlow keyframe on hover
                  via the injected <style> block above. All other behaviour unchanged. */}
              <button
                type="submit"
                disabled={loading || !password}
                className="login-btn w-full font-semibold rounded-xl py-3 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ backgroundColor: 'var(--accent)', color: 'var(--bg)' }}
              >
                {loading ? 'Entering...' : 'Enter'}
              </button>
            </form>
          </div>

        </div>
      </div>
    </>
  )
}
