import {
  createRemoteJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  jwtVerify,
  errors as joseErrors,
} from 'jose'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase'

// Result of inspecting an access-token cookie.
//  - userId:   the `sub` claim if we could read it, else null
//  - expired:  the signature was verified and the token has passed its `exp` —
//              the ONLY outcome where the caller should refresh the session
//  - verified: the signature was cryptographically checked
//  - reason:   why verification landed where it did:
//      'valid'         signature good, not expired — trust userId
//      'expired'       signature good, past exp — refresh is appropriate
//      'unverifiable'  we could NOT check the signature (no secret configured,
//                      secret/alg mismatch, JWKS unreachable). The token may be
//                      perfectly fine — the caller must confirm identity another
//                      way (network getUser), NOT refresh. Treating this as
//                      "expired" made the middleware refresh on EVERY request,
//                      rotating the refresh token every few seconds until a
//                      reuse race tripped GoTrue's abuse detection and revoked
//                      the whole session (the "random logout" bug).
//      'malformed'     not decodable as a JWT at all — never trust it
export type TokenCheck = {
  userId: string | null
  expired: boolean
  verified: boolean
  reason: 'valid' | 'expired' | 'unverifiable' | 'malformed'
}

// Build the HMAC key once from SUPABASE_JWT_SECRET. Legacy Supabase projects
// sign access tokens with HS256 using this shared secret. Projects migrated to
// the newer asymmetric signing keys issue ES256/RS256 tokens instead — those
// are verified against the project's public JWKS (fetched once and cached by
// jose, with cooldown/backoff built in).
export function makeJwtKey(secret: string | undefined): Uint8Array | null {
  if (!secret) return null
  return new TextEncoder().encode(secret.trim())
}

// Lazily-created remote JWKS for asymmetric (ES256/RS256) access tokens.
// jose caches the key set in memory and only refetches on unknown `kid` or
// after its cooldown, so this does NOT add a network call per request.
// Stored on globalThis so the middleware and route-handler bundles share one
// cache instead of each fetching their own.
type JwksResolver = ReturnType<typeof createRemoteJWKSet>
const JWKS_KEY = '__mb_jwks__'
function getJwks(): JwksResolver {
  const g = globalThis as Record<string, unknown>
  if (!g[JWKS_KEY]) {
    g[JWKS_KEY] = createRemoteJWKSet(
      new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`),
      // Supabase's API gateway requires the (public) apikey header
      { headers: { apikey: SUPABASE_ANON_KEY } },
    )
  }
  return g[JWKS_KEY] as JwksResolver
}

function expiredResult(token: string): TokenCheck {
  // jose verifies the signature BEFORE checking `exp`, so JWTExpired means the
  // signature was valid — the token is just stale. Safe to read `sub` and let
  // the caller refresh.
  try {
    const sub = decodeJwt(token).sub
    return {
      userId: typeof sub === 'string' ? sub : null,
      expired: true,
      verified: true,
      reason: 'expired',
    }
  } catch {
    return { userId: null, expired: true, verified: false, reason: 'malformed' }
  }
}

// Inspect an access token. HS256 tokens are verified against the shared secret
// (`key`); ES256/RS256 tokens against the project JWKS. A token whose signature
// cannot be checked (missing secret, wrong secret, JWKS unreachable) comes back
// `unverifiable` — its claims are decoded for observability but MUST NOT be
// trusted, and it must NOT be treated as expired.
export async function verifyAccessToken(
  token: string,
  key: Uint8Array | null,
): Promise<TokenCheck> {
  let alg: string | undefined
  let sub: string | null = null
  let exp: number | null = null
  try {
    alg = decodeProtectedHeader(token).alg
    const payload = decodeJwt(token)
    sub = typeof payload.sub === 'string' ? payload.sub : null
    exp = typeof payload.exp === 'number' ? payload.exp : null
  } catch {
    return { userId: null, expired: true, verified: false, reason: 'malformed' }
  }

  // Asymmetric tokens (project migrated to JWT signing keys): verify via JWKS.
  if (alg === 'ES256' || alg === 'RS256') {
    try {
      const { payload } = await jwtVerify(token, getJwks(), { algorithms: [alg] })
      return {
        userId: typeof payload.sub === 'string' ? payload.sub : null,
        expired: false,
        verified: true,
        reason: 'valid',
      }
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) return expiredResult(token)
      if (
        err instanceof joseErrors.JWSSignatureVerificationFailed ||
        err instanceof joseErrors.JWSInvalid ||
        err instanceof joseErrors.JWTInvalid
      ) {
        return { userId: null, expired: true, verified: false, reason: 'malformed' }
      }
      // JWKS unreachable / no matching kid yet — cannot check the signature.
      return { userId: sub, expired: false, verified: false, reason: 'unverifiable' }
    }
  }

  // Symmetric (legacy) tokens: verify against SUPABASE_JWT_SECRET.
  if (key && alg === 'HS256') {
    try {
      const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] })
      return {
        userId: typeof payload.sub === 'string' ? payload.sub : null,
        expired: false,
        verified: true,
        reason: 'valid',
      }
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) return expiredResult(token)
      if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
        // Either a forged token or a WRONG SUPABASE_JWT_SECRET. We can't tell
        // which locally, so surface `unverifiable` and let the caller decide
        // via a network check — a wrong secret must not log real users out.
        return { userId: sub, expired: false, verified: false, reason: 'unverifiable' }
      }
      return { userId: null, expired: true, verified: false, reason: 'malformed' }
    }
  }

  // No secret configured (or an alg we don't handle, e.g. {alg:'none'}):
  // decode-only, so the signature was NOT checked. `expired` still reports the
  // token's own `exp` so the dev decode-only path can slide a stale session
  // forward — but the reason stays 'unverifiable', NEVER 'expired'.
  //
  // SECURITY: 'expired' means "signature verified, just past exp" and the
  // middleware trusts that token's `sub` as X-User-Id on the strength of the
  // verified signature. Labeling an UNVERIFIED token 'expired' here (which the
  // old `selfExpired ? 'expired' : …` did) let a forged {alg:'none'} token — or
  // ANY token while SUPABASE_JWT_SECRET is unset — carry an attacker-chosen
  // `sub` into that trusted branch and impersonate a user during a transient
  // refresh error. An unverifiable token must be confirmed by a network
  // getUser() in prod, not trusted, so it always routes through 'unverifiable'.
  const nowS = Math.floor(Date.now() / 1000)
  const selfExpired = exp !== null && exp < nowS
  return {
    userId: sub,
    expired: selfExpired,
    verified: false,
    reason: 'unverifiable',
  }
}
