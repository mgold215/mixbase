'use client'

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'

// How many seconds before expiry we proactively refresh.
const REFRESH_BEFORE_EXPIRY_S = 5 * 60 // 5 minutes
// Random 0-60s jitter so multiple tabs don't all fire at the same instant.
const MAX_JITTER_S = 60

// Reads the sb-expires-at cookie (non-httpOnly, set by login/refresh routes).
function getExpiresAt(): number | null {
  if (typeof document === 'undefined') return null
  const match = document.cookie.match(/(?:^|;\s*)sb-expires-at=(\d+)/)
  return match ? parseInt(match[1], 10) : null
}

function isAuthed(): boolean {
  if (typeof document === 'undefined') return false
  return document.cookie.includes('sb-authed=1')
}

// Proactively refreshes the session 5 minutes before the access token expires,
// so the proxy never needs a mid-request refresh (which races under load).
//
// Mounted once in the root layout, so the effect re-runs on every pathname
// change — that is what arms the timer right after login (router.push to
// /dashboard) and disarms it after logout (cookies gone, isAuthed() false).
// Multi-tab safety: the sb-expires-at cookie is shared across tabs, so each
// tab re-checks it when its timer fires and skips the refresh if another tab
// already renewed the session; the jitter makes simultaneous fires rare and
// the server-side single-flight absorbs the rest.
export default function SessionRefresher() {
  const pathname = usePathname()

  useEffect(() => {
    if (!isAuthed()) return

    let timer: ReturnType<typeof setTimeout> | undefined
    let cancelled = false

    // The single scheduling point for the next fire(). It ALWAYS clears any
    // pending timer first, so one can never be orphaned. This matters because
    // fire() is async: while it awaits the refresh fetch, onWake() → arm() can
    // set a fresh timer; if the retry branches below did a bare
    // `timer = setTimeout(...)` (as they used to), they'd overwrite that
    // reference without clearing it, leaving a live orphan and forking a second
    // self-perpetuating 30s retry loop — multiplying with each wake and
    // hammering /api/auth/refresh during exactly the outage the backoff exists
    // to ride out. Routing every schedule through here eliminates that class.
    function schedule(delayMs: number) {
      if (cancelled) return
      clearTimeout(timer)
      timer = setTimeout(fire, delayMs)
    }

    function arm() {
      if (cancelled || !isAuthed()) return
      const expiresAt = getExpiresAt()
      if (!expiresAt) return

      const nowS = Math.floor(Date.now() / 1000)
      const jitterS = Math.random() * MAX_JITTER_S
      const delayMs = Math.max(0, (expiresAt - nowS - REFRESH_BEFORE_EXPIRY_S - jitterS) * 1000)
      schedule(delayMs)
    }

    async function fire() {
      if (cancelled || !isAuthed()) return

      // Another tab may have refreshed already — the cookie is shared, so if
      // expiry moved comfortably past our window, just reschedule.
      const expiresAt = getExpiresAt()
      const nowS = Math.floor(Date.now() / 1000)
      if (expiresAt && expiresAt - nowS > REFRESH_BEFORE_EXPIRY_S + MAX_JITTER_S) {
        arm()
        return
      }

      try {
        const res = await fetch('/api/auth/refresh', { method: 'POST' })
        if (cancelled) return
        if (res.ok) {
          arm()
        } else if (res.status === 401) {
          // Refresh token expired/revoked — cookies were cleared by the server.
          // Hard navigation (not router.push): it resets the client router
          // cache, which may hold login redirects for routes requested while
          // the session died — an SPA nav would replay those after re-login.
          window.location.assign('/login')
        } else {
          // 503/anything else — Supabase blip or rate limit; the session is
          // still alive server-side. Retry, never log the user out for this.
          schedule(30_000)
        }
      } catch {
        // Network error — don't redirect; proxy handles this gracefully.
        schedule(30_000)
      }
    }

    // Re-arm when the app wakes up (laptop sleep, PWA resume) — the timer may
    // have fired late or the token may already be inside the refresh window.
    function onWake() {
      if (document.visibilityState === 'visible') arm()
    }

    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('focus', onWake)
    arm()

    return () => {
      cancelled = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('focus', onWake)
    }
  }, [pathname])

  return null
}
