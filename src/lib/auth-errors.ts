// Single source of truth for classifying a Supabase auth error as *transient*
// (the session is NOT dead — retry) vs *definitive* (the token is revoked/expired
// or the request was rejected — end the session / stop retrying). Three code paths
// depend on this EXACT contract and must agree, or the app logs a user out on one
// path while keeping them in on another — the class of bug that repeatedly bounced
// users to /login:
//   - src/proxy.ts                         middleware fails OPEN on transient (keep the user in)
//   - src/app/api/auth/refresh/route.ts    returns 503 RETRY_LATER + keeps cookies on transient
//   - src/app/forgot-password/page.tsx     shows "try again" on transient instead of a false
//                                          "we've sent a reset link" confirmation
//
// Why these statuses: supabase-js RETURNS these errors (it does not throw). A
// network failure carries status 0 (AuthRetryableFetchError), rate limiting is
// 429, and a Supabase-side outage is 5xx. All server requests share Railway's
// single egress IP, so one abusive client can trip a 429 that must NOT log every
// user out. Only a definitive 4xx (invalid / revoked / expired token, malformed
// request) ends the session. An error object with no readable status is treated
// as transient — the fail-safe choice (never end a session, never claim success,
// on an ambiguous failure).
export function isTransientAuthError(err: { status?: number } | null | undefined): boolean {
  if (!err) return false
  const status = err.status ?? 0
  return status === 0 || status === 429 || status >= 500
}
