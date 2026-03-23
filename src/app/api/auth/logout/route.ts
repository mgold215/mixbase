import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'

// POST /api/auth/logout — clear session cookie
export async function POST() {
  const cookieStore = await cookies()
  cookieStore.delete('mf-session')
  return NextResponse.json({ ok: true })
}
