---
name: auth-and-security
description: How mixBASE knows who is calling and what must stay locked - the X-User-Id header, access-token checks in src/proxy.ts, public paths, owner-only and admin gating, Supabase API keys, rate limits, security headers and CSP, and the rules left by the 2026-10-21 Railway breach. Use before changing an API route's auth, the middleware, next.config.ts headers, a key or environment variable, a rate limit, or anything that decides who may see or do something.
---

# Auth and security

## Who is calling

- Routes read the user from the **`X-User-Id` header**, injected by the middleware in `src/proxy.ts` (there is no `src/middleware.ts`). **Never from the request body**: a route trusting `body.userId` is an account-takeover bug.
- Sign-in: Supabase Auth, email + password. `POST /api/auth` sets the `sb-access-token` + `sb-refresh-token` cookies; `POST /api/auth/signup` creates accounts.
- The middleware verifies the access token locally with `verifyAccessToken()`: ES256/RS256 against the project's public JWKS, legacy HS256 against `SUPABASE_JWT_SECRET`. No round-trip to Supabase either way. It refreshes an expired token.
- It also accepts `Authorization: Bearer <token>`, which is how the apps call the API.
- `SUPABASE_JWT_SECRET` is legacy and leaked in the Railway breach. Once the project signs with JWT signing keys it is deleted from Railway on purpose. With it unset, production confirms HS256 tokens through a cached `getUser()` call and never decodes them unverified. Don't "fix" its absence by adding it back.

## Public paths

`src/proxy.ts` has two lists:

- `PUBLIC_EXACT`: single routes that are public, matched exactly (e.g. `/api/auth`, `/api/feedback`, `/api/health`).
- `PUBLIC_PATHS`: prefixes, matched with `startsWith()`. Anything ever added under one is public and must protect itself.

Rules:

- Trailing slashes are load-bearing. `/api/artwork` without one made every sibling route public; an artwork-history route nearly shipped with no auth that way (2026-08-21).
- A single public route goes in `PUBLIC_EXACT`, never in `PUBLIC_PATHS`.
- `/api/audio/` and `/api/artwork/` must stay public (share pages and the app's lock screen fetch them without a cookie). `/api/tus` must never be public.
- `/api/share/` is public: every route under it must gate on the share token (see the `share-pages` skill).
- Never put an owner-only route under a public prefix. That is why Cassette Studio lives at `/api/cassette-studio/*` and not under `/api/artwork/`.

## Owner-only and admin

- Owner-only tools (Cassette Studio, Mix Check): every handler 404s unless `isAdminIdentity` (`src/lib/admin-identity.ts`). Clients learn it from `GET /api/auth/me` → `owner_tools`, never from `profiles.is_owner`.
- `/admin`, `/api/admin/*` and `/api/infra/*` pass through `withAdminCheck` in `src/proxy.ts`.
- `ADMIN_USER_IDS` (comma-separated user ids) adds an admin without a code change. It is normally unset. Production reads it at deploy.
- The owner's unlimited allowance comes from `isPlatformOwner` (`src/lib/tier.ts`): identity, not a purchase. `profiles.subscription_tier` is informational (`admin` / `free`); never gate anything on it.
- The set of owner emails in `admin-identity.ts` was wrong until 2026-09-01. Verify against `auth.users` before editing it.

## Supabase keys

- Clients (web, iOS/macOS, the CI seed script) use the **publishable** key (`sb_publishable_…`). The server uses a **secret** key (`sb_secret_…`) in `SUPABASE_SERVICE_ROLE_KEY`, which is required, server-only, and bypasses RLS and storage limits.
- An `sb_` key goes in the `apikey` header only. Sent as `Authorization: Bearer` it is rejected. For a raw `fetch()` to Supabase use `serviceKeyHeaders()` (`src/lib/service-key.ts`).
- `scripts/supabase-keys-test.mjs` fails the build if a legacy JWT key or a Bearer-sent key comes back.
- The legacy anon/service_role keys and the JWT secret can only be retired together, once no installed app version still sends the legacy anon key.
- The same Supabase project serves a separate **trading bot** on Railway (`python-requests`, daily 21:00 UTC, `trading_*` tables). It also needs the new secret key before the legacy keys are disabled.

## The Railway breach (2026-10-21)

- Railway disclosed that an intruder may have decrypted customer environment variables.
- **Treat every value ever stored in Railway as leaked. Never put one back.**
- Forensics on 10-23 (Supabase edge/auth/storage logs since 10-20, GitHub) found no misuse.
- Checklist and current status: `docs/security/2026-10-21-railway-breach.md`.

## Rate limits

All limits are in `src/lib/rate-limit.ts`. They live in one process's memory, so each of production's two processes counts separately and every deploy resets them. **That is intentional.** Don't move them to Redis or the database, and don't report the reset as a bug. Finished-video renders are also capped at 2 at a time per process (`src/lib/video-jobs.ts`).

## Headers and CSP

Set in `next.config.ts`.

- `img-src` must include `https://*.replicate.delivery` and `connect-src` must include `https://api.replicate.com`, or artwork generation breaks. Never tighten the CSP without running the artwork flow end to end.
- Keep the security headers (X-Frame-Options, HSTS, nosniff and the rest) through any refactor.
- `outputFileTracingIncludes` in the same file carries bundled fonts to Railway (see the `artwork-and-video` skill).

## Secrets and the public repository

- The repository is public. No secrets in code, docs, tests or commit messages; no tax ids or personal email addresses either (an EIN and an Apple ID email were removed 2026-11-14).
- The pre-commit gitleaks hook and the **Secret Scanning** CI check scan for secrets. Fix the leak; never use `--no-verify`.

## Checking a change

In `npm test`: `verify-token`, `auth-errors`, `supabase-keys`, `admin-identity`, `admin-client-role`, `rate-limit-key`, `public-input-caps`, `write-route-guards`, `profiles-rls` (each is `scripts/<name>-test.mjs`).
