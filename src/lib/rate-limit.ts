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

    // Give back a credit consumed by a prior check() whose work never actually
    // ran (e.g. the request was rejected downstream before doing anything). The
    // window should count work performed, not rejected attempts. No-op if the
    // window has already rolled over or the count is already at zero.
    rollback(key: string) {
      const entry = store.get(key)
      if (entry && Date.now() < entry.resetAt && entry.count > 0) entry.count--
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

// Final video renders (YouTube/Shorts): 6 per hour per user — each render pins
// a CPU core for minutes, so this is server protection more than cost control.
export const finalVideoLimiter = rateLimiter({ windowMs: 60 * 60 * 1000, max: 6 })

// Visualizer saves: 20 per hour per user. Since 2026-08-03 this route forks
// libx264 to normalize the browser's WebM to iOS-playable MP4, so a POST is no
// longer free bookkeeping — it is CPU work on the shared container, and unlike
// the final renders it is NOT behind MAX_CONCURRENT. Sized well above a real
// session (one save per render) and far below anything that could starve the
// box alongside an in-flight render.
export const vizSaveLimiter = rateLimiter({ windowMs: 60 * 60 * 1000, max: 20 })

// Server-side free visualizer renders: 10 per hour per user. Each render is a
// full ffmpeg encode (up to 30s of 1080p, measured ~2-16s of pinned CPU), and
// like the visualizer saves it shares the 2-slot encoder gate — this limiter
// caps how often one user can ask, the gate caps how many run at once.
export const freeRenderLimiter = rateLimiter({ windowMs: 60 * 60 * 1000, max: 10 })

// Loudness writes: 60 per hour per user. The expensive half of a master check
// happens in the BROWSER (decode + BS.1770 filtering), so this route costs the
// server one small update — the cap exists to bound a runaway client or a
// re-measure loop, not spend. Sized well above a real session (one write per
// mix measured, plus a one-off silent backfill per version whose reading is
// still sitting in localStorage from before persistence existed).
export const loudnessLimiter = rateLimiter({ windowMs: 60 * 60 * 1000, max: 60 })

// Feedback: 20 per hour per IP — public endpoint, stops spam
export const feedbackLimiter = rateLimiter({ windowMs: 60 * 60 * 1000, max: 20 })

// Chat (Claude): 20 per hour per user — caps Anthropic spend per account
export const chatLimiter = rateLimiter({ windowMs: 60 * 60 * 1000, max: 20 })

// Feed comments: 30 per hour per user — every comment is visible to all
// artists, so this stops a runaway client or spammy account from flooding the
// community feed.
export const feedCommentLimiter = rateLimiter({ windowMs: 60 * 60 * 1000, max: 30 })

// Content reports + user blocks (UGC moderation, Guideline 1.2). Generous —
// blocking a spammer's whole comment history takes several actions in a row.
export const moderationLimiter = rateLimiter({ windowMs: 60 * 60 * 1000, max: 60 })

// Catalog lookups (Spotify/Deezer discography + ISRC pull): 10 per hour per
// user — each lookup fans out into dozens of upstream API calls, and a
// catalog rarely changes mid-session.
export const catalogLimiter = rateLimiter({ windowMs: 60 * 60 * 1000, max: 10 })

// SubmitBase writes (curator add/import + submission log): 120 per hour per
// user. Generous enough for a real CSV import session, low enough to stop a
// runaway client loop from flooding the directory or activity log.
export const sbWriteLimiter = rateLimiter({ windowMs: 60 * 60 * 1000, max: 120 })

// Artwork history browse + restore: 120 per hour per user. Deliberately NOT
// sharing a sibling limiter, which is this file's usual convention — the
// nearest candidates all carry a written rationale about work this route does
// not do (vizSaveLimiter is sized around an ffmpeg fork, artworkLimiter around
// Replicate spend), and a shared limiter whose comment describes different work
// is worse documentation than an honest new one. A GET here is one storage
// listing plus one row read, and a POST is a single UPDATE; the cap exists to
// bound a runaway client, not spend. Sized for the project page firing a GET on
// every Artwork-tab open across a long session.
export const artworkHistoryLimiter = rateLimiter({ windowMs: 60 * 60 * 1000, max: 120 })

// ── Helper to extract a usable key from a request ────────────────────────────
// Only three limiters are keyed by IP — login (10/15min), signup (5/hr) and
// public feedback (20/hr). Everything else is keyed by authenticated user, so
// this function is the whole defence against an anonymous attacker.
//
// USE X-Real-IP, NOT X-Forwarded-For. Railway documents exactly which headers
// its edge provides, and `X-Real-IP` is named as *the* client-IP header while
// `X-Forwarded-For` is not listed at all:
//   https://docs.railway.com/networking/public-networking/specs-and-limits
// That also dissolves the leftmost-vs-rightmost argument this codebase has
// carried unresolved for four runs: X-Real-IP is single-valued, so there is no
// chain to pick from and nothing for a client to prepend. XFF is kept only as a
// fallback, and we take its LAST segment — the entry closest to the edge, and
// the only one a client cannot forge by prepending. (The previous code took the
// FIRST segment, which is the attacker-controlled end if the edge appends.)
//
// The `|| null` matters: an empty or whitespace-only header must fall through
// rather than become a key.
export function ipKey(request: { headers: { get(name: string): string | null } }): string {
  const pick = (header: string | null) => header?.split(',').pop()?.trim() || null
  const key = pick(request.headers.get('x-real-ip')) ?? pick(request.headers.get('x-forwarded-for'))
  if (key) return key

  // NEVER return a shared constant here. The old fallback was the literal
  // string 'unknown', which put every unidentifiable caller in ONE bucket — so
  // a single header-less client could exhaust the global 10-per-15-minutes
  // login budget and lock every real user out of signing in. That is a
  // self-inflicted outage triggered by the defence itself.
  //
  // A per-request key means we cannot rate-limit a caller we cannot identify,
  // which is the lesser evil and is unreachable in production: Railway's edge
  // always sets X-Real-IP, so this branch only fires for direct container
  // access (local dev). Reported once per process so that if it ever DOES fire
  // in production we find out from Sentry rather than from a support ticket.
  reportUnkeyedRequest()
  return `unkeyed:${crypto.randomUUID()}`
}

let unkeyedReported = false
function reportUnkeyedRequest() {
  if (unkeyedReported) return
  unkeyedReported = true
  console.warn('[rate-limit] request carried neither X-Real-IP nor X-Forwarded-For')
  // Sentry is imported LAZILY and defensively. This module is a dependency-free
  // hot-path util that the test suite loads under plain Node type-stripping; a
  // static `@sentry/nextjs` import makes it unloadable outside the Next runtime
  // (verified: `Sentry.captureMessage is not a function`). Keeping the import
  // inside the rarely-taken branch preserves both the signal and the testability.
  import('@sentry/nextjs')
    .then(S => S.captureMessage?.('rate-limit: request carried neither X-Real-IP nor X-Forwarded-For', { level: 'warning' }))
    .catch(() => {})
}

// ── Owner-exempt user limits ─────────────────────────────────────────────────
// Per-user rate limits don't apply to the platform owner ("no limits" is a
// product rule, not just a tier perk). IP-keyed limiters (login, signup,
// public feedback) are untouched — those defend against outsiders. The owner
// lookup is cached per process in tier.ts, so after the first call this is a
// map hit plus the normal sync check.
export async function checkUserLimit(
  limiter: { check(key: string): RateLimitResult },
  userId: string,
): Promise<RateLimitResult> {
  const { isPlatformOwner } = await import('./tier')
  if (await isPlatformOwner(userId)) {
    return { allowed: true, limit: Number.MAX_SAFE_INTEGER, remaining: Number.MAX_SAFE_INTEGER, resetAt: Date.now() }
  }
  return limiter.check(userId)
}
