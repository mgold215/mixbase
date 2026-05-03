'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

// How many seconds before expiry we proactively refresh.
const REFRESH_BEFORE_EXPIRY_S = 5 * 60 // 5 minutes

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

// Proactively refreshes the session 5 minutes before the access token expires.
// This keeps the user logged in without any interruption and prevents the proxy
// from ever needing to do a mid-request refresh (which caused race conditions).
export default function SessionRefresher() {
  const router = useRouter()

  useEffect(() => {
    if (!isAuthed()) return

    let timer: ReturnType<typeof setTimeout>

    async function scheduleRefresh() {
      const expiresAt = getExpiresAt()
      if (!expiresAt) return

      const nowS = Math.floor(Date.now() / 1000)
      const secondsUntilRefresh = expiresAt - nowS - REFRESH_BEFORE_EXPIRY_S

      // If already within the refresh window (or past expiry), refresh immediately
      const delayMs = Math.max(0, secondsUntilRefresh * 1000)

      timer = setTimeout(async () => {
        try {
          const res = await fetch('/api/auth/refresh', { method: 'POST' })
          if (res.ok) {
            // Token refreshed — schedule the next refresh cycle
            scheduleRefresh()
          } else {
            // Refresh token also expired — send to login
            router.push('/login')
          }
        } catch {
          // Network error — don't redirect; proxy handles this gracefully.
          // Retry after 30 seconds.
          timer = setTimeout(scheduleRefresh, 30_000)
        }
      }, delayMs)
    }

    scheduleRefresh()
    return () => clearTimeout(timer)
  }, [router])

  return null
}
