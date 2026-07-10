import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { refreshSessionOnce } from '@/lib/refresh-session'
import { makeJwtKey, verifyAccessToken } from '@/lib/verifyToken'

// Shared HS256 key used to verify access-token signatures locally (no network
// call). Built once at module load. If SUPABASE_JWT_SECRET is unset we fall
// back to UNVERIFIED decoding (legacy behaviour) and warn loudly — that path
// trusts the token's claims without checking the signature, which is an
// auth-bypass risk. Set SUPABASE_JWT_SECRET (Supabase → Settings → API → JWT
// Secret) on every deployment to close it.
const JWT_KEY = makeJwtKey(process.env.SUPABASE_JWT_SECRET)
const IS_PROD = process.env.NODE_ENV === 'production'
if (!JWT_KEY) {
  console.warn(
    '[proxy] SUPABASE_JWT_SECRET is not set — access tokens cannot be signature-verified locally. ' +
      (IS_PROD
        ? 'Falling back to a Supabase getUser() round-trip per request (slower). Set this env var to close the gap.'
        : 'Dev fallback: tokens are decoded WITHOUT signature verification (auth-bypass risk). Set this env var.'),
  )
}

// Routes that never require authentication
const PUBLIC_PATHS = [
  '/login',
  '/signup',
  '/forgot-password',
  '/reset-password',
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
  '/api/artwork', // public mf-artwork proxy — iOS lock-screen fetches it cookie-less
  '/api/health',
  '/api/db-init',
  // NOTE: /api/tus is intentionally NOT public. It proxies to Supabase Storage
  // with the service-role key; leaving it unauthenticated allowed anonymous
  // arbitrary upload/overwrite. It now requires a session (see api/tus routes).
  '/api/stripe/webhook', // Stripe posts without user cookies; signature-verified internally
  // PWA static assets — must load logged-out or service-worker install breaks
  '/sw.js',
  '/manifest.json',
  '/icons/',
  // SEO file-convention routes — crawlers fetch these cookie-less, so they
  // must bypass the auth gate or they'd 307 → /login and the site would look
  // un-indexable.
  '/robots.txt',
  '/sitemap.xml',
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
  // Non-httpOnly — client JS (SessionRefresher) must read these.
  res.cookies.set('sb-authed', '1', { path: '/', sameSite: 'lax', secure: COOKIE_OPTS.secure, maxAge: SESSION_MAX_AGE })
  res.cookies.set('sb-expires-at', String(expiresAt), { path: '/', sameSite: 'lax', secure: COOKIE_OPTS.secure, maxAge: SESSION_MAX_AGE })
}

function isRouterPrefetch(request: NextRequest): boolean {
  return (
    request.headers.get('next-router-prefetch') !== null ||
    request.headers.get('next-router-segment-prefetch') !== null ||
    request.headers.get('purpose') === 'prefetch'
  )
}

// A refresh error we must NOT treat as "session is dead": network failure
// (supabase-js reports these as status 0), rate limiting (429 — all requests
// share Railway's egress IP, so one abusive client could otherwise log
// everyone out), or a Supabase-side 5xx. Only a definitive 4xx (invalid /
// revoked / expired token) should end the session.
function isTransientAuthError(err: { status?: number } | null): boolean {
  if (!err) return false
  const status = err.status ?? 0
  return status === 0 || status === 429 || status >= 500
}

function clearAndRedirect(request: NextRequest) {
  // Router prefetches must NEVER receive the login redirect: the client router
  // caches redirect results per-URL and replays them on later real clicks —
  // and the entry survives re-login (only a full page load clears it), so one
  // failed prefetch makes a single project/page "log the user out" forever.
  // A failed prefetch is silently dropped by the router, so answer with a bare
  // 401 and leave both the redirect and the cookie clearing to a real
  // navigation. (Clearing cookies from a background prefetch could also kill a
  // session that a concurrent tab just refreshed.)
  if (isRouterPrefetch(request)) {
    return new NextResponse(null, { status: 401, headers: { 'cache-control': 'no-store' } })
  }

  // API callers (fetch/XHR, the iOS app, tus-js-client) can't follow a 307 to an
  // HTML /login page — a replayed request there returns 405 and surfaces as an
  // opaque upload/API failure. Return a clean 401 JSON for /api/* instead, and
  // reserve the redirect for real page navigations.
  const { pathname } = request.nextUrl
  const res = pathname.startsWith('/api/')
    ? NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    : NextResponse.redirect(new URL('/login', request.url))
  res.cookies.delete('sb-access-token')
  res.cookies.delete('sb-refresh-token')
  res.cookies.delete('sb-authed')
  res.cookies.delete('sb-expires-at')
  return res
}

// Fail-closed verification when no local JWT secret is configured in production:
// validate the token against Supabase directly rather than trusting an unsigned
// decode. Returns the verified user id, or null if the token is invalid or
// Supabase is unreachable (caller then treats it as unauthenticated — never
// trusts unverified claims).
async function verifyViaNetwork(token: string): Promise<string | null> {
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token)
    if (error || !data.user) return null
    return data.user.id
  } catch {
    return null
  }
}

