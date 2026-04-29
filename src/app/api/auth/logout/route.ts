import { NextResponse } from 'next/server'

// POST /api/auth/logout — clear session cookies
export async function POST() {
  const response = NextResponse.json({ ok: true })
  response.cookies.delete('sb-access-token')
  response.cookies.delete('sb-refresh-token')
  response.cookies.delete('sb-authed')
  // Keep backward compat with old mb-session cookie
  response.cookies.delete('mb-session')
  return response
}
