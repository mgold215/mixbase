import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  path: '/',
}

// POST /api/auth/refresh — exchange a refresh token for a new session.
// Called proactively by SessionRefresher before the access token expires.
// This endpoint is in PUBLIC_PATHS (proxy.ts) so it is always reachable.
export async function POST(request: NextRequest) {
  const refreshToken = request.cookies.get('sb-refresh-token')?.value

  if (!refreshToken) {
    return NextResponse.json({ error: 'No refresh token' }, { status: 401 })
  }

  const { data, error } = await supabaseAdmin.auth.refreshSession({ refresh_token: refreshToken })

  if (error || !data.session) {
    // Session is truly expired — clear cookies so the client redirects to login
    const res = NextResponse.json({ error: 'Session expired', code: 'SESSION_EXPIRED' }, { status: 401 })
    res.cookies.delete('sb-access-token')
    res.cookies.delete('sb-refresh-token')
    res.cookies.delete('sb-authed')
    res.cookies.delete('sb-expires-at')
    return res
  }

  const expiresAt = data.session.expires_at ?? Math.floor(Date.now() / 1000) + 3600
  const res = NextResponse.json({ ok: true, expires_at: expiresAt })
  res.cookies.set('sb-access-token', data.session.access_token, { ...COOKIE_OPTS, maxAge: 60 * 60 })
  res.cookies.set('sb-refresh-token', data.session.refresh_token, { ...COOKIE_OPTS, maxAge: 60 * 60 * 24 * 30 })
  res.cookies.set('sb-authed', '1', { path: '/', sameSite: 'strict', maxAge: 60 * 60 * 24 * 30 })
  res.cookies.set('sb-expires-at', String(expiresAt), { path: '/', sameSite: 'strict', maxAge: 60 * 60 * 24 * 30 })
  return res
}
