# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

# Architecture: Critical Constraints

## Upload — Never Route File Bytes Through Railway
Railway's proxy truncates request bodies above 10 MB (10,485,760 bytes exactly). This is infrastructure, not a code bug.

**Smart upload routing (ProjectClient.tsx + projects/new/page.tsx):**
- Files ≤ 50 MB → Signed URL (direct browser-to-Supabase PUT, fast)
- Files > 50 MB → TUS chunked (8 MB chunks through Railway proxy)
- If signed URL fails with 413 → auto-retry via TUS

**Signed URL path:**
- `POST /api/upload-url` — server generates a short-lived Supabase signed upload URL
- Browser PUTs directly to Supabase — Railway is never in the byte path
- Implementation: `src/app/api/upload-url/route.ts` + `ProjectClient.tsx` `handleUpload()`

**TUS chunked proxy (resumable uploads, auto-used for large files):**
- `POST /api/tus` — creates TUS session at Supabase using service-role key (bypasses size limits)
- `PATCH /api/tus/<uploadId>` — proxies one 8 MB chunk to Supabase (under Railway's 10 MB wall)
- `HEAD /api/tus/<uploadId>` — checks resume offset
- Client uses `tus-js-client` (dynamic import) with `endpoint: '/api/tus'`, `chunkSize: 8 * 1024 * 1024`
- `/api/tus` is in PUBLIC_PATHS in middleware

**Critical: `mf-audio` bucket limit is 2 GB, set via direct SQL.** Never use the Storage API (`updateBucket`) to change it — the API caps at the project's 500 MB global limit and will silently downgrade.

## Audio — Always Use audioProxyUrl()
Supabase public audio URLs do not reliably return `Accept-Ranges` headers, so browsers can't seek or determine duration.

- `src/app/api/audio/[...path]/route.ts` — proxy that forwards Range headers and returns proper 206 responses
- `audioProxyUrl(supabaseUrl)` in `src/lib/supabase.ts` — converts any Supabase mf-audio URL to `/api/audio/...`
- Every `<audio>` element MUST use `audioProxyUrl(version.audio_url)`, not the raw URL
- Already applied in: `ProjectClient.tsx`, `ShareClient.tsx`, `player/page.tsx`
- Do not remove `/api/audio` from middleware public paths

## Supabase Storage Buckets
- `mf-audio` — audio files, public read, 2 GB limit (set via SQL, not API)
- `mf-artwork` — artwork images, public read, 50 MB limit

## PWA + native iOS app
Do not remove `ServiceWorkerRegistrar.tsx`, `PullToRefresh.tsx`, or the `appleWebApp` metadata in `layout.tsx`. The `ios/` directory is a **fully native SwiftUI app** (not a WebView wrapper): it talks to Supabase PostgREST directly and has its own native `AVPlayer` audio engine (`ios/mixBase/Services/`). It can also call the web app's authenticated API routes using `Authorization: Bearer <supabase-access-token>` (the middleware in `src/proxy.ts` accepts Bearer tokens as well as the session cookie).

## Upload auth
`/api/tus` and `/api/tus/[uploadId]` are **authenticated** (not in `PUBLIC_PATHS`): they proxy to Supabase Storage with the service-role key, so the POST validates session + project ownership + bucket allow-list before creating a session. The web client uploads through them; the iOS app uploads directly to Supabase and does not use these routes.

# Application Pages & Features
- `/dashboard` — Project grid with stats, activity feed
- `/projects/[id]` — Main working view: versions, upload, notes, master check, release pipeline
- `/collections` — Group tracks into playlists/EPs/albums
- `/media` — Artwork gallery across all projects
- `/pipeline` — Release checklist board for all releases
- `/player` — Full-screen audio player. **Its waveform is decorative, not real**: `generateWaveform()` is an LCG seeded by `project_id`, so the shape is stable per project but carries zero information about the audio. Don't cite it as analysis, and don't "fix" it without deciding to build real peak extraction.

**Features this app does NOT have** (previously claimed here; each was verified absent 2026-08-03, so don't build on them): A/B version compare — there is one shared `<audio>` in `PlayerContext` and no two-source switching; a `WaveformPlayer` component — the name appears nowhere in `src/`.
- `/share/[token]` — Public share page (no auth required) with feedback form

# Auth Model
Multi-user with Supabase Auth (email + password). `POST /api/auth` calls `supabaseAdmin.auth.signInWithPassword()` and sets `sb-access-token` + `sb-refresh-token` cookies. `POST /api/auth/signup` creates new accounts. Middleware validates the access token via `supabaseAdmin.auth.getUser()` and injects `X-User-Id` header. All data tables have `user_id` columns with RLS policies enforcing per-user isolation (migration 005). Deliberate exception: the community feed (`/feed`, `GET /api/feed`, `mb_feed_comments`) is cross-user by design — every signed-in artist sees all users' uploads and comments (server-side via `supabaseAdmin`).

Public routes (no auth required): `/login`, `/signup`, `/privacy`, `/support`, `/terms`, `/dmca`, `/share/`, `/api/auth`, `/api/audio`, `/api/health`, `/api/tus`, `/api/feedback`

**Critical:** `SUPABASE_SERVICE_ROLE_KEY` must be set for auth validation and storage operations.
