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
- **This repository is public.** No secrets in code, docs, tests or commit messages, and no tax ids or personal email addresses (an EIN and an Apple ID email were removed 2026-11-14).

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

- Before any commit, push or "done" report: `npm run lint`, `npm run build` and `npm test` all pass. The `preflight-checks` skill has the suites for each area and what cannot be checked from a remote session.
- Unit suites live in `scripts/*-test.mjs` and must be registered in `scripts/run-renderer-tests.mjs`. `tests/` is Playwright end-to-end ONLY: a unit suite dropped there never runs.
- Run the gate in a clean checkout with `NODE_ENV` unset. If lint suddenly reports thousands of errors on code CI says is green, suspect the environment, not the code.

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
- **Staging is not usable.** Its Supabase key was removed after the Railway breach, so its health check fails and every deploy to it since 2026-11-14 has failed. Nothing can be tested there until it is given credentials of its own.
- Production runs two processes (us-east4 + us-west2). Anything kept in one process's memory (jobs, rate limits) is unknown to the other.
- Environment variables: full list in `.env.example`.
- **Something wrong in production? Check Supabase first**, before theorizing from code. → `debugging-production`

## Rules that cut across the codebase

Each is one line here and a full skill underneath. Read the skill before working in its area: these break production in ways that pass local testing.

- **Uploads, storage and audio playback** run inside infrastructure limits (no request over 10 MB may pass through Railway). → `uploads-and-audio`
- **Identity comes from the `X-User-Id` header only**, set by the middleware in `src/proxy.ts`. Never trust the request body for a user id. Public paths, keys and CSP have their own traps. → `auth-and-security`
- **A deploy does not apply database migrations**, and two migration files must not be applied at all. → `database-changes`
- **Next.js here is not the one you know.** See the block at the end of this file.
- **Railway breach (2026-10-21):** treat every value ever stored in Railway as leaked, and never put one back. → `auth-and-security`
- **Don't remove** `ServiceWorkerRegistrar.tsx`, `PullToRefresh.tsx`, or the `appleWebApp` metadata in `layout.tsx` (the PWA).
- **Several oddities are deliberate**: in-process rate limits and jobs that reset on deploy, the 2018 ffmpeg with no `xfade`, the cross-user community feed. Check the area's skill before "fixing" one.

## Product rules

- **No paid plans anywhere** (decision 2026-09-12, App Review 2.1(b)). mixBASE is free on the website and in the apps. Stripe, the pro/studio tiers, the pricing section, `/api/stripe/*`, `/api/subscription`, the admin tier controls and the infra Stripe node were removed; `scripts/no-paid-plans-test.mjs` fails the build if any of it comes back. If we ever charge, it will be through Apple's In-App Purchase only, never a web checkout.
- **One allowance for everyone**, enforced in `src/lib/tier.ts`: `MONTHLY_LIMITS` = 3 AI artworks / 0 cloud videos per month. Cloud video is owner-only; the apps and the web FreeStudio render visualizers for free. The owner is exempt by identity (`isPlatformOwner`), not by a purchase.
- Quota-exhausted copy stays purchase-free ("resets at the start of next month"). The iOS app scrubs any server string mentioning upgrade/plan/price, but there must be nothing to scrub.
- **Owner-only tools** (Cassette Studio, Mix Check): every handler 404s unless `isAdminIdentity`. Clients learn it from `GET /api/auth/me` → `owner_tools`.
- **One stack, both clients** (2026-10-19). A feature's logic lives in a server route, and the web AND the app call it. The app never re-implements a rule or writes a table the web writes through a route. Option lists the server validates against are served to the app by GET (e.g. `GET /api/finalize-artwork`), never copied into Swift. Some older app screens still write to Supabase themselves; new work goes through a route.
- `scripts/ios-parity-test.mjs` fails the build when the web calls a route the app neither calls nor lists in its `KNOWN` register (missing / direct / native / web-only; `direct` marks those older screens). Closing a gap means deleting its entry. It is path-level only: check a new body field on a shared route, or a route-less feature, by hand.
- **mixBASE has no A/B version compare** (verified absent 2026-08-03, and again 2026-11-17): one shared `<audio>` in `PlayerContext`, no two-source switching. Don't build on it.

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
| `debugging-production` | Investigating a problem in production, checking a deploy, any live test |
| `uploads-and-audio` | Uploads, storage buckets and policies, `<audio>`, the audio proxy |
| `auth-and-security` | A route's auth, the middleware, public paths, keys, rate limits, CSP |
| `database-changes` | A table, column, policy or SQL function; applying anything to Supabase |
| `cassette-studio` | Covers, handwriting and titles, looks, moving covers, Film it |
| `mix-check` | Mix analysis and its notes, genre references |
| `share-pages` | Public song and album pages, share tokens, the link card, waveform |
| `artwork-and-video` | AI artwork, visualizers, uploaded videos, Runway, YouTube / Shorts renders |
| `infra-panel` | The owner's infrastructure panel and its chat |
| `ios-build-deploy` | Any work in `ios/` or `macos/` |
| `app-store-connect` | App Store submissions, the listing, after an approval |
| `exec-daily-meeting` | The daily executive meeting routine |

## Keeping these files small

`CLAUDE.md` and this file are read at the start of every session, so every line costs attention on every task. `scripts/agent-docs-test.mjs` fails the build when they outgrow their budget.

- A new fact goes in the skill for its area, once. A new area gets its own skill and one row in the table above. Never repeat a skill's content here, in another skill or in an agent file: point to it.
- A skill covers one area, says in its description what it covers and when to read it, and keeps deep reference in files beside `SKILL.md`.
- Add a line here only if every session needs it: a rule for working with the owner, a command, a constraint that cuts across the codebase. One or two lines, with the date and the owner's words when it comes from them, and mark your own interpretation as a reading.
- Don't record history here. What shipped and when is in git.
- When a fact changes, change it where it lives instead of adding a correction beside it.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
