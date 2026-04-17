'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'

const STYLES = `
  @keyframes revealLeft {
    from { opacity: 0; transform: translateX(-28px); }
    to   { opacity: 1; transform: translateX(0); }
  }
  @keyframes revealRight {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
  .login-left  { animation: revealLeft  0.7s cubic-bezier(0.16, 1, 0.3, 1) both; }
  .login-right { animation: revealRight 0.5s ease 0.3s both; }

  .login-input {
    width: 100%;
    background: transparent;
    border: none;
    border-bottom: 1px solid #c8b898;
    color: #1a1208;
    font-family: var(--font-jost), sans-serif;
    font-size: 16px;
    padding: 10px 0 12px;
    outline: none;
    transition: border-color 0.2s;
    letter-spacing: 0.02em;
  }
  .login-input::placeholder { color: #b0a080; }
  .login-input:focus { border-bottom-color: #c4760e; }

  .login-btn {
    width: 100%;
    background: #1a1208;
    color: #ede4d0;
    border: none;
    font-family: var(--font-bebas), sans-serif;
    font-size: 17px;
    letter-spacing: 0.2em;
    padding: 15px;
    cursor: pointer;
    transition: background 0.2s, opacity 0.2s;
  }
  .login-btn:hover:not(:disabled) { background: #2a1e0e; }
  .login-btn:disabled { opacity: 0.4; cursor: not-allowed; }

  @media (max-width: 639px) {
    .login-right { display: none !important; }
    .login-left  { flex: 1 !important; justify-content: center !important; }
    .login-mobile-form { display: block !important; }
    .login-mobile-form .login-input {
      color: #ede4d0;
      border-bottom-color: #3a2e1a;
    }
    .login-mobile-form .login-input::placeholder { color: #6b6050; }
    .login-mobile-form .login-input:focus { border-bottom-color: #e8961e; }
    .login-mobile-form .login-btn {
      background: #e8961e;
      color: #0d0b08;
    }
    .login-mobile-form .login-btn:hover:not(:disabled) { background: #f0a832; }
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
      setError('WRONG PASSWORD')
      setLoading(false)
    }
  }

  const formFields = (
    <>
      <div style={{ marginBottom: 32 }}>
        <label style={{
          display: 'block',
          fontFamily: 'var(--font-mono), monospace',
          fontSize: 10,
          letterSpacing: '0.22em',
          color: '#9a8060',
          textTransform: 'uppercase',
          marginBottom: 10,
        }}>
          Password
        </label>
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder="Enter studio password"
          autoFocus
          className="login-input"
        />
        {error && (
          <div style={{
            fontFamily: 'var(--font-mono), monospace',
            fontSize: 10,
            letterSpacing: '0.12em',
            color: '#c4521e',
            marginTop: 10,
          }}>
            {error}
          </div>
        )}
      </div>
      <button type="submit" disabled={loading || !password} className="login-btn">
        {loading ? 'ENTERING...' : 'ENTER STUDIO'}
      </button>
    </>
  )

  return (
    <>
      <style>{STYLES}</style>
      <div style={{ display: 'flex', height: '100dvh', overflow: 'hidden' }}>

        {/* LEFT PANEL — warm black, typographic wordmark */}
        <div
          className="login-left"
          style={{
            flex: '1 1 58%',
            background: '#0d0b08',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'flex-end',
            padding: 'clamp(28px, 5vw, 60px)',
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          {/* SVG noise grain */}
          <svg aria-hidden="true" style={{
            position: 'absolute', inset: 0, width: '100%', height: '100%',
            opacity: 0.04, pointerEvents: 'none',
          }}>
            <filter id="noise-grain">
              <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="4" stitchTiles="stitch" />
              <feColorMatrix type="saturate" values="0" />
            </filter>
            <rect width="100%" height="100%" filter="url(#noise-grain)" />
          </svg>

          {/* Amber glow — bottom left */}
          <div style={{
            position: 'absolute', bottom: 0, left: 0,
            width: '55%', height: '35%',
            background: 'radial-gradient(ellipse at 0% 100%, rgba(232,150,30,0.07) 0%, transparent 70%)',
            pointerEvents: 'none',
          }} />

          {/* Wordmark */}
          <div style={{ position: 'relative', zIndex: 1 }}>
            <div style={{
              fontFamily: 'var(--font-bebas), sans-serif',
              lineHeight: 0.86,
              letterSpacing: '-0.01em',
              fontSize: 'clamp(68px, 11vw, 144px)',
            }}>
              <div style={{ color: '#ede4d0' }}>MIX</div>
              <div style={{ color: '#e8961e' }}>BASE</div>
            </div>

            <div style={{ width: 36, height: 2, background: '#e8961e', margin: '18px 0' }} />

            <div style={{
              fontFamily: 'var(--font-mono), monospace',
              fontSize: 9,
              letterSpacing: '0.3em',
              color: '#6b6050',
              textTransform: 'uppercase',
            }}>
              ROUGH — TO — RELEASE
            </div>
          </div>

          {/* Mobile inline form */}
          <form
            onSubmit={handleSubmit}
            className="login-mobile-form"
            style={{ display: 'none', marginTop: 44, position: 'relative', zIndex: 1 }}
          >
            {formFields}
          </form>
        </div>

        {/* RIGHT PANEL — warm cream, form */}
        <div
          className="login-right"
          style={{
            flex: '0 0 clamp(280px, 34%, 400px)',
            background: '#f2e8d4',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            padding: 'clamp(28px, 5vw, 60px)',
            borderLeft: '1px solid #dfd0b0',
          }}
        >
          <div style={{ marginBottom: 44 }}>
            <div style={{
              fontFamily: 'var(--font-bebas), sans-serif',
              fontSize: 26,
              letterSpacing: '0.06em',
              color: '#1a1208',
              lineHeight: 1,
              marginBottom: 6,
            }}>
              STUDIO ACCESS
            </div>
            <div style={{
              fontFamily: 'var(--font-mono), monospace',
              fontSize: 10,
              letterSpacing: '0.15em',
              color: '#9a8060',
            }}>
              Private workspace
            </div>
          </div>

          <form onSubmit={handleSubmit}>{formFields}</form>
        </div>
      </div>
    </>
  )
}
