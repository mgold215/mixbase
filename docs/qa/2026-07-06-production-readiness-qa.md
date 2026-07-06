# mixBASE — Production Readiness QA (Full End‑User Test)

**Date:** 2026‑07‑06
**Tester:** Claude Code (automated end‑user QA via Chrome DevTools)
**Environments:** Staging (`https://mixbase-staging.up.railway.app`) for deep interactive testing · Production (`https://mixbase.app`) read‑only smoke
**Method:** A fresh QA account was created through the real signup UI and driven through every user flow (desktop + mobile), plus API/authorization probing, Supabase security/performance advisors, Railway runtime logs, Lighthouse, and the existing Playwright suite. The QA account and all its data were deleted at the end (see Cleanup).

> **Note on the shared database.** Staging and production run the **same** Supabase project and are at code parity today, so DB‑level and config findings below apply to **both** environments.

---

## Executive summary & Go / No‑Go

**Recommendation: NO‑GO as‑is — but the single hard blocker is a 5‑minute fix.**

The app is genuinely strong: signup/login, versioned uploads (both small and large/resumable), audio playback, the share‑link + timestamped‑feedback loop, AI artwork generation, collections, the release pipeline, the curator‑pitch tool, mobile/PWA, and the admin panel all work and feel polished. Cross‑user data isolation is solid, production is healthy, and all security headers are present.

However, one **P0 security misconfiguration** must be fixed before any production sign‑off, and there are **four P1 issues** — two of them (account deletion, AI visualizer) are broken features, and one (account deletion) is an **Apple App Store submission blocker**.

| Severity | Count | Gate |
|---|---|---|
| **P0 — blocker** | 1 | Must fix before PRC sign‑off |
| **P1 — must‑fix** | 4 | Fix before launch / App Store submission |
| **P2 — important** | 7 | Fix in the launch window |
| **P3 — polish** | ~13 | Backlog |

**Path to GO:** set `SUPABASE_JWT_SECRET` on both Railway services and redeploy (closes P0), fix account deletion and the visualizer save (P1), and make a decision on the password‑recovery and monetization gaps. Re‑test the four P1 items and it's a GO.

---

## P0 — Blocker (must fix before production sign‑off)

### P0‑1 · Authentication bypass — `SUPABASE_JWT_SECRET` is not set on staging **or** production
**What it means in plain terms:** the app is supposed to cryptographically verify the login token in each request's cookie so nobody can forge one. That verification is currently **switched off** because the secret it needs isn't configured. In this state, someone who hand‑crafts a token with another user's ID is trusted as that user — full account takeover, bypassing the per‑user data isolation.

**Evidence:**
- Railway startup logs on **both** environments, every container start: `[proxy] SUPABASE_JWT_SECRET is not set — access tokens are NOT signature‑verified.`
- Code confirms this is fail‑*open*: `src/lib/verifyToken.ts` (lines 63–74) decodes the token **without** checking the signature when no secret is set, and `src/proxy.ts` (lines 144–155) trusts the resulting user ID without checking the `verified` flag. The server then uses that ID with the service‑role key, bypassing row‑level security.
- `CLAUDE.md` itself lists `SUPABASE_JWT_SECRET` as **"required on staging+prod."** It is set on neither.

**Fix (trivial):** In Supabase → Settings → API → JWT Secret, copy the value; add it as `SUPABASE_JWT_SECRET` on the mixbase **production** and **staging** Railway services; redeploy. After redeploy, the startup warning should be gone. *(This was verified by code + deploy‑log evidence only — no live token forgery was performed against the shared production database.)*

---

## P1 — Must‑fix before launch

### P1‑1 · "Delete Account" is broken (App Store + GDPR blocker)
`/profile → Delete Account` (type‑DELETE‑to‑confirm) returns **"Failed to delete account."** `POST /api/auth/delete-account` → **500** `{"error":"Failed to delete account"}`. The account is **not** deleted.

**Why it's a blocker:** Apple **requires** in‑app account deletion for any app that supports account creation (App Store Review Guideline 5.1.1(v)); this alone can cause rejection. It's also a GDPR "right to erasure" gap. **Likely cause:** during manual cleanup, direct deletion of `storage.objects` rows is rejected by a `storage.protect_delete()` trigger ("Direct deletion from storage tables is not allowed — use the Storage API"). If the delete‑account route purges storage rows via SQL instead of the Storage API — or deletes DB rows in the wrong foreign‑key order (e.g. `mb_releases.final_version_id`, `mb_feedback`) — it will 500. *(Server‑log root cause pending; see appendix.)*

