import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { makeJwtKey, verifyAccessToken } from '@/lib/verifyToken'

// Shared HS256 key used to verify access-token signatures locally (no network
// call). Built once at module load. If SUPABASE_JWT_SECRET is unset we fall
// back to UNVERIFIED decoding (legacy behaviour) and warn loudly — that path
// trusts the token's claims without checking the signature, which is an
// auth-bypass risk. Set SUPABASE_JWT_SECRET (Supabase → Settings → API → JWT
// Secret) on every deployment to close it.
const JWT_KEY = makeJwtKey(process.env.SUPABASE_JWT_SECRET)
if (!JWT_KEY) {
  console.warn(
    '[proxy] SUPABASE_JWT_SECRET is not set — access tokens are NOT signature-verified. ' +
      'Set this env var to verify JWTs and close an authentication-bypass risk.',
  )
}

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

// Both token cookies live 30 days. The access-token JWT itself still expires in
// ~1 hour and is always validated against its `exp` — keeping the cookie around
// after the JWT expires is what lets this middleware *see* an expired session and
// silently refresh it, instead of finding no cookie and bouncing the user to
// /login. As long as the user returns within 30 days, the session slides forward.
const SESSION_MAX_AGE = 60 * 60 * 24 * 30

function setSessionCookies(
  res: NextResponse,
  accessToken: string,
  refreshToken: string,
  expiresAt: number,
) {
  res.cookies.set('sb-access-token', accessToken, { ...COOKIE_OPTS, maxAge: SESSION_MAX_AGE })
  res.cookies.set('sb-refresh-token', refreshToken, { ...COOKIE_OPTS, maxAge: SESSION_MAX_AGE })
  res.cookies.set('sb-authed', '1', { path: '/', sameSite: 'lax', maxAge: SESSION_MAX_AGE })
  res.cookies.set('sb-expires-at', String(expiresAt), { path: '/', sameSite: 'lax', maxAge: SESSION_MAX_AGE })
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
  const refreshToken = request.cookies.get('sb-refresh-token')?.value

  // ── Fast path: verify JWT signature locally — no network call ─────────────
  // verifyAccessToken checks the HS256 signature against SUPABASE_JWT_SECRET
  // (< 1ms, no Supabase round-trip). A forged or tampered token fails the
  // check and is treated as invalid, so it can never be used to spoof another
  // user's X-User-Id. The old approach called auth.getUser() on every request,
  // which hit rate limits and caused random logouts on transient errors.
  let userId: string | null = null
  let tokenExpired = false

  if (accessToken) {
    const check = await verifyAccessToken(accessToken, JWT_KEY)
    userId = check.userId
    tokenExpired = check.expired
  }

  if (accessToken && !tokenExpired && userId) {
    // Token is present and not expired — inject user ID and pass through
    const requestHeaders = new Headers(request.headers)
    requestHeaders.set('X-User-Id', userId)
    return withAdminCheck(request, userId, requestHeaders)
  }

  // ── Slow path: access token is missing, expired, or malformed — refresh ───
  // The access-token cookie can simply be gone (browser dropped it after the
  // user was away a while) while the 30-day refresh token is still valid, so we
  // always try to refresh here rather than redirecting to login. Under normal
  // foreground use this is rare because SessionRefresher refreshes proactively.
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
      setSessionCookies(res, refreshed.session.access_token, refreshed.session.refresh_token, expiresAt)
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
