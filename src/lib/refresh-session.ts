import { supabaseAdmin } from '@/lib/supabase'

type RefreshResult = Awaited<ReturnType<typeof supabaseAdmin.auth.refreshSession>>

// Supabase rotates refresh tokens on every use: two concurrent refreshSession()
// calls with the same token race, and the loser's rotated token is invalid —
// the user gets randomly logged out. Dedup concurrent refreshes per token so
// all awaiters share one Supabase call. A module-level Map is enough: this app
// runs as a single Railway instance, and Supabase's ~10s token-reuse grace
// window absorbs anything that slips between separate module graphs.
const inflight = new Map<string, Promise<RefreshResult>>()

export function refreshSessionOnce(refreshToken: string): Promise<RefreshResult> {
  let pending = inflight.get(refreshToken)
  if (!pending) {
    pending = supabaseAdmin.auth
      .refreshSession({ refresh_token: refreshToken })
      .finally(() => inflight.delete(refreshToken))
    inflight.set(refreshToken, pending)
  }
  return pending
}
