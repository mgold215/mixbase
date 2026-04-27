# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

# Architecture: Critical Constraints

## Upload — Never Route File Bytes Through Railway
Railway's proxy truncates request bodies above 10 MB (10,485,760 bytes exactly). This is infrastructure, not a code bug.

**Active path (audio uploads in ProjectClient.tsx) — Signed URL:**
- `POST /api/upload-url` — server generates a short-lived Supabase signed upload URL
- Browser PUTs directly to Supabase — Railway is never in the byte path
- Implementation: `src/app/api/upload-url/route.ts` + `ProjectClient.tsx` `handleUploadSubmit()`

**Also available — TUS chunked proxy (resumable uploads):**
- `POST /api/tus` — creates TUS session at Supabase using service-role key (bypasses anon 50 MB limit)
- `PATCH /api/tus/<uploadId>` — proxies one 8 MB chunk to Supabase (under Railway's 10 MB wall)
- `HEAD /api/tus/<uploadId>` — checks resume offset
- Client uses `tus-js-client` with `endpoint: '/api/tus'`, `chunkSize: 8 * 1024 * 1024`
- `/api/tus` requires an authenticated user and project-scoped upload metadata

## Audio — Always Use audioProxyUrl()
Supabase public audio URLs do not reliably return `Accept-Ranges` headers, so browsers can't seek or determine duration.

- `src/app/api/audio/[...path]/route.ts` — proxy that forwards Range headers and returns proper 206 responses
- `audioProxyUrl(supabaseUrl)` in `src/lib/supabase.ts` — converts any Supabase mf-audio URL to `/api/audio/...`
- Every `<audio>` element or `WaveformPlayer` MUST use `audioProxyUrl(version.audio_url)`, not the raw URL
- Already applied in: `ProjectClient.tsx`, `ShareClient.tsx`, `player/page.tsx`
- Do not remove `/api/audio` from middleware public paths

## Supabase Storage Buckets
- `mf-audio` — audio files, public read
- `mf-artwork` — artwork images, public read

## PWA + iOS Wrapper
Do not remove `ServiceWorkerRegistrar.tsx`, `PullToRefresh.tsx`, or the `appleWebApp` metadata in `layout.tsx`. There is a native iOS app wrapper in `ios/` (Xcode project).

# Operations Runbooks

## Railway domains return 403 host_not_allowed
Symptom: `mixbase-production.up.railway.app` and/or `mixbase-staging.up.railway.app` return `HTTP 403` with header `x-deny-reason: host_not_allowed`. This is Railway's edge router rejecting the request because no service matches the hostname — i.e. the public domain was disabled or removed in the Railway dashboard. App code is irrelevant; do **not** start editing `proxy.ts`/`middleware.ts`.

Fix:
1. Ask the user for a Railway API token (https://railway.com/account/tokens) if it is not already in env. Do not commit it.
2. Run `RAILWAY_TOKEN=<token> railway link` (pick the mixbase project) then `railway domain --service mixbase-production` and `railway domain --service mixbase-staging` to regenerate the public `*.up.railway.app` domains.
3. Verify with `curl -sI https://mixbase-production.up.railway.app/` — expect `HTTP/2 200`, not 403.

Sandbox egress: the Anthropic web sandbox blocks `backboard.railway.com` / `backboard.railway.app` (Railway's GraphQL API) by default. `.claude/settings.json` adds them to `sandbox.network.allowedDomains`, but **the change only takes effect on the next session start**. If you hit "Host not in allowlist" mid-session, ask the user to (a) restart the Claude Code session, or (b) run the same `railway` commands locally with the token.

# Application Pages & Features
- `/dashboard` — Project grid with stats, activity feed
- `/projects/[id]` — Main working view: versions, upload, A/B compare, notes, release pipeline
- `/collections` — Group tracks into playlists/EPs/albums
- `/media` — Artwork gallery across all projects
- `/pipeline` — Release checklist board for all releases
- `/player` — Full-screen audio player with waveform
- `/share/[token]` — Public share page (no auth required) with feedback form

# Auth Model
Multi-user with Supabase Auth (email + password). `POST /api/auth` calls `supabaseAdmin.auth.signInWithPassword()` and sets `sb-access-token` + `sb-refresh-token` cookies. `POST /api/auth/signup` creates new accounts. Middleware validates the access token via `supabaseAdmin.auth.getUser()` and injects `X-User-Id` header. All data tables have `user_id` columns with RLS policies enforcing per-user isolation (migration 005).

Public routes (no auth required): `/login`, `/signup`, `/privacy`, `/support`, `/terms`, `/dmca`, `/share/`, `/api/auth`, `/api/auth/signup`, `/api/auth/logout`, `/api/audio`, `/api/health`, `/api/feedback`

**Critical:** `SUPABASE_SERVICE_ROLE_KEY` must be set for auth validation and storage operations.
