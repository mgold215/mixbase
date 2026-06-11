@AGENTS.md

# Working Rules — READ FIRST
- **Always use the API or CLI.** Playwright / Chrome DevTools MCP are last resorts when no API/CLI exists.
- **Never tell the user to do something manually** and never say you can't do something without attempting it first.

# Deployment
- **Prod:** https://mixbase.app → https://mixbase-production.up.railway.app · **Staging:** https://mixbase-staging.up.railway.app · DNS at Namecheap
- Railway project `moodmixformat` (`9ff29ad4-39cd-45d5-a0e9-5cbd4ffa2227`) · Supabase `mmf-agents` ref `mdefkqaawrusoaojstpq` (us-east-1) · Sentry `moodmixformat/mixbase`

# Git Workflow — READ FIRST
- **Ship straight to `main` (production). Don't babysit `tst`/staging — the user does not check it.** This overrides any session-level `claude/*` branch instruction; no feature branches unless explicitly requested.
- Before every push: `npm run lint` + `npm run build` must pass. Commit with a clear message.
- **`main` is server-side branch-protected — direct `git push origin main` is rejected (403).** The required vehicle to land on `main` is a PR from `tst` with the "Build & Lint" and "Secret Scanning" checks green. So the actual one-shot "push to main" is:
  1. `git push origin tst` (force-with-lease if rebased)
  2. open a PR `tst → main` and **merge it as soon as the required checks pass** (use the GitHub MCP `merge_pull_request`). This deploys prod.
- Do NOT gate the merge on manually verifying staging — once Build & Lint + Secret Scanning are green, merge to `main`.
- Pre-commit gitleaks hook scans for secrets — fix leaks, never use `--no-verify`.

## Dev & Test Commands
```bash
npm run dev / npm run build / npm run lint                            # build+lint before every push
npm run test:e2e                                                      # Playwright (staging by default; BASE_URL=http://localhost:3000 for local)
node scripts/test-upload.mjs https://mixbase-staging.up.railway.app   # TUS upload + audio Range smoke test
node scripts/finalize-test.mjs                                        # artwork finalize smoke test
node scripts/test-infra.mjs <staging-url> <admin-email> <admin-pass>  # /api/infra/* smoke test
```
All relevant tests must pass before telling the user a fix is done.

## Environment Variables (full list in `.env.example`)
- `SUPABASE_SERVICE_ROLE_KEY` — **required**: admin DB access, auth, bypasses RLS/storage limits
- `SUPABASE_JWT_SECRET` — **required on staging+prod**: middleware verifies access-token HS256 signatures locally; without it tokens are decoded UNVERIFIED (auth-bypass risk)
- `STRIPE_WEBHOOK_SECRET` — **required if Stripe live**: without it all webhooks 400 and subscriptions never activate
- Optional: `ANTHROPIC_API_KEY` (feedback summarizer), `REPLICATE_API_TOKEN` (artwork), `RUNWAY_API_KEY` (video), `STRIPE_SECRET_KEY` + price IDs, `NEXT_PUBLIC_SENTRY_DSN` (not a secret), `SENTRY_AUTH_TOKEN` (source maps), `SUPABASE_MANAGEMENT_TOKEN`, `RAILWAY_API_TOKEN`, `GITHUB_TOKEN`

## Auth
- Middleware (`src/proxy.ts`) verifies the `sb-access-token` cookie via `verifyAccessToken()` against `SUPABASE_JWT_SECRET` (no Supabase round-trip), refreshes if expired, injects `X-User-Id`. Routes read identity from `X-User-Id` only — **never trust the request body for user ID**.
- Cookies: `sb-access-token` (1hr), `sb-refresh-token` (30d), `sb-authed`, `sb-expires-at`.
- Routes under `/api/auth`: signin (10/15min per IP), `signup` (5/hr per IP), `logout`, `me`, `refresh`, `change-password`, `delete-account`.
- Extra public paths beyond AGENTS.md list: `/auth/callback`, `/api/auth/*` above, `/api/db-init`, `/api/stripe/webhook`, `/profile` pages are auth-gated.

## Database (Supabase `mdefkqaawrusoaojstpq`, migrations in `supabase/migrations/`)
- Tables: `profiles` (tier + Stripe IDs), `mb_projects`, `mb_versions`, `mb_feedback`, `mb_releases`, `mb_collections`, `mb_collection_items`, `mb_usage` (per-user monthly artwork/video counts, keyed YYYY-MM). All have `user_id` + RLS (migration 005); server uses `supabaseAdmin`.
- RPCs (atomic, called by `src/lib/tier.ts`): `increment_artwork_usage(p_user_id, p_month)`, `increment_video_usage(p_user_id, p_month)`.

