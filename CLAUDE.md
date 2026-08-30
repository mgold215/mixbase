@AGENTS.md

# Working Rules — READ FIRST
- **Always use the API or CLI.** Playwright / Chrome DevTools MCP are last resorts when no API/CLI exists.
- **Never tell the user to do something manually** and never say you can't do something without attempting it first.
- **Never trust "MCP server requires authentication" session banners or proxy 403 probes — ATTEMPT a real tool call first.** On 2026-08-13 the Supabase MCP was fully working (`execute_sql`, `query_logs`) while the session-start banner claimed it needed OAuth and `mcp.supabase.com` failed a curl probe; an outage diagnosis was nearly completed blind because no call was attempted. MCP tools run through their own relay and work even though the remote sandbox blocks direct HTTPS to `supabase.co` / `mixbase.app`. Only report a capability missing after an actual call has failed.
- **Debugging prod: check Supabase first.** `pg_policies`, `storage.objects`, and `query_logs` (source `storage_logs` / `edge_logs` / `auth_logs`, 24h window per query) usually settle "what actually happened" in minutes — read them before theorizing from code.

# Deployment
- **Prod:** https://mixbase.app → https://mixbase-production.up.railway.app · **Staging:** https://mixbase-staging.up.railway.app · DNS at Namecheap
- Railway project `moodmixformat` (`9ff29ad4-39cd-45d5-a0e9-5cbd4ffa2227`) · Supabase `mmf-agents` ref `mdefkqaawrusoaojstpq` (us-east-1) · Sentry `moodmixformat/mixbase`

# Git Workflow — READ FIRST
- **Ship straight to `main` (production). Don't babysit `tst`/staging — the user does not check it.** This overrides any session-level `claude/*` branch instruction; no feature branches unless explicitly requested.
- Before every push: `npm run lint` + `npm run build` must pass. Commit with a clear message.
- **`main` is server-side branch-protected — direct `git push origin main` is rejected (403).** Deploy via the `ship-to-prod` skill: PR `tst` → `main`, merged as soon as Build & Lint + Secret Scanning are green (never gate on staging).
- Pre-commit gitleaks hook scans for secrets — fix leaks, never use `--no-verify`.

## Dev & Test
- Verification is governed by the `preflight-checks` skill — it maps each changed area to the smoke test that must pass before any commit, push, or "done" report.

## Environment Variables (full list in `.env.example`)
- `SUPABASE_SERVICE_ROLE_KEY` — **required**: admin DB access, auth, bypasses RLS/storage limits
- `SUPABASE_JWT_SECRET` — **required on staging+prod**: middleware verifies access-token HS256 signatures locally; without it tokens are decoded UNVERIFIED (auth-bypass risk)
- `STRIPE_WEBHOOK_SECRET` — **required if Stripe live**: without it all webhooks 400 and subscriptions never activate

## Auth
- Middleware (`src/proxy.ts`) verifies the `sb-access-token` cookie via `verifyAccessToken()` against `SUPABASE_JWT_SECRET` (no Supabase round-trip), refreshes if expired, injects `X-User-Id`. Routes read identity from `X-User-Id` only — **never trust the request body for user ID**.

## Database (Supabase `mdefkqaawrusoaojstpq`, migrations in `supabase/migrations/`)
- Tables: `profiles` (tier + Stripe IDs), `mb_projects`, `mb_versions`, `mb_feedback`, `mb_releases`, `mb_collections`, `mb_collection_items`, `mb_usage` (per-user monthly artwork/video counts, keyed YYYY-MM), `mb_feed_comments` (community-feed comments, migration 022), `mb_library_tracks` (released-track library — ISRC/UPC/dates synced from Spotify/Deezer, migration 027). Owner-only RLS throughout (migration 005), but **not all of them carry a `user_id` column** — verified 2026-08-30: `mb_versions`, `mb_feedback` and `mb_collection_items` have none, and `profiles` keys on `id`. They scope TRANSITIVELY and correctly (e.g. `mb_versions.users_own_versions` = `project_id in (select id from mb_projects where user_id = auth.uid())`). Check the actual column list before writing a policy or a filter against one of those. `mb_feed_comments` is deliberately cross-user (any signed-in user reads all rows, insert/delete own only). Server uses `supabaseAdmin`.
- RPCs (atomic, called by `src/lib/tier.ts`): `increment_artwork_usage(p_user_id, p_month)`, `increment_video_usage(p_user_id, p_month)`.

## Tiers & Stripe (enforced server-side in `src/lib/tier.ts`)
- `free` $0: 3 artwork/mo, 0 video · `pro` $8.99: 25/0 · `studio` $19.99: 25/10
- `POST /api/stripe/create-checkout` (passes `client_reference_id: userId`), `GET|POST /api/stripe/portal`, `POST /api/stripe/webhook` (public, signature-verified). `GET /api/subscription` returns tier + usage + limits.