async function withAdminCheck(
  request: NextRequest,
  userId: string,
  requestHeaders: Headers,
): Promise<NextResponse> {
  const { pathname } = request.nextUrl
  if (pathname.startsWith('/admin') || pathname.startsWith('/api/admin') || pathname.startsWith('/api/infra')) {
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

  // Strip any client-supplied X-User-Id up front. Routes read identity from this
  // header only, so a spoofed value must never reach them. Every downstream
  // NextResponse.next() below is built from this cleaned header set — including
  // the public-path branch, which previously passed inbound headers through
  // untouched (a latent spoofing vector for any future public route).
  const baseHeaders = new Headers(request.headers)
  baseHeaders.delete('x-user-id')

  // /api/auth (login) needs exact match — /api/auth/me etc. must be protected
  // '/' is the public landing page — exact match only, never a PUBLIC_PATHS
  // prefix (startsWith('/') would make every route public)
  if (
    pathname === '/' ||
    pathname === '/api/auth' ||
    PUBLIC_PATHS.some(p => pathname.startsWith(p)) ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon')
  ) {
    return NextResponse.next({ request: { headers: baseHeaders } })
  }

  // Accept a Bearer access token as an alternative to the session cookie so the
  // native iOS app can call server routes (e.g. to run AI generation server-side
  // where paid API keys + tier limits live, instead of embedding keys in the
  // binary). Bearer tokens are verified by the exact same path as cookies below,
  // so a forged Bearer is rejected identically.
  const authHeader = request.headers.get('authorization')
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null
  const accessToken = request.cookies.get('sb-access-token')?.value ?? bearerToken ?? undefined
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
    if (JWT_KEY || !IS_PROD) {
      // Local signature verification (or, in dev without a secret, legacy decode).
      const check = await verifyAccessToken(accessToken, JWT_KEY)
      userId = check.userId
      tokenExpired = check.expired
    } else {
      // Production without a JWT secret: fail closed. Verify against Supabase
      // instead of trusting an unsigned decode. A failure (invalid token or
      // Supabase unreachable) yields null → treated as unauthenticated, never
      // trusted. This is a safety net; the fix is to set SUPABASE_JWT_SECRET.
      const networkUserId = await verifyViaNetwork(accessToken)
      userId = networkUserId
      tokenExpired = networkUserId === null
    }
  }

  if (accessToken && !tokenExpired && userId) {
    // Token is present and not expired — inject user ID and pass through
    const requestHeaders = new Headers(baseHeaders)
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

  // Prefetches never trigger a token refresh. The router re-issues prefetches
  // continuously, so a tab whose refresh token is dead would otherwise hammer
  // Supabase's token endpoint forever (from Railway's single egress IP that
  // can rate-limit auth for every user at once). Drop the prefetch with a
  // bare 401 — the real navigation will refresh (single-flighted) and either
  // succeed or take the login redirect.
  if (isRouterPrefetch(request)) {
    return new NextResponse(null, { status: 401, headers: { 'cache-control': 'no-store' } })
  }

  try {
    // Single-flight: concurrent requests with the same expired token share one
    // refresh call, avoiding refresh-token rotation races (random logouts).
    const { data: refreshed, error: refreshError } = await refreshSessionOnce(refreshToken)

    if (!refreshError && refreshed.session) {
      const expiresAt = refreshed.session.expires_at ?? Math.floor(Date.now() / 1000) + 3600
      const requestHeaders = new Headers(baseHeaders)
      requestHeaders.set('X-User-Id', refreshed.session.user.id)
      const res = await withAdminCheck(request, refreshed.session.user.id, requestHeaders)
      setSessionCookies(res, refreshed.session.access_token, refreshed.session.refresh_token, expiresAt)
      return res
    }

    // A transient failure (network status 0, 429 rate limit, Supabase 5xx) is
    // not a dead session — treat it like the network errors below instead of
    // logging the user out. Only a definitive 4xx (invalid/revoked/expired
    // token) ends the session. supabase-js RETURNS these errors rather than
    // throwing, so without this check a blip would clear everyone's cookies.
    if (refreshError && isTransientAuthError(refreshError)) throw refreshError

    // Refresh definitively failed (token revoked / truly expired)
    return clearAndRedirect(request)
  } catch {
    // Network error during refresh — do NOT kick the user out for a transient
    // failure. Let them through; their data requests will fail gracefully if
    // Supabase is actually unreachable.
    // Exception: admin paths get a hard deny — userId came from an expired,
    // unverified token and the DB is unreachable so we cannot confirm admin status.
    const { pathname } = request.nextUrl
    if (pathname.startsWith('/admin') || pathname.startsWith('/api/admin') || pathname.startsWith('/api/infra')) {
      return pathname.startsWith('/api/')
        ? NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        : NextResponse.redirect(new URL('/dashboard', request.url))
    }
    if (userId) {
      const requestHeaders = new Headers(baseHeaders)
      requestHeaders.set('X-User-Id', userId)
      return NextResponse.next({ request: { headers: requestHeaders } })
    }
    // Transient failure and we can't even read a user id from the old token:
    // send them to login but do NOT clear cookies — the refresh token may be
    // perfectly valid, and the next request (or the login page's own session
    // check) can still use it.
    return request.nextUrl.pathname.startsWith('/api/')
      ? NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      : NextResponse.redirect(new URL('/login', request.url))
  }
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
