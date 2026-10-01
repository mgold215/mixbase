# mixBASE — Production Readiness QA (Full End‑User Test)

**Date:** 2026‑07‑06
**Tester:** Claude Code (automated end‑user QA via Chrome DevTools)
**Environments:** Staging (`https://mixbase-staging.up.railway.app`) for deep interactive testing · Production (`https://mixbase.app`) read‑only smoke
**Method:** A fresh QA account was created through the real signup UI and driven through every user flow (desktop + mobile), plus API/authorization probing, Supabase security/performance advisors, Railway runtime logs, Lighthouse, and the existing Playwright suite. The QA account and all its data were deleted afterward (see Cleanup).

> **Shared database:** staging and production run the **same** Supabase project (`mmf-agents`) and are at code parity today. DB‑level findings apply to both. **Environment‑variable findings do not** — staging and production are separate Railway services with their own env vars, and that distinction turns out to matter a lot here (see the Environment Caveat).

---

## Executive summary & Go / No‑Go

**Recommendation: NO‑GO until one production security env‑var is set — but that is the only hard production blocker, and it's a 5‑minute fix.**

The app itself is genuinely strong. Signup/login, versioned uploads (small and large/resumable), audio playback, the share‑link + timestamped‑feedback loop, AI artwork generation, collections, the release pipeline, the curator‑pitch tool, mobile/PWA, and the admin panel all work and feel polished. Cross‑user data isolation is solid, production is healthy, and all security headers are present.

**One real production blocker:** a P0 security misconfiguration — `SUPABASE_JWT_SECRET` is unset — **confirmed on production** (and staging) via boot logs. It's a 5‑minute env‑var fix.

**Three "bugs" I hit were staging‑only and do NOT affect production** (verified — see the Environment Caveat). Staging's Supabase **service‑role key is invalid**, so its server admin client runs as anon and RLS blocked account deletion, visualizer save, and profile‑name edit *during this test*. Production's service‑role client was **independently verified healthy** (a full service‑role‑gated TUS upload succeeded on prod, and there are **zero** RLS‑violation errors across 28 h of real prod traffic), so those three features work for live users. The action items there are to (a) fix staging's key so staging is a faithful pre‑prod gate, and (b) add a one‑line error log to the delete‑account route.

The remaining genuine product gaps — **no password recovery** and an **unwired upgrade/monetization path** — are decisions, not outages.

| Severity | Count | Gate |
|---|---|---|
| **P0 — blocker (prod)** | 1 | Must fix before PRC sign‑off |
| **P1 — product gaps + staging config** | 4 | Address before launch |
| **P2 — important** | 6 | Fix in the launch window |
| **P3 — polish** | ~13 | Backlog |

**Path to GO:** set `SUPABASE_JWT_SECRET` on both Railway services (P0 — the only prod blocker); fix staging's `SUPABASE_SERVICE_ROLE_KEY` so staging mirrors prod; add the missing error log to the delete‑account route; and decide on the password‑recovery and monetization gaps. Then it's a GO.

---

## ⚠️ Environment caveat — staging's service‑role key is broken (read this first)

Server‑side, mixBASE builds one privileged Supabase client (`supabaseAdmin`) that is supposed to bypass row‑level security. The constructor (`src/lib/supabase.ts:11`) **silently falls back to the public anon key** if the service‑role key is missing or invalid:

```
createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY ?? SUPABASE_ANON_KEY)
```

On **staging**, that fallback is active — `supabaseAdmin` is effectively running as **anon**, so any write to a table whose RLS doesn't happen to permit anon is rejected. Verbatim staging log: `[visualizer-store] db insert error: new row violates row-level security policy for table "mb_visualizers"`. The boot check only tests for *presence*, not validity, so a **stale/rotated** key produces no warning while still degrading to anon.

**Two consequences:**
- **It manufactured three of the "bugs" I hit** (P1‑1, P1‑2, P2‑1 below). The code is fine — production already contains data these paths created (2 saved visualizers from 2026‑07‑02; 3 profiles with artist names), proving the writes work when the key is valid.
- **It means staging was not a faithful mirror of production during this pass.** Using staging as the PRC gate is only safe once its secrets match prod. This is a **process risk** worth fixing regardless of the specific features.

**Production was checked and is NOT affected.** Prod's service‑role client was verified healthy two ways: (1) a service‑role‑gated **TUS upload succeeded on production** in the last 24 h (`POST /api/tus` → 201 + chunk writes → 204 — this path 500s if the key is unset and is rejected if it's invalid), and (2) **zero** `violates row-level security policy` errors across the full ~28 h production deployment window despite real traffic. So account deletion, visualizer save, and profile‑name edit work for live users. *(Nuance: prod's SERVICE_ROLE_KEY warning being absent only proves the var is populated — the functional TUS + zero‑RLS‑error evidence is what proves it's valid.)*