## AI Features (per-user rate-limited + tier-gated)
- `POST /api/chat/summarize-feedback` — Claude (`claude-opus-4-7`) mix-notes summary
- `POST /api/generate-artwork` — Replicate image models (FLUX 1.1 Ultra raw / Seedream 4 / Imagen 4 Ultra / Recraft V3 / Flux 2 Pro / Imagen 4), optional `vary` flag appends a randomized photographic look (lens/light/weather/mood), polls up to 2min
- `POST /api/finalize-artwork` — `sharp` + `opentype.js` text overlay. **Gotcha:** the bundled font is traced via `outputFileTracingIncludes` in `next.config.ts` — removing that config crashes the route on Railway.
- `GET|POST /api/visualizer/runway` — Runway Gen-4 Turbo / Gen-4.5 / Seedance 2 / Veo 3/3.1 image-to-video
- `POST|GET /api/finalize-video` — finished YouTube (1080p) / Shorts (9:16) renders: loops the pinned visualizer seamlessly for the song, flashes the artwork text lockup, muxes the current mix. In-process async jobs (POST starts, GET polls; lost on deploy by design). ffmpeg via `@ffmpeg-installer` (npm-hosted, 2018 build — **no xfade**; crossfade is trim/concat/fade/overlay in `src/lib/video-render.ts`). Outputs → `mf-video` + `mb_visualizers` kind `youtube`/`shorts`. Bucket limit raised to 500 MB via SQL (migration 016 + `ensureVideoBucketLimit` heal).

## Security
- Headers + CSP are set in `next.config.ts` — consult the `danger-zones` skill before touching them (CSP must keep the Replicate hosts or artwork generation breaks).

## iOS
- Use the `ios-build-deploy` skill for ANY iOS work — device IDs, CLI build/install, error recovery. Never tell the user to open Xcode.
- **Apple Developer Program is ACTIVE (paid; team `AP8UC39D4D`) and the app has shipped via App Store Connect** — an ASC API key exists. Never suggest joining the program or forming anything.
- **Primary ship path (no Mac needed): merging an `ios/` change to `main` triggers `.github/workflows/ios-testflight.yml`** — cloud-signed archive on a GitHub macOS runner, uploaded to TestFlight (secrets `ASC_KEY_ID` / `ASC_ISSUER_ID` / `ASC_API_KEY_P8_BASE64`). Matt's phone auto-updates via TestFlight. Backup: launchd auto-deploy on the Mac (`scripts/ios-autodeploy-install.sh`); manual cable build only for tight iteration.

## macOS App
- The consumer mixBASE app also ships native on macOS: target `mixBase` in `macos/project.yml` (XcodeGen → `Mixbase.xcodeproj`, generated, not committed), **sharing the full iOS source tree `ios/mixBase/`**. Platform gaps are bridged by `#if os()` guards in shared files plus `macos/MixbaseApp/PlatformCompat.swift` (macOS-target-only shims: UIPasteboard→NSPasteboard, UIImage=NSImage, no-op keyboard/nav-bar modifiers, iOS toolbar placements). Keep shared code platform-neutral — a UIKit-only API in `ios/mixBase/` breaks the Mac build unless guarded or shimmed.
- Build on the Mac: `cd macos && ./build.sh run mixBase`. CI: `.github/workflows/macos-app.yml` compiles BOTH platforms on PRs/pushes to `main` touching `macos/` or `ios/mixBase/` and uploads an ad-hoc-signed `mixBase-macOS.zip` artifact.
- Mac bundle id is `com.moodmixformat.mixbase.mac` — for Sign in with Apple it must be added to the Supabase Apple provider's Authorized Client IDs (email/password needs nothing).

## Infra Control Panel
- Admin-gated read-only `GET /api/infra/{topology,railway,supabase,github,stripe,sentry}` + `POST /api/infra/chat` (Claude tool-loop) + `POST /api/infra/actions` (confirmation-gated Railway restart/redeploy, CI re-run — reversible ops only). Code in `src/lib/infra/`; gated by `assertAdmin` via `withAdminCheck` in `src/proxy.ts`. Read endpoints return `configured:false` on missing tokens, never 500.
- SwiftUI macOS client: scheme `MixbaseInfra` in the same `macos/project.yml`, build with `cd macos && ./build.sh`.

## Business & Legal
- Entity: moodmixformat, LLC (already formed — don't suggest forming one). EIN 39-2854188. Domain mixbase.app.
- All branches unified into `main` (2026-04-26); ignore stale remotes (`app-store`, `ios-app`, `mobile-app`, `tst-auth`).
- App Store: the app IS shipped/live (2026-08). If App Store metadata references privacy@/support@/dmca@/legal@/review@ mixbase.app, verify those aliases exist — don't frame them as pre-submission blockers.