### P1‑2 · AI Visualizer "Save" fails (headline Studio‑tier feature) + leaks orphaned files
The **free** canvas visualizer renders and previews fine, but saving returns **"Save failed."** `POST /api/visualizer/save` → **500** `{"error":"Failed to save visualizer"}`. So visualizers can't be persisted or pinned to a project.
**Root cause (found during cleanup):** the WebM **does** upload to the `mf-video` bucket successfully — the 500 is the **database insert into `mb_visualizers`**. The Supabase security advisor shows `mb_visualizers` has RLS **enabled with zero policies** (deny‑all); if the save route uses a non‑service‑role client, the insert is blocked. **Side effect:** every failed save leaves an **orphaned video file** in storage (one 1.2 MB WebM was left behind by this test). **Fix:** insert with the service‑role client (or add an RLS insert policy for `mb_visualizers`). The paid Runway path was not run because it saves through the same broken endpoint.

### P1‑3 · No password‑recovery ("Forgot password?") flow
The login page has **no** "Forgot password?" link and there is no email‑recovery route — only an authenticated change‑password. A user who forgets their password is permanently locked out with no self‑serve path. Combined with the fact that signup does **not** verify the email (below), a mistyped email at signup becomes an unrecoverable account. **Fix:** add a Supabase password‑reset flow (`resetPasswordForEmail` → recovery page).

### P1‑4 · Monetization UI is unwired — `/upgrade` 404s, no upgrade path, raw errors on limits
Pricing is advertised on the landing page (Free/Pro $8.99/Studio $19.99) and tier limits are enforced server‑side, but there is **no** in‑app way to subscribe: an authenticated visit to `/upgrade` returns **404** (unauthenticated it just redirects to `/login`, which can look like it "exists"). Stripe checkout's own `cancel_url` points at `${origin}/upgrade`, so a cancelled checkout would land on a 404. No component links to checkout, and hitting a free‑tier limit surfaces a raw server error rather than an upgrade prompt. **Decision needed:** either finish the upgrade page + CTAs, or ship monetization "dark" and remove the pricing/`cancel_url` references until it's built.

---

## P2 — Important (fix in the launch window)

- **P2‑1 · Editing the Artist/Producer name silently fails.** `/profile` → change name → Save does nothing (reverts on reload). `PATCH /api/auth/me` → **500** `new row violates row‑level security policy for table "profiles"` — the profiles‑table update is blocked by RLS. No error is shown to the user. This also breaks the pitch tool (below). *Fix:* update `profiles` with the service‑role client or fix the profiles UPDATE policy's `WITH CHECK`.
- **P2‑2 · Curator pitches are mis‑attributed.** The Submit tool's generated pitch reads *"I'm moodmixformat … — Matt (moodmixformat)"* regardless of who is logged in (the QA account's name is "QA Tester"). It uses hardcoded developer defaults instead of the user's name — a direct consequence of P2‑1 (the name never reaches the `profiles` row the pitch reads from). Every other artist's pitches would be signed as the developer.
- **P2‑3 · Large uploads don't refresh the version list.** After a big file finishes via the resumable (chunked) path, the UI still shows "Done!" but the version list and mix count don't update until a manual reload — a user can reasonably think it failed and re‑upload. (The small‑file path is fine because it navigates to the new project.) *Fix:* re‑fetch versions after the chunked upload resolves.
- **P2‑4 · Large‑WAV audio streaming is fragile.** Streaming a 60 MB WAV threw a recoverable `net::ERR_HTTP2_PROTOCOL_ERROR` (Supabase returned a full‑file `Content-Range` to a partial request); the browser recovered and playback/seeking worked. But production logs independently show the same path can hard‑fail at the proxy's 30 s upstream timeout ("failed to pipe response / TimeoutError"). Usually fine, occasionally times out on slow/cold‑cache paths. *Consider:* warm‑up/retry, or a "large file, may take a moment" hint.
- **P2‑5 · No branded 404 / error pages.** Invalid share tokens and unknown routes render the **default** Next.js "404: This page could not be found." There is no `not-found.tsx` or `error.tsx`. Off‑brand for a customer‑facing product.
- **P2‑6 · Playwright E2E suite can't authenticate.** `tests/e2e/global-setup.ts` uses the **legacy single‑password** login (fills only the password field); the multi‑user form keeps Sign‑in disabled without an email, so setup times out and **0 tests run**. The safety net is effectively offline. *Fix:* update global‑setup to email+password with a dedicated test account.
- **P2‑7 · Mutating a non‑owned project returns 500 instead of 404/403.** `PATCH /api/projects/<not‑mine>` → 500 (the mutation is still correctly blocked — reads on non‑owned resources properly 404 — but the error handling is sloppy). Not a security hole; a robustness/error‑shape issue.

---

## P3 — Polish & enhancements (backlog)

