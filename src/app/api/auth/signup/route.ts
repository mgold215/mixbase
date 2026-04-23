import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  path: '/',
}

// POST /api/auth/signup — create a new account and sign in immediately
export async function POST(request: NextRequest) {
  const { email, password } = await request.json()

  if (!email || !password) {
    return NextResponse.json({ error: 'Email and password are required' }, { status: 400 })
  }

  if (password.length < 8) {
    return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // skip email confirmation for frictionless onboarding
  })

  if (error) {
    const msg = error.message.includes('already registered')
      ? 'An account with that email already exists'
      : error.message
    return NextResponse.json({ error: msg }, { status: 400 })
  }

  // Sign in immediately so we can issue session cookies
  const { data: signInData, error: signInError } = await supabaseAdmin.auth.signInWithPassword({
    email,
    password,
  })

  if (signInError || !signInData.session) {
    // Account created but auto-sign-in failed — redirect to login
    return NextResponse.json({ ok: true, redirect: '/login' })
  }

  const response = NextResponse.json({ ok: true })
  response.cookies.set('sb-access-token', signInData.session.access_token, {
    ...COOKIE_OPTS,
    maxAge: 60 * 60,
  })
  response.cookies.set('sb-refresh-token', signInData.session.refresh_token, {
    ...COOKIE_OPTS,
    maxAge: 60 * 60 * 24 * 30,
  })
  return response
}
