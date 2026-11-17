# mixBASE: instructions for coding agents

mixBASE is version control for music, from rough mix to release: a Next.js web app (mixbase.app), a native SwiftUI iOS app and a macOS app that shares its source, on Supabase and Railway. One person owns and runs it, the owner, an artist who uses it for their own releases.

This file holds what every session needs. Feature detail lives in the notes listed under [Where the detail lives](#where-the-detail-lives); read the matching one before working in its area.

## Working with the owner

- **Use the API or CLI.** Playwright / Chrome DevTools are last resorts when no API or CLI exists.
- **Do it yourself.** Never tell the owner to do something manually, and never say something can't be done without attempting it first.
- **Ask before spending their money on tests.** Owner, 2026-11-11, after two test clips cost 160 Runway credits: "Don't be burning up all my runway credits doing your testing either".
  - Never spend Runway credits on testing without asking first. Filming is verified by reading the request and the logs, or by a clip the owner chose to film.
  - Reading of the "either": the same care applies to every paid test generation (Replicate pictures, Claude calls). Say what a test will cost before running it, and keep it to the fewest runs that settle the question.
- **Walk the owner's whole path before saying "done".** Owner, 2026-11-12: "Please catch things like this in the future", after they found on their phone that Film it vanished once they had edited the artwork, and that a new cover's clip "slightly moved around. Very underwhelming". Reading: faults that only show when a feature is USED, not when its code is read. Before reporting any change to a screen the owner uses:
  1. Follow what they do AFTER the first success (adjust the title, save a look, leave the screen and come back, reopen the app hours later or after a deploy) and check what each screen then shows on web AND app. Anything that lives only in server memory or in one view's state is a suspect; a control that can vanish needs a test or a stored source.
  2. LOOK at the real output (render it, pull frames, watch for the thing the owner asked for) and judge it as they would: "it runs" is not "it is good".
  3. When something built is not live yet, the report's first line says what they will still get if they use the app right now.
- **A fix that hasn't been verified is not done.** Report it as in progress or broken, with the failing output. The owner ships to production on your word.
- **The owner mostly uses the app.** Owner, 2026-11-17: "I generally use the app in 95% of the time". Reading: an owner-facing feature that exists only on the web has not reached them yet.
- **Settled, don't suggest again:** the entity (moodmixformat, LLC) is formed; the Apple Developer Program is active and paid; there are no paid plans.
- **This repository is public.** No secrets, and no personal or business identifiers in code, docs or commit messages (an EIN and an Apple ID email were removed 2026-11-14).

## Commands

```bash
npm ci                          # install (leave NODE_ENV unset, or devDependencies are skipped)
npm run dev                     # http://localhost:3000
npm run lint                    # must pass before every push
npm run build                   # must pass before every push
npm test                        # every unit suite; needs Node 22+ (suites import the .ts sources), no network or secrets
node scripts/<name>-test.mjs    # one suite
npm run test:e2e                # Playwright against staging; BASE_URL=http://localhost:3000 for local
```

## Verifying work

- The `preflight-checks` skill maps each changed area to the test that must pass before any commit, push or "done" report.
- Unit suites live in `scripts/*-test.mjs`, run by `scripts/run-renderer-tests.mjs`. `tests/` is Playwright e2e ONLY: a unit suite dropped there never runs.
- The runner fails if a `scripts/*-test.mjs` exists but is not in its `SUITES` array. Register new suites there (when briefing subagents, have them report new test filenames instead of editing the shared array).
- `npm test` never touches `.next`, so it can run while a build runs. `build` and `lint` collide with each other.
- Run the pre-push gate in a clean worktree with `NODE_ENV` unset. Untracked tool junk in the main checkout and an exported `NODE_ENV=production` have each caused thousands of phantom lint errors (2026-08-19, 08-20). If lint suddenly reports thousands of errors on code CI says is green, suspect the environment, not the code.

## Shipping

- **Ship straight to `main`, which is production.** Don't babysit `tst` / staging: the owner does not check it. No feature branches unless the owner asks for one.
- `main` is branch-protected: `git push origin main` is rejected (403). Deploy with the `ship-to-prod` skill: PR `tst` → `main`, merged as soon as **Build & Lint** and **Secret Scanning** are green. Never gate on staging.
- A merge to `main` deploys the web app on Railway. A change under `ios/` or `macos/` also builds and uploads the apps to TestFlight.
- A deploy restarts the server. In-process jobs (video renders, a Studio run, a Mix Check) die with it by design, so never start a paid run while a deploy is still swapping replicas.
- The pre-commit gitleaks hook scans for secrets. Fix the leak; never use `--no-verify`.
- Only `main` and `tst` matter. The other remote branches are stale, except `asc5-inspect`, `asc6-submit` and `asc7-listing`, which trigger App Store workflows when pushed.

## Environments

- **Prod:** https://mixbase.app → https://mixbase-production.up.railway.app. **Staging:** https://mixbase-staging.up.railway.app. DNS at Namecheap.
- Railway project `moodmixformat` (`9ff29ad4-39cd-45d5-a0e9-5cbd4ffa2227`). Supabase `mmf-agents`, ref `mdefkqaawrusoaojstpq` (us-east-1). Sentry `moodmixformat/mixbase`.
- Production runs two processes (us-east4 + us-west2). Anything kept in one process's memory (jobs, rate limits) is unknown to the other.
- Environment variables: full list in `.env.example`.
- **Debugging prod: check Supabase first.** `pg_policies`, `storage.objects` and `query_logs` (source `storage_logs` / `edge_logs` / `auth_logs`, 24h window per query) usually settle "what actually happened" in minutes. Read them before theorizing from code.

## Hard constraints

These break production in ways that pass local testing. Details and reasons: the `upload-audio-architecture` and `danger-zones` skills.

- **Next.js here is not the one you know.** See the block at the end of this file.
- **Never route file bytes through Railway.** Its proxy truncates request bodies above 10 MB. Files ≤ 50 MB go by signed URL straight to Supabase (`POST /api/upload-url`); larger files by TUS in 8 MB chunks (`/api/tus`).
- **Every `<audio>` source goes through `audioProxyUrl()`** (`src/lib/supabase.ts` → `/api/audio/...`). Raw Supabase URLs play but can't seek or report duration.
- **Bucket limits are set by SQL, never the Storage API** (`updateBucket` silently downgrades `mf-audio` from 2 GB to 500 MB). Buckets: `mf-audio` 2 GB, `mf-video` 500 MB, `mf-artwork` 50 MB.
- **Identity comes from the `X-User-Id` header only**, injected by the middleware in `src/proxy.ts`. Never trust the request body for a user id.
- **Public paths are `startsWith()` prefixes** (`PUBLIC_PATHS` in `src/proxy.ts`): anything added under one is public. `/api/audio/` must stay public; `/api/tus` is deliberately NOT public.
- **Headers and CSP live in `next.config.ts`.** The CSP must keep the Replicate hosts or artwork generation breaks, and `outputFileTracingIncludes` keeps bundled fonts on Railway.
- **Don't remove** `ServiceWorkerRegistrar.tsx`, `PullToRefresh.tsx`, or the `appleWebApp` metadata in `layout.tsx` (the PWA).
- **Several oddities are deliberate**: in-process rate limits and jobs that reset on deploy, the 2018 ffmpeg with no `xfade`, the cross-user feed. Check `danger-zones` before "fixing" one.

## Auth and data

- Supabase Auth, email + password. `POST /api/auth` signs in and sets the `sb-access-token` + `sb-refresh-token` cookies; `POST /api/auth/signup` creates accounts.
- The middleware verifies the access token locally with `verifyAccessToken()` (ES256/RS256 against the project JWKS, legacy HS256 against `SUPABASE_JWT_SECRET`), refreshes it if expired, and injects `X-User-Id`. It also accepts `Authorization: Bearer <token>`, which is how the apps call the API.
- `SUPABASE_SERVICE_ROLE_KEY` is required (admin DB access, auth, storage) and server-only. It holds a secret key (`sb_secret_…`), not the legacy JWT. Raw `fetch()` calls must use `serviceKeyHeaders()` (`src/lib/service-key.ts`): an `sb_` key sent as `Authorization: Bearer` is rejected.
- `SUPABASE_JWT_SECRET` is legacy. Once the project signs with JWT signing keys it is deleted from Railway on purpose; with it unset, HS256 tokens fall back to a cached `getUser()` check, never to unverified decoding.
- **Railway breach (2026-10-21):** treat every value ever stored in Railway as leaked, and never put one back. Checklist and status: `docs/security/2026-10-21-railway-breach.md`.
- Migrations are in `supabase/migrations/`, numbered. The app's tables are `mb_*` plus `profiles`, with owner-only RLS (migration 005). The server uses `supabaseAdmin`.
- **Not every table has a `user_id` column.** `mb_versions`, `mb_feedback` and `mb_collection_items` have none and `profiles` keys on `id`; they scope through their parent (e.g. `mb_versions` → `mb_projects.user_id`). Check the actual columns before writing a policy or a filter.
- The community feed is cross-user by design (`/feed`, `GET /api/feed`, `mb_feed_comments`): any signed-in user reads all rows, and inserts/deletes only their own.

## Product rules

- **No paid plans anywhere** (decision 2026-09-12, App Review 2.1(b)). mixBASE is free on the website and in the apps. Stripe, the pro/studio tiers, the pricing section, `/api/stripe/*`, `/api/subscription` and the admin tier controls were removed; `scripts/no-paid-plans-test.mjs` fails the build if any of it comes back. If we ever charge, it will be through Apple's In-App Purchase only, never a web checkout.
- **One allowance for everyone**, enforced in `src/lib/tier.ts`: `MONTHLY_LIMITS` = 3 AI artworks / 0 cloud videos per month (`mb_usage`, via the atomic RPCs `increment_artwork_usage` / `increment_video_usage`). Cloud video is owner-only; the apps and the web FreeStudio render visualizers for free.
- The platform owner is exempt via `isPlatformOwner` (identity, not a purchase). `profiles.subscription_tier` is informational (`admin` / `free`): never build an entitlement on it.
- Quota-exhausted copy stays purchase-free ("resets at the start of next month"). The iOS app scrubs any server string mentioning upgrade/plan/price, but there must be nothing to scrub.
- **Owner-only tools** (Cassette Studio, Mix Check): every handler 404s unless `isAdminIdentity`. Clients learn it from `GET /api/auth/me` → `owner_tools`, never from `profiles.is_owner`.
- **One stack, both clients** (2026-10-19). A feature's logic lives in a server route, and the web AND the app call it. The app never re-implements a rule or writes a table the web writes through a route. Option lists the server validates against are served to the app by GET (e.g. `GET /api/finalize-artwork`), never copied into Swift.
- `scripts/ios-parity-test.mjs` fails the build when the web calls a route the app neither calls nor lists in its `KNOWN` register. Closing a gap means deleting its entry. It is path-level only: check a new body field on a shared route, or a route-less feature, by hand.
- **mixBASE has no A/B version compare** (checked 2026-11-17): one shared `<audio>` in `PlayerContext`, no two-source switching. Don't build on it.

## The apps

- `ios/` is a fully native SwiftUI app, not a WebView: its own `AVPlayer` engine, direct Supabase reads, and the web API by Bearer token. The macOS app (`macos/project.yml`) shares the whole `ios/mixBase/` source tree, so a UIKit-only API there breaks the Mac build unless guarded or shimmed.
- A new Swift file must also be registered in `ios/mixBase.xcodeproj/project.pbxproj`.
- A sheet must be closable on the Mac (`scripts/macos-sheet-close-test.mjs`).
- After every App Store release, bump `MARKETING_VERSION` before the next iOS merge, or every TestFlight upload fails (it has happened twice).
- Never tell the owner to open Xcode. Use the `ios-build-deploy` and `app-store-connect` skills.

## Where the detail lives

Each is a file at `.claude/skills/<name>/SKILL.md`. Claude Code loads them as skills; any other agent should open the file.

| Read this | Before |
|---|---|
| `preflight-checks` | Any commit, push, or "done" report |
| `ship-to-prod` | Anything that should go live |
| `danger-zones` | Editing `next.config.ts`, auth or identity in a route, rate limits, migrations, the infra panel, or "fixing" something odd |
| `upload-audio-architecture` | Uploads, TUS, storage buckets, `<audio>`, the audio proxy, public paths |
| `cassette-studio` | Covers, handwriting and titles, looks, moving covers, Film it |
| `mix-check` | Mix analysis and its notes, genre references |
| `share-pages` | Public song and album pages, share tokens, the link card, waveform |
| `artwork-and-video` | AI artwork, visualizers, uploaded videos, Runway, YouTube / Shorts renders |
| `ios-build-deploy` | Any work in `ios/` or `macos/` |
| `app-store-connect` | App Store submissions, the listing, after an approval |
| `exec-daily-meeting` | The daily executive meeting routine |

## Keeping these files small

`CLAUDE.md` and this file are read at the start of every session, so every line costs attention on every task. `scripts/agent-docs-test.mjs` fails the build when they outgrow their budget.

- A new fact about a feature goes in that feature's skill. A new trap goes in `danger-zones`. A new feature area gets its own skill and one row in the table above.
- Add a line here only if every session needs it: a rule for working with the owner, a command, a constraint that cuts across the codebase. One or two lines, with the date and the owner's words when it comes from them, and mark your own interpretation as a reading.
- Don't record history here. What shipped and when is in git.
- When a fact changes, change it where it lives instead of adding a correction beside it.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
