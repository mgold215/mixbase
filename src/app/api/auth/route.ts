import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  path: '/',
}

// POST /api/auth — sign in with email + password
export async function POST(request: NextRequest) {
  const { email, password } = await request.json()

  if (!email || !password) {
    return NextResponse.json({ error: 'Email and password are required' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin.auth.signInWithPassword({ email, password })

  if (error || !data.session) {
    return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })
  }

  const response = NextResponse.json({ ok: true })
  response.cookies.set('sb-access-token', data.session.access_token, {
    ...COOKIE_OPTS,
    maxAge: 60 * 60, // 1 hour — refresh token handles long sessions
  })
  response.cookies.set('sb-refresh-token', data.session.refresh_token, {
    ...COOKIE_OPTS,
    maxAge: 60 * 60 * 24 * 30, // 30 days
  })
  // Non-httpOnly presence cookie — readable by client JS for UI decisions
  response.cookies.set('sb-authed', '1', { path: '/', sameSite: 'strict', maxAge: 60 * 60 * 24 * 30 })
  return response
}
