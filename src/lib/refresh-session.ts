import { createSessionClient } from '@/lib/supabase'

type RefreshResult = Awaited<ReturnType<ReturnType<typeof createSessionClient>['auth']['refreshSession']>>

// Supabase rotates refresh tokens on every use: two concurrent refreshSession()
// calls with the same token race, and the loser's rotated token is invalid —
// GoTrue flags the reuse as a "possible abuse attempt" and revokes the ENTIRE
// session family, logging the user out everywhere. Two layers of defence:
//
//  1. inflight  — concurrent refreshes of the same token share one Supabase
//     call (single-flight).
//  2. recent    — a successful rotation's result is kept for a short window and
//     replayed to any request that still presents the OLD token (a tab whose
//     Set-Cookie hasn't landed yet, a request already in flight when the
//     cookies rotated, the SessionRefresher racing the middleware). Without
//     this, that straggler would hit GoTrue with a consumed token and nuke the
//     session.
//
// Both maps live on globalThis because Next bundles the middleware (proxy.ts)
// and route handlers (/api/auth/refresh) into SEPARATE module graphs — a
// module-level Map would exist twice, and the two copies could still race each
// other. This app runs as a single Railway instance, so one process-wide map
// covers everything.
const REPLAY_WINDOW_MS = 60_000
const MAX_RECENT = 1000

type Shared = {
  inflight: Map<string, Promise<RefreshResult>>
  recent: Map<string, { result: RefreshResult; at: number }>
}

const SHARED_KEY = '__mb_refresh_shared__'
function shared(): Shared {
  const g = globalThis as Record<string, unknown>
  if (!g[SHARED_KEY]) {
    g[SHARED_KEY] = { inflight: new Map(), recent: new Map() } satisfies Shared
  }
  return g[SHARED_KEY] as Shared
}

export function refreshSessionOnce(refreshToken: string): Promise<RefreshResult> {
  const { inflight, recent } = shared()

  const hit = recent.get(refreshToken)
  if (hit && Date.now() - hit.at < REPLAY_WINDOW_MS) {
    return Promise.resolve(hit.result)
  }

  let pending = inflight.get(refreshToken)
  if (!pending) {
    // Throwaway client, NOT supabaseAdmin. This is the highest-frequency
    // session-establishing call in the app — middleware refreshes on every
    // expired access token — so it was the main way the shared admin client
    // kept getting re-identified as a user.
    pending = createSessionClient().auth
      .refreshSession({ refresh_token: refreshToken })
      .then(result => {
        // Cache only successful rotations — errors must stay retryable.
        if (!result.error && result.data.session) {
          if (recent.size >= MAX_RECENT) {
            // Drop the oldest entries (Map preserves insertion order).
            for (const key of recent.keys()) {
              if (recent.size < MAX_RECENT) break
              recent.delete(key)
            }
          }
          recent.set(refreshToken, { result, at: Date.now() })
        }
        return result
      })
      .finally(() => inflight.delete(refreshToken))
    inflight.set(refreshToken, pending)
  }
  return pending
}
