import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'

// POST /api/auth — check password, set session cookie
export async function POST(request: NextRequest) {
  const { password } = await request.json()

  const correctPassword = process.env.MIXBASE_PASSWORD
  const sessionSecret = process.env.SESSION_SECRET

  if (!correctPassword || !sessionSecret) {
    return NextResponse.json({ error: 'Server not configured' }, { status: 500 })
  }

  if (password !== correctPassword) {
    return NextResponse.json({ error: 'Invalid password' }, { status: 401 })
  }

  // Set a session cookie that expires in 30 days
  const cookieStore = await cookies()
  cookieStore.set('mb-session', sessionSecret, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 60 * 60 * 24 * 30,
    path: '/',
  })

  return NextResponse.json({ ok: true })
}
