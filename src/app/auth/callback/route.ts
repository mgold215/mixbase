import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '@/lib/supabase'

// OAuth callback — exchanges the auth code for a session after Apple/Google sign-in,
// then sets our custom cookies that middleware expects (sb-access-token, sb-refresh-token).
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl
  const code = searchParams.get('code')
  const next = searchParams.get('next') ?? '/dashboard'

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`)
  }

  const response = NextResponse.redirect(`${origin}${next}`)

  // Create a temporary SSR client just to exchange the code
  const supabase = createServerClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          // Let SSR set its own cookies (they won't interfere)
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data, error } = await supabase.auth.exchangeCodeForSession(code)

  if (error || !data.session) {
    return NextResponse.redirect(`${origin}/login?error=auth_failed`)
  }

  // Set the custom cookies that our middleware checks
  // Must use 'lax' (not 'strict') — the OAuth redirect arriving from supabase.co
  // is a cross-site navigation; 'strict' would block the cookie on the very next
  // same-site redirect to /dashboard, causing the user to appear logged out.
  const cookieOpts = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
  }

  const expiresAt = data.session.expires_at ?? Math.floor(Date.now() / 1000) + 3600
  // 30-day cookie lifetime so the session survives gaps longer than the ~1h JWT
  // expiry; middleware re-validates `exp` and refreshes. See /api/auth/route.ts.
  response.cookies.set('sb-access-token', data.session.access_token, { ...cookieOpts, maxAge: 60 * 60 * 24 * 30 })
  response.cookies.set('sb-refresh-token', data.session.refresh_token, { ...cookieOpts, maxAge: 60 * 60 * 24 * 30 })
  response.cookies.set('sb-authed', '1', { path: '/', sameSite: 'lax', secure: cookieOpts.secure, maxAge: 60 * 60 * 24 * 30 })
  response.cookies.set('sb-expires-at', String(expiresAt), { path: '/', sameSite: 'lax', secure: cookieOpts.secure, maxAge: 60 * 60 * 24 * 30 })

  return response
}
