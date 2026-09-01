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

// Returns the userId string if the request comes from an admin, null otherwise.
//
// Identity comes from isAdminIdentity(), NOT from profiles.subscription_tier.
// That column is UPDATE-grantable to the authenticated role and RLS scopes the
// row rather than the column, so a user could promote themselves to 'admin' with
// a PATCH of their own profile. See src/lib/admin-identity.ts for the full
// write-up and the production evidence.
export async function assertAdmin(request: import('next/server').NextRequest): Promise<string | null> {
  const { isAdminIdentity } = await import('./admin-identity')
  const userId = request.headers.get('X-User-Id')
  if (!userId) return null
  return (await isAdminIdentity(userId)) ? userId : null
}
