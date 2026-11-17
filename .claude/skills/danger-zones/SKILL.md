---
name: danger-zones
description: Per-file traps in the mixbase codebase where a reasonable-looking edit breaks production. Consult BEFORE editing next.config.ts, src/lib/video-render.ts, any API route's auth/identity handling, rate limiting, Supabase migrations, or anything Next.js-specific. Also use when a behavior looks like a bug you're tempted to "fix" — several oddities here are deliberate.
---

# Danger Zones

Each entry: the file or area, the trap, and why it's shaped the way it is.

## `next.config.ts`

- **CSP**: `img-src` must include `https://*.replicate.delivery` and `connect-src` must include `https://api.replicate.com`, or artwork generation breaks. Never tighten CSP without exercising the artwork flow end-to-end.
- **`outputFileTracingIncludes`**: traces the bundled font used by `/api/finalize-artwork` (`opentype.js` text overlay). Removing or "cleaning up" this config makes the route crash **only on Railway** — it works locally, so the build passes and prod breaks.
- Security headers (X-Frame-Options, HSTS, nosniff, etc.) are set here — don't drop them in a refactor.

## `src/lib/video-render.ts` + `/api/finalize-video`

- ffmpeg comes from `@ffmpeg-installer` — a **2018 build with no `xfade` filter**. Crossfade is deliberately implemented as trim/concat/fade/overlay. Don't "simplify" it to `xfade`; it will fail at runtime.
- Video finalize jobs are **in-process async** (POST starts, GET polls) and are **lost on deploy by design**. That's accepted behavior, not a bug to fix with a queue.

## Auth & identity in API routes

- Routes read the user from the **`X-User-Id` header** injected by `src/proxy.ts` — **never from the request body**. A route trusting `body.userId` is an account-takeover bug.
- The middleware verifies `sb-access-token` locally — ES256/RS256 tokens against the project's public JWKS, legacy HS256 tokens against `SUPABASE_JWT_SECRET` — and also accepts `Authorization: Bearer <token>` for the iOS app. With the secret unset, prod confirms HS256 tokens via a cached `getUser()` call (only dev decodes them unverified). The secret leaked in the 2026-10-21 Railway breach: after the rotation to JWT signing keys it is deleted from Railway on purpose — don't "fix" its absence by re-adding it.
- Supabase keys: clients (web, iOS/macOS, the CI seed script) use the publishable key (`sb_publishable_…`), the server a secret key (`sb_secret_…`) in `SUPABASE_SERVICE_ROLE_KEY`. An `sb_` key goes in the `apikey` header only — never `Authorization: Bearer` (rejected). For raw `fetch()` to Supabase use `serviceKeyHeaders()` from `src/lib/service-key.ts`; `scripts/supabase-keys-test.mjs` fails the build if a legacy JWT key or a Bearer-sent key comes back.
- The legacy anon/service_role keys + JWT secret can only be retired together, once no installed app version still sends the legacy anon key. The same Supabase project serves a separate **trading bot** on Railway (`python-requests`, daily 21:00 UTC, `trading_*` tables): it also needs the new secret key before legacy keys are disabled. Checklist and status: `docs/security/2026-10-21-railway-breach.md`.
- `/api/cassette-studio/*` and other owner-only routes 404 unless `isAdminIdentity`. Never put an owner-only route under a public prefix (`/api/artwork/`, `/api/audio/`, `/api/share/`): matching in `src/proxy.ts` is `startsWith()`, so everything under a public prefix is public.

## Infra control panel (`src/lib/infra/`, `/api/infra/*`)

- Admin-gated by `assertAdmin` via `withAdminCheck` in `src/proxy.ts`: read-only `GET /api/infra/{topology,railway,supabase,github,sentry}`, `POST /api/infra/chat` (Claude tool-loop), `POST /api/infra/actions`.
- Actions are confirmation-gated and reversible only (Railway restart/redeploy, CI re-run). Don't add a destructive one.
- Read endpoints return `configured:false` on missing tokens, never 500.

## Rate limits

All rate limits are in-process and **reset on every deploy — intentionally**. Don't move them to Redis/DB or flag the reset as a bug. Current limits: login 10/15min·IP, signup 5/hr·IP, artwork 10/hr·user, upload-url 30/hr·user, feedback 20/hr·IP, feed comments 30/hr·user, chat 20/hr·user, final video 6/hr·user + max 2 concurrent renders/process, catalog lookup 10/hr·user.

## Database & RLS

- Migrations live in `supabase/migrations/`, numbered sequentially. New tables take a `mb_` prefix, a `user_id` column, and owner-only RLS — **except** `mb_feed_comments`, which is deliberately cross-user (all signed-in users read all rows; insert/delete own only). Don't "fix" the feed's RLS to owner-only; the community feed is cross-user by design.
- **Not every table has a `user_id` column** (verified 2026-08-30): `mb_versions`, `mb_feedback` and `mb_collection_items` have none, and `profiles` keys on `id`. They scope TRANSITIVELY and correctly, e.g. `mb_versions.users_own_versions` = `project_id in (select id from mb_projects where user_id = auth.uid())`. Check the actual column list before writing a policy or a filter against one of those.
- The table list is the migrations, not a document: a list kept here went stale. Two things the schema won't tell you: `profiles` still carries legacy Stripe/Apple columns (`stripe_customer_id`, `stripe_subscription_id`, `apple_original_transaction_id`) that nothing uses, and `profiles.subscription_tier` is informational only. `mb_usage` holds per-user monthly artwork/video counts keyed `YYYY-MM`; `mb_library_tracks` is the released-track library (ISRC/UPC/dates synced from Spotify/Deezer, migration 027); `mb_feed_comments` is migration 022.
- Quota RPCs (`increment_artwork_usage(p_user_id, p_month)`, `increment_video_usage(p_user_id, p_month)`) are atomic on purpose; on any post-reserve failure, refund the reserved slot (see `src/lib/tier.ts`).

## Next.js

This repo uses a Next.js version with **breaking changes vs. training data**. Before writing Next-specific code (routing, config, metadata, server components), read the relevant guide in `node_modules/next/dist/docs/` — don't assume the API you remember exists.
