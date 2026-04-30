import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'

// OAuth callback — exchanges the auth code for a session after Apple/Google sign-in,
// then sets our custom cookies that middleware expects (sb-access-token, sb-refresh-token).
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl
  const code = searchParams.get('code')
  const oauthError = searchParams.get('error')
  const next = searchParams.get('next') ?? '/dashboard'

  // OAuth provider returned an error (e.g. user denied access)
  if (oauthError) {
    const desc = searchParams.get('error_description') ?? oauthError
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent(desc)}`
    )
  }

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`)
  }

  const response = NextResponse.redirect(`${origin}${next}`)

  // Create a temporary SSR client just to exchange the code
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://mdefkqaawrusoaojstpq.supabase.co',
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1kZWZrcWFhd3J1c29hb2pzdHBxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MDc3OTUsImV4cCI6MjA4ODM4Mzc5NX0.NVv98cob57ldDHeND1gRUZs8IUt9-XmuTcdOwDSvteU',
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          // Update request cookies so the client can read them within this handler,
          // and set them on the response so the browser stores them.
          cookiesToSet.forEach(({ name, value, options }) => {
            request.cookies.set(name, value)
            response.cookies.set(name, value, options)
          })
        },
      },
    }
  )

  const { data, error } = await supabase.auth.exchangeCodeForSession(code)

  if (error || !data.session) {
    const msg = error?.message ?? 'auth_failed'
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent(msg)}`
    )
  }

  // Set the custom cookies that our middleware checks
  const cookieOpts = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
  }

  response.cookies.set('sb-access-token', data.session.access_token, {
    ...cookieOpts,
    maxAge: 60 * 60, // 1 hour
  })
  response.cookies.set('sb-refresh-token', data.session.refresh_token, {
    ...cookieOpts,
    maxAge: 60 * 60 * 24 * 30, // 30 days
  })

  return response
}
