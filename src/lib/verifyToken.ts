import { decodeJwt, jwtVerify, errors as joseErrors } from 'jose'

// Result of inspecting an access-token cookie.
//  - userId:   the `sub` claim if we could read it, else null
//  - expired:  the token's signature was fine but it has passed its `exp`
//              (caller should try a refresh), OR we could not trust it at all
//  - verified: the signature was cryptographically checked against the secret.
//              false means either no secret is configured (legacy fallback) or
//              the signature did not match (forged / tampered token).
export type TokenCheck = {
  userId: string | null
  expired: boolean
  verified: boolean
}

// Build the HMAC key once from SUPABASE_JWT_SECRET. Supabase signs its access
// tokens with HS256 using this shared secret (visible in the alg header of the
// anon/service keys). When the env var is absent we fall back to UNVERIFIED
// decoding so the app keeps working — but that leaves an auth-bypass open, so
// setting the secret in production is strongly recommended.
export function makeJwtKey(secret: string | undefined): Uint8Array | null {
  if (!secret) return null
  return new TextEncoder().encode(secret)
}

// Inspect an access token. When `key` is provided the signature is verified
// (HS256); a forged or tampered token returns { userId: null, verified: false }
// so the middleware refuses to trust it. When `key` is null we decode without
// verifying — legacy behaviour, used only until SUPABASE_JWT_SECRET is set.
export async function verifyAccessToken(
  token: string,
  key: Uint8Array | null,
): Promise<TokenCheck> {
  if (key) {
    try {
      const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] })
      return {
        userId: typeof payload.sub === 'string' ? payload.sub : null,
        expired: false,
        verified: true,
      }
    } catch (err) {
      // jose verifies the signature BEFORE checking `exp`, so a JWTExpired
      // error means the signature was valid — the token is just stale. It is
      // therefore safe to read its `sub` and let the caller refresh.
      if (err instanceof joseErrors.JWTExpired) {
        try {
          const sub = decodeJwt(token).sub
          return {
            userId: typeof sub === 'string' ? sub : null,
            expired: true,
            verified: true,
          }
        } catch {
          return { userId: null, expired: true, verified: false }
        }
      }
      // Bad signature, wrong alg, or malformed token — do NOT trust it.
      return { userId: null, expired: true, verified: false }
    }
  }

  // ── No secret configured: legacy decode-only fallback (UNVERIFIED) ──────────
  try {
    const payload = decodeJwt(token)
    const exp = typeof payload.exp === 'number' ? payload.exp : null
    return {
      userId: typeof payload.sub === 'string' ? payload.sub : null,
      expired: exp !== null ? exp < Math.floor(Date.now() / 1000) : false,
      verified: false,
    }
  } catch {
    return { userId: null, expired: true, verified: false }
  }
}
