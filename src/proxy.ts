import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

const PUBLIC_EXACT_PATHS = [
  '/login',
  '/signup',
  '/privacy',
  '/support',
  '/terms',
  '/dmca',
  '/share',
  '/auth/callback',
  '/api/auth',
  '/api/auth/signup',
  '/api/auth/logout',
  '/api/audio',
  '/api/feedback',
  '/api/health',
  '/api/stripe/webhook',
]

const PUBLIC_PREFIX_PATHS = [
  '/share/',
  '/api/audio/',
]

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  const dbInitToken = process.env.DB_INIT_TOKEN
  const authHeader = request.headers.get('authorization')
  const bearerToken = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1]

  if (
    PUBLIC_EXACT_PATHS.some(p => pathname === p) ||
    PUBLIC_PREFIX_PATHS.some(p => pathname.startsWith(p)) ||
    (pathname === '/api/db-init' && !!dbInitToken && bearerToken === dbInitToken) ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon')
  ) {
    return NextResponse.next()
  }

  const accessToken = request.cookies.get('sb-access-token')?.value ?? bearerToken

  if (!accessToken) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return NextResponse.redirect(new URL('/login', request.url))
  }

  let userId = ''
  try {
    // Validate the token and get the user
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(accessToken)

    if (error || !user) {
      // Token invalid or expired — send to login with cookie cleared
      const response = pathname.startsWith('/api/')
        ? NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        : NextResponse.redirect(new URL('/login', request.url))
      response.cookies.delete('sb-access-token')
      response.cookies.delete('sb-refresh-token')
      return response
    }
    userId = user.id
  } catch (error) {
    console.error('[proxy] auth validation failed', error)
    const response = pathname.startsWith('/api/')
      ? NextResponse.json({ error: 'Auth service unavailable' }, { status: 503 })
      : NextResponse.redirect(new URL('/login', request.url))
    response.cookies.delete('sb-access-token')
    response.cookies.delete('sb-refresh-token')
    return response
  }

  // Inject user id so API route handlers can read it without re-validating
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('X-User-Id', userId)

  return NextResponse.next({ request: { headers: requestHeaders } })
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