**Fix:** set a valid `SUPABASE_SERVICE_ROLE_KEY` on the **staging** Railway service from the current `mmf-agents` keys so staging stops silently degrading to anon and can serve as a faithful PRC gate. (Production also needs `SUPABASE_JWT_SECRET` — see P0‑1 — but that is a separate variable and a separate problem.)

---

## P0 — Blocker (must fix before production sign‑off)

### P0‑1 · Authentication bypass — `SUPABASE_JWT_SECRET` is not set on staging **or** production
**Plain terms:** the app should cryptographically verify the login token in each request's cookie so nobody can forge one. That verification is currently **off** because its secret isn't configured. In this state, a hand‑crafted token carrying another user's ID is trusted as that user — full account takeover, bypassing per‑user isolation.

**Evidence:**
- Railway startup logs on **both** environments, every container start: `[proxy] SUPABASE_JWT_SECRET is not set — access tokens are NOT signature‑verified.`
- Fail‑*open* by design: `src/lib/verifyToken.ts` (lines 63–74) decodes the token **without** checking the signature when no secret is set, and `src/proxy.ts` (lines 144–155) trusts the resulting user ID without checking the `verified` flag. The server then uses that ID with the (intended) service‑role key, bypassing RLS.
- `CLAUDE.md` lists `SUPABASE_JWT_SECRET` as **"required on staging+prod."** It is set on neither.

**Fix (trivial):** Supabase → Settings → API → JWT Secret → add as `SUPABASE_JWT_SECRET` on both Railway services → redeploy; the startup warning should disappear. *(Confirmed by code + deploy‑log evidence only — no live token forgery was performed against the shared production DB.)*

---

## P1 — Product gaps + staging config (address before launch)

> **P1‑1, P1‑2 and P2‑1 share the staging service‑role root cause above and were verified NOT to reproduce on production.** They are listed at their user‑facing severity for completeness; the remedy is fixing staging's key (so the PRC gate is trustworthy) plus one code‑quality follow‑up on the delete route. **P1‑3 and P1‑4 are independent, genuine product gaps.**

