@AGENTS.md

# Automation First
- **Never tell the user "you'll need to do this manually."** Use available tools to do it directly.
- **Never say you can't do something** without first attempting it with the tools available.
- **USE THE CLI BEFORE ATTEMPTING TO USE CHROME PLUGINS**

# Deployment
- **Production URL: https://mixbase.app**
- Railway production (main): https://mixbase-production.up.railway.app
- Railway staging (tst): https://mixbase-staging.up.railway.app
- Supabase project: mdefkqaawrusoaojstpq (mmf-agents, us-east-1)
- Supabase URL: https://mdefkqaawrusoaojstpq.supabase.co

## Dev Commands
```bash
npm run dev       # Start local dev server (port 3000)
npm run build     # Production build (run before pushing)
npm run lint      # ESLint check
node scripts/test-upload.mjs https://mixbase-staging.up.railway.app
```

## Required Environment Variables
| Variable | Required | Purpose |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | **Yes** | Admin DB access, auth validation, bypasses file size limits |
| `NEXT_PUBLIC_SUPABASE_URL` | No | Falls back to hardcoded project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | No | Falls back to hardcoded public key |
| `REPLICATE_API_TOKEN` | Optional | Artwork generation (Flux 2 Pro / Imagen 4 via Replicate) |
| `RUNWAY_API_KEY` | Optional | Visualizer video generation (Runway Gen-3) |
| `SUPABASE_MANAGEMENT_TOKEN` | Optional | DB schema init via `/api/db-init` |

# Architecture: Critical Constraints — READ BEFORE TOUCHING UPLOADS OR AUDIO

## Upload — Never Route File Bytes Through Railway
Railway's proxy truncates request bodies above 10 MB (10,485,760 bytes exactly). This is infrastructure, not a code bug.

**Active path — Signed URL (used in ProjectClient.tsx):**
- `POST /api/upload-url` — server generates a short-lived Supabase signed upload URL
- Browser PUTs directly to Supabase — Railway is never in the byte path

**Also available — TUS chunked proxy (resumable):**
- `POST /api/tus` — creates TUS session at Supabase using service-role key (bypasses anon 50 MB limit)
- `PATCH /api/tus/<uploadId>` — proxies one 8 MB chunk (under Railway's 10 MB wall)
- `HEAD /api/tus/<uploadId>` — checks resume offset
- Client: `tus-js-client`, `endpoint: '/api/tus'`, `chunkSize: 8 * 1024 * 1024`

## Audio Range Requests — always use audioProxyUrl()
Supabase audio URLs don't reliably return `Accept-Ranges` — browsers can't seek or determine duration without it.

- `src/app/api/audio/[...path]/route.ts` — proxy that forwards Range headers, returns proper 206 responses
- `audioProxyUrl(supabaseUrl)` in `src/lib/supabase.ts` — converts Supabase mf-audio URL to `/api/audio/...`
- Every `<audio>` element or `WaveformPlayer` MUST use `audioProxyUrl(version.audio_url)`, not the raw URL
- Applied in: `ProjectClient.tsx`, `ShareClient.tsx`, `player/page.tsx` — do not revert

## Supabase Storage Buckets
- `mf-audio` — audio files, public read
- `mf-artwork` — artwork images, public read

# Auth Model
Multi-user with Supabase Auth (email + password). `POST /api/auth` signs in and sets `sb-access-token` + `sb-refresh-token` cookies. `POST /api/auth/signup` creates accounts. Middleware validates via `supabaseAdmin.auth.getUser()` and injects `X-User-Id`. All tables have RLS enforcing per-user isolation.

Public routes (no auth): `/login`, `/signup`, `/privacy`, `/support`, `/terms`, `/dmca`, `/share/`, `/api/auth`, `/api/audio`, `/api/health`, `/api/tus`, `/api/feedback`

# Application Pages
- `/dashboard` — Project grid with stats, activity feed
- `/projects/[id]` — Versions, upload, A/B compare, notes, release pipeline
- `/collections` — Group tracks into playlists/EPs/albums
- `/media` — Artwork gallery across all projects
- `/pipeline` — Release checklist board
- `/player` — Full-screen audio player with waveform
- `/share/[token]` — Public share page with feedback form (no auth)

## PWA + iOS Wrapper
Do not remove `ServiceWorkerRegistrar.tsx`, `PullToRefresh.tsx`, or `appleWebApp` metadata in `layout.tsx`. Native iOS wrapper lives in `ios/` (Xcode project).

# Business & Legal
- **Legal entity:** moodmixformat, LLC (formed — do not suggest forming an LLC)
- **EIN:** 39-2854188
- **Domain:** mixbase.app (live)
- **Emails needed before App Store submission:** privacy@, support@, dmca@, legal@, review@ at mixbase.app
