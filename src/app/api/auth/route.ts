import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { loginLimiter, ipKey } from '@/lib/rate-limit'

const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  // 'lax' (not 'strict') — strict blocks cookies on top-level GETs from any
  // other origin (Slack/email/Google links, cold-start PWA navigations, etc.),
  // which made users look logged-out every visit. lax keeps the CSRF guarantees
  // we actually need and lets the session survive cross-origin entry.
  sameSite: 'lax' as const,
  path: '/',
}

// POST /api/auth — sign in with email + password
export async function POST(request: NextRequest) {
  const limit = loginLimiter.check(ipKey(request))
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Too many login attempts. Try again later.' }, { status: 429 })
  }

  const { email, password } = await request.json()

  if (!email || !password) {
    return NextResponse.json({ error: 'Email and password are required' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin.auth.signInWithPassword({ email, password })

  if (error || !data.session) {
    return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })
  }

  const expiresAt = data.session.expires_at ?? Math.floor(Date.now() / 1000) + 3600
  const response = NextResponse.json({ ok: true })
  response.cookies.set('sb-access-token', data.session.access_token, { ...COOKIE_OPTS, maxAge: 60 * 60 })
  response.cookies.set('sb-refresh-token', data.session.refresh_token, { ...COOKIE_OPTS, maxAge: 60 * 60 * 24 * 30 })
  // Non-httpOnly cookies — readable by client JS
  response.cookies.set('sb-authed', '1', { path: '/', sameSite: 'lax', maxAge: 60 * 60 * 24 * 30 })
  response.cookies.set('sb-expires-at', String(expiresAt), { path: '/', sameSite: 'lax', maxAge: 60 * 60 * 24 * 30 })
  return response
}
