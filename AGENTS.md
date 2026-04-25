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
- `/api/tus` is in PUBLIC_PATHS in middleware

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

# Application Pages & Features
- `/dashboard` — Project grid with stats, activity feed
- `/projects/[id]` — Main working view: versions, upload, A/B compare, notes, release pipeline
- `/collections` — Group tracks into playlists/EPs/albums
- `/media` — Artwork gallery across all projects
- `/pipeline` — Release checklist board for all releases
- `/player` — Full-screen audio player with waveform
- `/share/[token]` — Public share page (no auth required) with feedback form

# Auth Model
Single shared password (not per-user). `POST /api/auth` checks `MIXBASE_PASSWORD` and sets an `mb-session` cookie containing `SESSION_SECRET`. Middleware validates that cookie on every protected route.

Public routes (no auth required): `/login`, `/share/`, `/api/audio`, `/api/health`, `/api/tus`, `/api/feedback`

**Critical:** If `SESSION_SECRET` is unset, middleware short-circuits and the app is open to everyone. Both `MIXBASE_PASSWORD` and `SESSION_SECRET` must be set for auth to work.
