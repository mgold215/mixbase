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
- The middleware verifies `sb-access-token` locally against `SUPABASE_JWT_SECRET` (HS256, no Supabase round-trip) and also accepts `Authorization: Bearer <token>` for the iOS app. Without `SUPABASE_JWT_SECRET` set, tokens are decoded UNVERIFIED — it's required on staging and prod.

## Rate limits

All rate limits are in-process and **reset on every deploy — intentionally**. Don't move them to Redis/DB or flag the reset as a bug. Current limits: login 10/15min·IP, signup 5/hr·IP, artwork 10/hr·user, upload-url 30/hr·user, feedback 20/hr·IP, feed comments 30/hr·user, chat 20/hr·user, final video 6/hr·user + max 2 concurrent renders/process.

## Database & RLS

- Migrations live in `supabase/migrations/`, numbered sequentially. New tables take a `mb_` prefix, a `user_id` column, and owner-only RLS — **except** `mb_feed_comments`, which is deliberately cross-user (all signed-in users read all rows; insert/delete own only). Don't "fix" the feed's RLS to owner-only; the community feed is cross-user by design.
- Quota RPCs (`increment_artwork_usage`, `increment_video_usage`) are atomic on purpose; on any post-reserve failure, refund the reserved slot (see `src/lib/tier.ts`).

## Next.js

This repo uses a Next.js version with **breaking changes vs. training data**. Before writing Next-specific code (routing, config, metadata, server components), read the relevant guide in `node_modules/next/dist/docs/` — don't assume the API you remember exists.

## Working style

- Always use the API or CLI; Playwright/DevTools MCP are last resorts.
- Never tell the user to do something manually, and never say something can't be done without attempting it first.
- moodmixformat, LLC already exists (EIN 39-2854188) — never suggest forming an entity.
