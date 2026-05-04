// src/lib/rate-limit.ts
// In-process sliding window rate limiter.
//
// Works on a single Railway instance (no Redis needed). Resets on process restart,
// which is acceptable — rate limit state is security-of-convenience, not hard enforcement.
//
// Usage:
//   const rl = rateLimiter({ windowMs: 15 * 60 * 1000, max: 5 })
//   const result = rl.check(ip)
//   if (!result.allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

type Entry = { count: number; resetAt: number }

export function rateLimiter({ windowMs, max }: { windowMs: number; max: number }) {
  const store = new Map<string, Entry>()

  // Periodically evict expired entries so the Map doesn't grow unbounded
  const interval = setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of store) {
      if (now >= entry.resetAt) store.delete(key)
    }
  }, windowMs)

  // Allow GC in test/serverless environments that call clearInterval
  if (interval.unref) interval.unref()

  return {
    check(key: string): { allowed: boolean; remaining: number; resetAt: number } {
      const now = Date.now()
      const existing = store.get(key)

      if (!existing || now >= existing.resetAt) {
        // New window
        const entry: Entry = { count: 1, resetAt: now + windowMs }
        store.set(key, entry)
        return { allowed: true, remaining: max - 1, resetAt: entry.resetAt }
      }

      existing.count++
      const allowed = existing.count <= max
      return { allowed, remaining: Math.max(0, max - existing.count), resetAt: existing.resetAt }
    },
  }
}

// ── Shared limiters (module-level singletons — one per process) ──────────────

// Login: 10 attempts per 15 minutes per IP — stops brute-force credential stuffing
export const loginLimiter = rateLimiter({ windowMs: 15 * 60 * 1000, max: 10 })

// Signup: 5 new accounts per hour per IP — stops bot registration
export const signupLimiter = rateLimiter({ windowMs: 60 * 60 * 1000, max: 5 })

// Artwork generation: 10 per hour per user — cost control before tier gate fully activates
export const artworkLimiter = rateLimiter({ windowMs: 60 * 60 * 1000, max: 10 })

// Upload-url: 30 per hour per user — generous but blocks hammering
export const uploadLimiter = rateLimiter({ windowMs: 60 * 60 * 1000, max: 30 })

// Feedback: 20 per hour per IP — public endpoint, stops spam
export const feedbackLimiter = rateLimiter({ windowMs: 60 * 60 * 1000, max: 20 })

// ── Helper to extract a usable key from a request ────────────────────────────
// Prefers X-Forwarded-For (set by Railway's proxy) over the raw IP.
export function ipKey(request: { headers: { get(name: string): string | null } }): string {
  const forwarded = request.headers.get('x-forwarded-for')
  return (forwarded?.split(',')[0]?.trim()) ?? 'unknown'
}
