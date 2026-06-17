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
    check(key: string): RateLimitResult {
      const now = Date.now()
      const existing = store.get(key)

      if (!existing || now >= existing.resetAt) {
        // New window
        const entry: Entry = { count: 1, resetAt: now + windowMs }
        store.set(key, entry)
        return { allowed: true, limit: max, remaining: max - 1, resetAt: entry.resetAt }
      }

      existing.count++
      const allowed = existing.count <= max
      return { allowed, limit: max, remaining: Math.max(0, max - existing.count), resetAt: existing.resetAt }
    },
  }
}

// Shape returned by check(). `limit` is the window cap, `remaining` the credits
// left, `resetAt` the epoch-ms when the window rolls over.
export type RateLimitResult = { allowed: boolean; limit: number; remaining: number; resetAt: number }

// Standard rate-limit response headers built from a check() result. Spread onto
// any 429 so clients can back off intelligently instead of hammering blindly:
//   return NextResponse.json({ error: '…' }, { status: 429, headers: rateLimitHeaders(result) })
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const retryAfterSec = Math.max(0, Math.ceil((result.resetAt - Date.now()) / 1000))
  return {
    'Retry-After': String(retryAfterSec),
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(Math.ceil(result.resetAt / 1000)),
  }
}

// ── Shared limiters (module-level singletons — one per process) ──────────────

// Login: 10 attempts per 15 minutes per IP — stops brute-force credential stuffing
export const loginLimiter = rateLimiter({ windowMs: 15 * 60 * 1000, max: 10 })

// Signup: 5 new accounts per hour per IP — stops bot registration
export const signupLimiter = rateLimiter({ windowMs: 60 * 60 * 1000, max: 5 })

// Artwork generation: 10 per hour per user — cost control before tier gate fully activates
export const artworkLimiter = rateLimiter({ windowMs: 60 * 60 * 1000, max: 10 })

// Video generation: 5 per hour per user — Runway image-to-video is the single most
// expensive AI call in the app. Defence-in-depth alongside the monthly tier gate.
export const videoLimiter = rateLimiter({ windowMs: 60 * 60 * 1000, max: 5 })

// Upload-url: 30 per hour per user — generous but blocks hammering
export const uploadLimiter = rateLimiter({ windowMs: 60 * 60 * 1000, max: 30 })

// Feedback: 20 per hour per IP — public endpoint, stops spam
export const feedbackLimiter = rateLimiter({ windowMs: 60 * 60 * 1000, max: 20 })

// Chat (Claude): 20 per hour per user — caps Anthropic spend per account
export const chatLimiter = rateLimiter({ windowMs: 60 * 60 * 1000, max: 20 })

// SubmitBase writes (curator add/import + submission log): 120 per hour per
// user. Generous enough for a real CSV import session, low enough to stop a
// runaway client loop from flooding the directory or activity log.
export const sbWriteLimiter = rateLimiter({ windowMs: 60 * 60 * 1000, max: 120 })

// ── Helper to extract a usable key from a request ────────────────────────────
// Prefers X-Forwarded-For (set by Railway's proxy) over the raw IP.
export function ipKey(request: { headers: { get(name: string): string | null } }): string {
  const forwarded = request.headers.get('x-forwarded-for')
  return (forwarded?.split(',')[0]?.trim()) ?? 'unknown'
}