- **Silent success on saves** — password change and (attempted) name save show no confirmation; add a success toast. A consistent toast system would help across the app (today it's a mix of inline strings and ad‑hoc flashes).
- **Signup doesn't verify email** — account is created and logged in immediately; combined with no password recovery (P1‑3), typos are unrecoverable. Consider email verification.
- **Accessibility** (Lighthouse a11y 93): no `<main>` landmark; `user-scalable=no` blocks pinch‑zoom (intentional for the iOS PWA, but hurts low‑vision users — worth revisiting); several form fields on the project page lack labels/`id`s.
- **Destructive‑action inconsistency** — project delete uses a native browser `confirm()` while account delete uses a nicer type‑DELETE modal; standardize on the modal.
- **Copy** — "Pitching … to **1 curators**" (pluralization); the share page's "What u think?" reads very casual for label/curator audiences; Studio tier lists the **same** "25 AI artworks/month" as Pro (only visualizers differ), which can read as no artwork upgrade.
- **Brand color** — the full‑screen player's play button is bright green while the rest of the app uses the teal accent.
- **AI config** — `ANTHROPIC_API_KEY` is **missing on staging** (AI feedback‑summary/admin‑assistant can't be tested there — verify it's set on production); and the user‑facing error leaks the internal variable name ("Set ANTHROPIC_API_KEY") rather than a friendly message.
- **Supabase security advisors** (apply to prod too): the three public `mf-*` buckets allow file **enumeration** (not just fetch‑by‑URL); `mb_feedback` accepts **unrestricted anonymous inserts** (app rate‑limits, DB doesn't); the `increment_artwork_usage` / `increment_video_usage` RPCs are `SECURITY DEFINER` and callable by anon/authenticated (usage counters could be inflated); Supabase leaked‑password protection (HaveIBeenPwned) is disabled.
- **Ops** — the `SENTRY_AUTH_TOKEN` lacks issue‑read scope, so there's no programmatic visibility into production errors (create a project/event‑read token). A leftover `testuser_debug@mixbase.test` account sits in the Users list. Performance advisors flag `auth.uid()` re‑evaluated per row and duplicate permissive RLS policies across all `mb_*` tables (fine now, matters at scale).

---

## What works well (verified)

- **Auth:** signup with correct client validation; login with a safe "Invalid email or password" (no account‑existence leak) and busy states; logout; session cookie round‑trip; change‑password.
- **Uploads:** small files via signed URL and large files (61 MB tested) via the resumable chunked path both succeed and persist; automatic BPM/key detection.
- **Audio:** single global player; mini‑player ↔ full player stay in sync; seeking works; playback survives navigation; public share playback works logged‑out.
- **Share + feedback loop:** public share page, star rating, **timestamp‑pinned** comments, "Feedback sent!", and on the owner side a waveform marker, "Punch list", and per‑comment play‑from‑timestamp.
- **AI artwork:** generation (Flux/Imagen) + the finalize step (filters, 9‑position text placement, colors, divider) produced **professional‑quality** output with a clean text lockup.
- **Collections, Pipeline, Submit, Media:** create/add/reorder/export collections; release checklists with progress and a board view; a rich 75‑curator directory with filters, CSV import/export, and personalized pitch generation; media library with cover assignment.
- **Mobile/PWA:** clean bottom‑tab nav; mini‑player correctly stacks above the tab bar with safe‑area padding; polished full‑screen mobile player; service worker + manifest configured.
- **Admin panel:** Users/Usage/Content all render real data (read‑only verified).
- **Security posture (the parts that are right):** cross‑user reads are denied (404, no leak); production is healthy (all endpoints 200, DB ok); all six security headers present (CSP, HSTS 1yr, X‑Frame SAMEORIGIN, nosniff, Referrer‑Policy, Permissions‑Policy); Lighthouse Best‑Practices 96 / SEO 100.

---

## Manual‑test checklist (things automation can't cover)

- [ ] **Real iOS device** (iPhone 15 Pro Max): background audio, lock‑screen/Media Session controls, and interruption recovery in the installed PWA / native wrapper — these can't be emulated.
- [ ] **Apple & Google OAuth** round‑trip (buttons render and initiate redirect; a full round‑trip needs real provider accounts).
- [ ] **Email deliverability** for any password‑recovery/verification once built.
- [ ] **Production config parity:** confirm `SUPABASE_JWT_SECRET` (P0), `ANTHROPIC_API_KEY`, `REPLICATE_API_TOKEN`, `RUNWAY_API_KEY`, and Stripe secrets are set on **production** specifically.
- [ ] Re‑run this pass against production for the four P1 items after fixes.

---

## Cleanup (test‑data hygiene)

The QA account (`mixbase.qa.20260706@gmail.com`) and everything it created — 1 project, 2 versions, 1 collection, 1 release, feedback, generated artwork, and an orphaned visualizer file — were removed. Because the in‑app Delete Account is broken (P1‑1), removal was done via Supabase (DB rows + Storage API + auth admin API). Verified: the QA user, all `mb_*` rows, its profile, and all its storage objects are **gone**; the environment is back to its exact pre‑QA baseline (5 users, 62 projects). No orphaned test data remains.

---

## Appendix — how this was tested

Chrome DevTools drove the browser (interaction, console/network capture, device emulation, Lighthouse). Supporting signal came from: Supabase advisors + SQL row counts, Railway runtime/deploy logs (both environments), the existing Playwright suite, and read‑only production curls. All rate limits were respected (one login per account, one artwork generation, one visualizer generation). Screenshots captured during the run: unbranded 404, generated + finalized artwork, pipeline board, and mobile dashboard/mini‑player/player.
