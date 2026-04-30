import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

const PUBLIC_PATHS = [
  '/login',
  '/signup',
  '/privacy',
  '/support',
  '/terms',
  '/dmca',
  '/share/',
  '/auth/callback',
  '/api/auth/signup',
  '/api/auth/logout',
  '/api/feedback',
  '/api/audio',
  '/api/audio-url',
  '/api/health',
  '/api/db-init',
  '/api/tus',
]

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // /api/auth (login endpoint) needs exact match — /api/auth/me etc. must be protected
  if (
    pathname === '/api/auth' ||
    PUBLIC_PATHS.some(p => pathname.startsWith(p)) ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon')
  ) {
    return NextResponse.next()
  }

  const accessToken = request.cookies.get('sb-access-token')?.value

  if (!accessToken) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  // Validate the token and get the user
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(accessToken)

  if (error || !user) {
    // Access token expired — try refresh token before giving up
    const refreshToken = request.cookies.get('sb-refresh-token')?.value
    if (refreshToken) {
      const { data: refreshed, error: refreshError } = await supabaseAdmin.auth.refreshSession({ refresh_token: refreshToken })
      if (!refreshError && refreshed.session) {
        const requestHeaders = new Headers(request.headers)
        requestHeaders.set('X-User-Id', refreshed.session.user.id)
        const refreshedResponse = NextResponse.next({ request: { headers: requestHeaders } })
        const cookieOpts = { httpOnly: true as const, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' as const, path: '/' }
        refreshedResponse.cookies.set('sb-access-token', refreshed.session.access_token, { ...cookieOpts, maxAge: 60 * 60 })
        refreshedResponse.cookies.set('sb-refresh-token', refreshed.session.refresh_token, { ...cookieOpts, maxAge: 60 * 60 * 24 * 30 })
        refreshedResponse.cookies.set('sb-authed', '1', { path: '/', sameSite: 'strict', maxAge: 60 * 60 * 24 * 30 })
        return refreshedResponse
      }
    }
    // Both tokens invalid — clear and redirect to login
    const response = NextResponse.redirect(new URL('/login', request.url))
    response.cookies.delete('sb-access-token')
    response.cookies.delete('sb-refresh-token')
    response.cookies.delete('sb-authed')
    return response
  }

  // Inject user id so API route handlers can read it without re-validating
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('X-User-Id', user.id)

  return NextResponse.next({ request: { headers: requestHeaders } })
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
