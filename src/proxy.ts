import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { decodeJwt } from 'jose'
import { supabaseAdmin } from '@/lib/supabase'

// Routes that never require authentication
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
  '/api/auth/refresh', // must be reachable without a valid session
  '/api/feedback',
  '/api/audio',
  '/api/audio-url',
  '/api/health',
  '/api/db-init',
  '/api/tus',
  '/api/stripe/webhook', // Stripe posts without user cookies; signature-verified internally
]

const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  // 'lax' so the session survives top-level cross-origin entries. See /api/auth.
  sameSite: 'lax' as const,
  path: '/',
}

function clearAndRedirect(request: NextRequest) {
  const res = NextResponse.redirect(new URL('/login', request.url))
  res.cookies.delete('sb-access-token')
  res.cookies.delete('sb-refresh-token')
  res.cookies.delete('sb-authed')
  res.cookies.delete('sb-expires-at')
  return res
}

async function withAdminCheck(
  request: NextRequest,
  userId: string,
  requestHeaders: Headers,
): Promise<NextResponse> {
  const { pathname } = request.nextUrl
  if (pathname.startsWith('/admin') || pathname.startsWith('/api/admin')) {
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('subscription_tier')
      .eq('id', userId)
      .single()
    if (profileError) {
      console.error('[withAdminCheck] profile query failed:', profileError.message)
      return pathname.startsWith('/api/')
        ? NextResponse.json({ error: 'Service unavailable' }, { status: 503 })
        : NextResponse.redirect(new URL('/dashboard', request.url))
    }
    if (profile?.subscription_tier !== 'admin') {
      return pathname.startsWith('/api/')
        ? NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        : NextResponse.redirect(new URL('/dashboard', request.url))
    }
  }
  return NextResponse.next({ request: { headers: requestHeaders } })
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // /api/auth (login) needs exact match — /api/auth/me etc. must be protected
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

  // ── Fast path: decode JWT payload locally — no network call ───────────────
  // decodeJwt reads the payload without verifying the signature (< 1ms).
  // The old approach called auth.getUser() on every request, which made a
  // live Supabase round-trip, hit rate limits, and caused random logouts on
  // any transient network error.
  let userId: string | null = null
  let tokenExpired = false

  try {
    const payload = decodeJwt(accessToken)
    userId = payload.sub ?? null
    tokenExpired = typeof payload.exp === 'number'
      ? payload.exp < Math.floor(Date.now() / 1000)
      : false
  } catch {
    // Malformed JWT
    return clearAndRedirect(request)
  }

  if (!tokenExpired && userId) {
    // Token is present and not expired — inject user ID and pass through
    const requestHeaders = new Headers(request.headers)
    requestHeaders.set('X-User-Id', userId)
    return withAdminCheck(request, userId, requestHeaders)
  }

  // ── Slow path: token is expired — attempt one refresh ─────────────────────
  // Under normal operation this path is rarely reached because SessionRefresher
  // proactively refreshes 5 minutes before the token expires.
  const refreshToken = request.cookies.get('sb-refresh-token')?.value

  if (!refreshToken) {
    return clearAndRedirect(request)
  }

  try {
    const { data: refreshed, error: refreshError } =
      await supabaseAdmin.auth.refreshSession({ refresh_token: refreshToken })

    if (!refreshError && refreshed.session) {
      const expiresAt = refreshed.session.expires_at ?? Math.floor(Date.now() / 1000) + 3600
      const requestHeaders = new Headers(request.headers)
      requestHeaders.set('X-User-Id', refreshed.session.user.id)
      const res = await withAdminCheck(request, refreshed.session.user.id, requestHeaders)
      res.cookies.set('sb-access-token', refreshed.session.access_token, { ...COOKIE_OPTS, maxAge: 60 * 60 })
      res.cookies.set('sb-refresh-token', refreshed.session.refresh_token, { ...COOKIE_OPTS, maxAge: 60 * 60 * 24 * 30 })
      res.cookies.set('sb-authed', '1', { path: '/', sameSite: 'lax', maxAge: 60 * 60 * 24 * 30 })
      res.cookies.set('sb-expires-at', String(expiresAt), { path: '/', sameSite: 'lax', maxAge: 60 * 60 * 24 * 30 })
      return res
    }

    // Refresh definitively failed (token revoked / truly expired)
    return clearAndRedirect(request)
  } catch {
    // Network error during refresh — do NOT kick the user out for a transient
    // failure. Let them through; their data requests will fail gracefully if
    // Supabase is actually unreachable.
    // Exception: admin paths get a hard deny — userId came from an expired,
    // unverified token and the DB is unreachable so we cannot confirm admin status.
    const { pathname } = request.nextUrl
    if (pathname.startsWith('/admin') || pathname.startsWith('/api/admin')) {
      return pathname.startsWith('/api/')
        ? NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        : NextResponse.redirect(new URL('/dashboard', request.url))
    }
    if (userId) {
      const requestHeaders = new Headers(request.headers)
      requestHeaders.set('X-User-Id', userId)
      return NextResponse.next({ request: { headers: requestHeaders } })
    }
    return clearAndRedirect(request)
  }
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