## Tiers & Stripe (enforced server-side in `src/lib/tier.ts`)
- `free` $0: 3 artwork/mo, 0 video · `pro` $8.99: 25/0 · `studio` $19.99: 25/10
- `POST /api/stripe/create-checkout` (passes `client_reference_id: userId`), `GET|POST /api/stripe/portal`, `POST /api/stripe/webhook` (public, signature-verified). `GET /api/subscription` returns tier + usage + limits.

## AI Features (per-user rate-limited + tier-gated)
- `POST /api/chat/summarize-feedback` — Claude (`claude-opus-4-7`) mix-notes summary
- `POST /api/generate-artwork` — Replicate Flux 2 Pro / Imagen 4, polls up to 2min
- `POST /api/finalize-artwork` — `sharp` + `opentype.js` text overlay. **Gotcha:** the bundled font is traced via `outputFileTracingIncludes` in `next.config.ts` — removing that config crashes the route on Railway.
- `GET|POST /api/visualizer/runway` — Runway Gen-4 Turbo / Gen-4.5 / Seedance 2 / Veo 3/3.1 image-to-video
- In-process rate limits (reset on deploy, intentional): login 10/15min·IP, signup 5/hr·IP, artwork 10/hr·user, upload-url 30/hr·user, feedback 20/hr·IP, chat 20/hr·user

## Security
- Headers set in `next.config.ts`: X-Frame-Options SAMEORIGIN, nosniff, Referrer-Policy, Permissions-Policy, HSTS 1yr, CSP (self + Supabase + Replicate).
- **CSP gotcha:** `img-src` needs `https://*.replicate.delivery`, `connect-src` needs `https://api.replicate.com` — don't tighten CSP without testing artwork flow.

## CI/CD & Monitoring
- GitHub Actions on push to `main`/`tst`: Build & Lint (Node 20), gitleaks full-history scan, `npm audit --audit-level=high`.
- Sentry via `@sentry/nextjs` (3 config files); prod-only, 10% trace sampling. DSN is safe to commit.

## iOS — handle everything via CLI; never tell the user to open Xcode
```bash
xcrun devicectl device info ddiServices -d <COREDEVICE_UUID>   # fix "developer disk image" errors
xcodebuild -project ios/mixBase.xcodeproj -scheme mixBase -destination 'id=<UDID>' -allowProvisioningUpdates build
xcrun devicectl device install app -d <COREDEVICE_UUID> <DerivedData>/Build/Products/Debug-iphoneos/mixBase.app
```
- Matt's iPhone 15 Pro Max — UDID `00008130-0014091600FA8D3A` (for xcodebuild), CoreDevice UUID `E11A7247-ACED-5D35-94E0-B1F8641BD71C` (for devicectl), DerivedData `~/Library/Developer/Xcode/DerivedData/mixBase-hcgiqutykhfnaxbbguzimycwxkfo/`
- Signing: Apple Development (m.goldman215@gmail.com), auto-provisioning. Bundle ID `com.moodmixformat.mixbase`. If install fails "device disconnected", retry immediately. Commit iOS changes after successful build+install.

## Infra Control Panel
- Admin-gated read-only `GET /api/infra/{topology,railway,supabase,github,stripe,sentry}` + `POST /api/infra/chat` (Claude tool-loop) + `POST /api/infra/actions` (confirmation-gated Railway restart/redeploy, CI re-run — reversible ops only). Code in `src/lib/infra/`; gated by `assertAdmin` via `withAdminCheck` in `src/proxy.ts`. Read endpoints return `configured:false` on missing tokens, never 500.
- SwiftUI macOS client in `macos/` — XcodeGen project (`macos/project.yml`), build with `cd macos && ./build.sh`; `.xcodeproj` is generated, not committed.

## Business & Legal
- Entity: moodmixformat, LLC (already formed — don't suggest forming one). EIN 39-2854188. Domain mixbase.app.
- All branches unified into `main` (2026-04-26); ignore stale remotes (`app-store`, `ios-app`, `mobile-app`, `tst-auth`).
- Before App Store submission: set up privacy@/support@/dmca@/legal@/review@ mixbase.app emails.
