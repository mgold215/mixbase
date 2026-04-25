import { cookies } from 'next/headers'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { supabaseAdmin } from './supabase'

// Reads the Supabase access token from the request cookie store and validates it.
// Returns { userId, accessToken } or null if the session is missing/invalid.
export async function getServerSession(): Promise<{ userId: string; accessToken: string } | null> {
  const cookieStore = await cookies()
  const accessToken = cookieStore.get('sb-access-token')?.value
  if (!accessToken) return null

  const { data: { user }, error } = await supabaseAdmin.auth.getUser(accessToken)
  if (error || !user) return null

  return { userId: user.id, accessToken }
}

// Fast user ID lookup — reads X-User-Id header injected by middleware.
// No extra Supabase call. Redirects to /login if missing (shouldn't happen on protected routes).
export async function getUserId(): Promise<string> {
  const hdrs = await headers()
  const userId = hdrs.get('X-User-Id')
  if (!userId) redirect('/login')
  return userId
}
