import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

const PUBLIC_PATHS = [
  '/login',
  '/signup',
  '/privacy',
  '/support',
  '/share/',
  '/api/auth',
  '/api/feedback',
  '/api/audio',
  '/api/audio-url',
  '/api/health',
  '/api/db-init',
  '/api/tus',
]

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (
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
    // Token invalid or expired — send to login with cookie cleared
    const response = NextResponse.redirect(new URL('/login', request.url))
    response.cookies.delete('sb-access-token')
    response.cookies.delete('sb-refresh-token')
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