### P1‑1 · "Delete Account" 500 on staging (App‑Store + GDPR relevant) — production verified working
`/profile → Delete Account` (type‑DELETE‑to‑confirm) → **"Failed to delete account"** on **staging**. `POST /api/auth/delete-account` → **500** `{"error":"Failed to delete account"}`.
**Root cause (from source + logs):** the route deletes storage + DB rows, then calls the GoTrue admin `auth.admin.deleteUser()` (`src/app/api/auth/delete-account/route.ts:122‑124`), which **requires** the service‑role key. On staging (anon) that call fails and its error is **discarded** (no `console.error`/Sentry, unlike the route's other failure paths), so it silently 500s. Production's service‑role key is valid (verified), so **deletion works for live users** — but two things still matter:
1. **App‑Store readiness:** Apple requires working in‑app account deletion (Guideline 5.1.1(v)); before submitting, confirm it end‑to‑end on production with a throwaway account (it was only exercised on staging here).
2. **Code bug regardless of environment:** `delete-account/route.ts:124` should log/Sentry‑capture the `deleteUser` error like the route's other branches do, so a real deletion failure isn't invisible next time.

### P1‑2 · AI Visualizer "Save" 500 on staging — production verified working
The free canvas visualizer renders and previews, but saving → **"Save failed"** on **staging**. `POST /api/visualizer/save` → **500**. Verbatim staging log: `new row violates row-level security policy for table "mb_visualizers"` at the DB insert in `src/lib/visualizer-store.ts:60‑76` (the WebM **does** upload to `mf-video` first). Same staging service‑role root cause; production has 2 successfully‑saved visualizers and a healthy service‑role client, so it works in prod. **Two follow‑ups:**
1. **Brittleness note:** `mb_visualizers` has RLS **enabled with zero policies** (deny‑all), so this feature relies *entirely* on the service‑role bypass — the moment the key degrades (as on staging), it breaks with no fallback. Consider an explicit insert policy.
2. A failed save leaves an **orphaned file** in `mf-video` (this test left one 1.2 MB WebM, since removed) — add cleanup‑on‑failure.

### P1‑3 · No password‑recovery ("Forgot password?") flow *(independent of the env issue)*
The login page has **no** "Forgot password?" link and there's no email‑recovery route — only an authenticated change‑password. A user who forgets their password is permanently locked out. Compounded by signup not verifying the email (P3), a mistyped signup email becomes an unrecoverable account. **Fix:** add a Supabase reset flow (`resetPasswordForEmail` → recovery page).

### P1‑4 · Monetization UI is unwired — `/upgrade` 404s *(independent of the env issue)*
Pricing is advertised (Free / Pro $8.99 / Studio $19.99) and tier limits are enforced server‑side, but there's **no** in‑app way to subscribe: an **authenticated** visit to `/upgrade` returns **404** (unauthenticated it just redirects to `/login`, which can look like the page exists). Stripe checkout's own `cancel_url` points at `${origin}/upgrade`, so a cancelled checkout lands on a 404; no component links to checkout; hitting a free‑tier limit shows a raw error, not an upgrade prompt. **Decision:** finish the upgrade page + CTAs, or ship monetization "dark" and remove the pricing/`cancel_url` references until built.

---

## P2 — Important (fix in the launch window)

- **P2‑1 · Editing the Artist/Producer name silently fails on staging (service‑role root cause; prod healthy).** `/profile` → Save does nothing (reverts on reload); `PATCH /api/auth/me` → **500** `new row violates row-level security policy for table "profiles"`, and **no error is shown to the user**. Same staging root cause as P1‑1/P1‑2 (prod has 3 profiles with artist names set, so it works in prod). Regardless: **surface the error in the UI** so a genuine save failure isn't silent. **Downstream on staging:** the Submit tool's pitch text read *"I'm moodmixformat … — Matt (moodmixformat)"* for the QA account (name "QA Tester") because the name never reached the `profiles` row the pitch reads from — a symptom of the same failure. Spot‑check pitch attribution on production.
- **P2‑2 · Large uploads don't refresh the version list.** After a big file finishes via the resumable path the UI shows "Done!" but the version list/mix count don't update until a manual reload — a user can think it failed and re‑upload. (The small‑file path is fine because it navigates to the new project.) *Fix:* re‑fetch versions after the chunked upload resolves.
- **P2‑3 · Large‑WAV audio streaming is fragile.** Streaming a 60 MB WAV threw a recoverable `net::ERR_HTTP2_PROTOCOL_ERROR` (Supabase returned a full‑file `Content-Range` to a partial request); the browser recovered and playback/seeking worked. But production logs independently show the same path can hard‑fail at the proxy's 30 s upstream timeout ("failed to pipe response / TimeoutError"). Usually fine, occasionally times out on slow/cold‑cache paths. *Consider:* warm‑up/retry or a "large file" hint.
- **P2‑4 · No branded 404 / error pages.** Invalid share tokens and unknown routes render the **default** Next.js "404: This page could not be found." There is no `not-found.tsx` or `error.tsx`. Off‑brand for a customer‑facing product.
- **P2‑5 · Playwright E2E suite can't authenticate.** `tests/e2e/global-setup.ts` uses the **legacy single‑password** login (fills only the password field); the multi‑user form keeps Sign‑in disabled without an email, so setup times out and **0 tests run**. The safety net is effectively offline. *Fix:* update global‑setup to email+password with a dedicated test account.
- **P2‑6 · Mutating a non‑owned project returns 500 instead of 404/403.** `PATCH /api/projects/<not‑mine>` → 500 (the mutation is still correctly blocked — reads on non‑owned resources properly 404 — but the error handling is sloppy). Not a security hole; an error‑shape issue.

---

## P3 — Polish & enhancements (backlog)

- **Silent success on saves** — password change (and the attempted name save) show no confirmation; add success toasts. A consistent toast system would help app‑wide (today it's a mix of inline strings and ad‑hoc flashes).
- **Signup doesn't verify email** — account is created and logged in immediately; combined with no password recovery (P1‑3), typos are unrecoverable.
- **Accessibility** (Lighthouse a11y 93): no `<main>` landmark; `user-scalable=no` blocks pinch‑zoom (intentional for the iOS PWA, but hurts low‑vision users); several form fields on the project page lack labels/`id`s.
- **Destructive‑action inconsistency** — project delete uses a native `confirm()` while account delete uses a nicer type‑DELETE modal; standardize on the modal.
- **Copy** — "Pitching … to **1 curators**" (pluralization); the share page's "What u think?" reads very casual for label/curator audiences; the Studio tier lists the **same** "25 AI artworks/month" as Pro (only visualizers differ), which can read as no artwork upgrade.
- **Brand color** — the full‑screen player's play button is bright green while the rest of the app uses the teal accent.
- **AI config** — `ANTHROPIC_API_KEY` is **missing on staging** (AI feedback‑summary/admin‑assistant can't be tested there — verify it's set on production); the user‑facing error also leaks the internal variable name ("Set ANTHROPIC_API_KEY").
- **Supabase security advisors** (apply to prod too): the three public `mf-*` buckets allow file **enumeration** (not just fetch‑by‑URL); `mb_feedback` accepts **unrestricted anonymous inserts**; `increment_artwork_usage`/`increment_video_usage` are `SECURITY DEFINER` and callable by anon/authenticated; Supabase leaked‑password protection (HaveIBeenPwned) is disabled. **Note:** because staging's `supabaseAdmin` runs as anon, several `mb_*` writes still succeeded there only thanks to *overly permissive* RLS policies (the advisor's "multiple permissive policies" flags) — worth tightening.
- **Ops** — the `SENTRY_AUTH_TOKEN` lacks issue‑read scope, so there's no programmatic visibility into production errors (create a project/event‑read token). A leftover `testuser_debug@mixbase.test` account sits in the Users list. Performance advisors flag `auth.uid()` re‑evaluated per row and duplicate permissive RLS policies across all `mb_*` tables (fine now, matters at scale).

---

## What works well (verified)

- **Auth:** signup with correct client validation; login with a safe "Invalid email or password" (no account‑existence leak) and busy states; logout; session round‑trip; change‑password.
- **Uploads:** small files (signed URL) and large files (61 MB, resumable/chunked) both succeed and persist; automatic BPM/key detection.
- **Audio:** single global player; mini‑player ↔ full player stay in sync; seeking works; playback survives navigation; public share playback works logged‑out.
- **Share + feedback loop:** public share page, star rating, **timestamp‑pinned** comments, "Feedback sent!", and on the owner side a waveform marker, "Punch list", and per‑comment play‑from‑timestamp.
- **AI artwork:** generation (Flux/Imagen) + finalize (filters, 9‑position text placement, colors, divider) produced **professional‑quality** output with a clean text lockup.
- **Collections, Pipeline, Submit, Media:** create/add/reorder/export collections; release checklists with progress + board view; a 75‑curator directory with filters, CSV import/export, and personalized pitch generation; media library with cover assignment.
- **Mobile/PWA:** clean bottom‑tab nav; mini‑player stacks above the tab bar with correct safe‑area padding; polished full‑screen mobile player; service worker + manifest configured.
- **Admin panel:** Users/Usage/Content render real data (read‑only verified).
- **Security posture (the parts that are right):** cross‑user reads are denied (404, no leak); production endpoints all 200 with DB ok; all six security headers present (CSP, HSTS 1yr, X‑Frame SAMEORIGIN, nosniff, Referrer‑Policy, Permissions‑Policy); Lighthouse Best‑Practices 96 / SEO 100 / a11y 93.

---

## Manual‑test / must‑verify checklist

- [ ] **P0:** set `SUPABASE_JWT_SECRET` on **both** Railway services (confirmed missing on production) and redeploy.
- [ ] **Fix staging's `SUPABASE_SERVICE_ROLE_KEY`** so staging stops running as anon and becomes a faithful PRC gate. *(Production's service‑role key was verified valid — no action needed there.)*
- [ ] Before App‑Store submission, run **account deletion end‑to‑end on production** once (throwaway account) — it was only exercised on staging here.
- [ ] Also confirm `ANTHROPIC_API_KEY`, `REPLICATE_API_TOKEN`, `RUNWAY_API_KEY`, and Stripe secrets on **production** specifically.
- [ ] **Real iOS device** (iPhone 15 Pro Max): background audio, lock‑screen/Media Session controls, interruption recovery in the installed PWA / native wrapper (not emulable).
- [ ] **Apple & Google OAuth** round‑trip (buttons render and initiate; a full round‑trip needs real provider accounts).
- [ ] **Email deliverability** for password‑recovery/verification once built.

---

## Cleanup (test‑data hygiene)

The QA account (`mixbase.qa.20260706@gmail.com`) and everything it created — 1 project, 2 versions, 1 collection, 1 release, feedback, generated artwork, and an orphaned visualizer file — were removed. Because the in‑app Delete Account was blocked by the staging env issue, removal was done via Supabase (DB rows + Storage API + auth admin API). Verified: the QA user, all `mb_*` rows, its profile, and all its storage objects are **gone**; the environment is back to its exact pre‑QA baseline (5 users, 62 projects). No orphaned test data remains.

---

## Appendix — how this was tested

Chrome DevTools drove the browser (interaction, console/network capture, device emulation, Lighthouse). Supporting signal came from Supabase advisors + SQL, Railway runtime/deploy logs (both environments — which is how the service‑role root cause was found), the existing Playwright suite, and read‑only production curls. Rate limits were respected (one login per account, one artwork generation, one visualizer generation). Screenshots captured: unbranded 404, generated + finalized artwork, pipeline board, mobile dashboard/mini‑player/player, admin users.
