import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// Routes that are always public — no password required
const PUBLIC_PATHS = ['/login', '/share/', '/api/auth', '/api/feedback', '/api/audio-url', '/api/health', '/api/db-init']

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Allow public paths and static assets
  if (
    PUBLIC_PATHS.some(p => pathname.startsWith(p)) ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon')
  ) {
    return NextResponse.next()
  }

  // Check for valid session cookie
  const session = request.cookies.get('mf-session')
  const secret = process.env.SESSION_SECRET

  if (!session || !secret || session.value !== secret) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
