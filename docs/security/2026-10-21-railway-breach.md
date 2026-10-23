# Railway env-var breach — 2026-10-21

## What happened

On 2026-10-21 Railway detected that an intruder may have read the encrypted
environment variables of customer services, and decrypted some of them.
Railway believes the goal was to steal keys for AI providers (Anthropic,
OpenAI and similar). Its email to us (2026-10-22, "Urgent: Railway Security Disclosure - Rotate
Credentials") says: *"Immediately revoke and reissue all environment
variables, including any API keys, stored in Railway"* and *"Review logs for
those services for unusual activity."* Railway also invalidated every Railway
API token, and told the AI providers to revoke keys they saw in the dump.

Railway's follow-up (2026-10-23, with its preliminary report) narrowed it:
the attacker searched for environments holding **AI API keys or cloud
provider API keys**, **our workspace contains variables matching that
pattern**, and Railway cannot confirm whether ours were decrypted. It asks for
the same three things: rotate, update Railway variables and redeploy, and
review provider activity — especially AI keys — plus GitHub and any image
registry (Docker Hub etc.). mixBase builds from source (nixpacks), so it has
no registry credentials; check the trading bot and any other service.

The same day, CI flagged two new **critical** advisories in the web server's
own dependencies — unauthenticated remote code execution in Next.js ≤16.4.0
and a middleware (auth) bypass in `@sentry/nextjs` ≤10.75.1 via the tunnel
route this app uses. Either would let an attacker read the NEW keys straight
from the running server, so both were patched (Next 16.4.3, Sentry 10.76.2)
in the same change, before rotating.

**Rule from now on: every value that has ever been stored in a Railway
variable is considered public. Never put an old value back.**

## What was checked (2026-10-23) — no misuse found

| Where | What | Result |
|---|---|---|
| Supabase edge logs, Oct 20 18:00 → Oct 23 18:00 UTC | Every request grouped by key type, network (ASN), country, client | Only known clients: your iPhone/Mac (T-Mobile/Comcast/Verizon, US), the mixBase server (Railway), the trading bot (Railway, daily 21:00 UTC — same pattern back to at least Oct 9). Nothing from any other network or country. |
| Supabase auth audit log + roles | New admin actions, new database roles since Oct 20 | None |
| Supabase accounts | New/changed users | No new accounts; changes match normal sign-ins |
| Supabase storage | Files added/changed/deleted since Oct 21 | 1 new artwork, nothing modified or deleted |
| GitHub `mgold215/mixbase` | Commits, branches, workflow runs since Oct 19 | No commits; only the scheduled TestFlight-invite job |

Not checkable from here: usage dashboards at Anthropic, Replicate, Runway,
Spotify and Sentry — look at those while rotating (step 6–8 below).

## What the code change does

The leaked Supabase keys are the dangerous ones: the legacy `service_role`
key and the JWT secret each give full control of the database. Supabase can
only kill them **together with** the legacy public `anon` key — and the
shipped iPhone/Mac app had that anon key built in, so killing it would have
broken every installed copy. The fix:

- iPhone/Mac app, website and the App Store screenshot job now use the new
  **publishable key** (`sb_publishable_…`) instead of the legacy anon key.
- The large-file upload path (`/api/tus`) now sends the server key in the way
  the new **secret keys** (`sb_secret_…`) require. Without this, switching the
  server to a secret key would have broken every upload over 50 MB.
- The login check is tested against the new ES256 tokens, so the leaked JWT
  secret can be deleted from Railway.
- `scripts/supabase-keys-test.mjs` fails the build if a legacy key comes back.

## Checklist

Do these in order. ☐ = still to do.

### Phase 1 — now (no downtime)

0. ☐ **Wait until this code change is live on mixbase.app** (the PR from
   `tst` → `main`). Step 2 depends on it.
1. ☐ **Supabase → Project Settings → API Keys → "Publishable and secret API
   keys"** — create a new secret key named `mixbase-server`, and a second one
   named `trading-bot`. One key per service means a future leak only forces
   one rotation. If an older secret key (e.g. `default`) was ever pasted into
   Railway, delete it.
2. ☐ **Railway → mixBase service → Variables**, in **both production and
   staging**:
   - `SUPABASE_SERVICE_ROLE_KEY` → the new `mixbase-server` secret key
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` → delete it (the code falls back to the
     publishable key) or set it to `sb_publishable_z4qhiUQPNegRhalC-p-YKg_-Ubu_qpD`
   - Redeploy. Check: `https://mixbase.app/api/health` shows
     `"service_key": true`, then sign in, and upload one file over 50 MB.
3. ☐ **Railway → trading bot service → Variables** — replace its Supabase key
   with the `trading-bot` secret key. It talks to Supabase with raw
   `python-requests`, so make sure it sends the key in the `apikey` header
   only — a secret key in `Authorization: Bearer` is rejected. Check: the next
   21:00 UTC run still writes a `trading_runs` row.
4. ☐ **Supabase → Project Settings → JWT Keys** — click **Migrate JWT
   secret**, then **Rotate keys** so the new ES256 key signs all new logins.
   Nobody gets signed out. Then **delete `SUPABASE_JWT_SECRET` from Railway**
   (both environments) and redeploy — from that moment the server no longer
   trusts tokens forged with the leaked secret.
5. ☐ **Supabase → Account → Access Tokens** — revoke the token that was in
   `SUPABASE_MANAGEMENT_TOKEN` (it controls the whole Supabase account), create
   a new one, put it in Railway. Also set `DB_INIT_SECRET` to a new random
   value (e.g. a password-manager-generated 40-character string).
6. ☐ **AI providers — the attackers' actual target.** For each: delete the
   old key, create a new one, put it in Railway, and look at usage/billing
   since Oct 20 for anything you didn't do. Railway asked these providers to
   revoke leaked keys, so the old ones may already be dead (artwork/video/
   mix-notes features would be failing until the new keys are in).
   - ☐ Anthropic Console → API Keys (`ANTHROPIC_API_KEY`)
   - ☐ Replicate → Account → API tokens (`REPLICATE_API_TOKEN`)
   - ☐ Runway developer portal → API keys (`RUNWAY_API_KEY`)
7. ☐ **Other services** — same: revoke, reissue, update Railway.
   - ☐ Spotify Developer Dashboard → your app → rotate client secret (`SPOTIFY_CLIENT_SECRET`)
   - ☐ Sentry → Settings → Auth Tokens (`SENTRY_AUTH_TOKEN`). The DSN is public — no change.
   - ☐ GitHub → Settings → Developer settings → Tokens (`GITHUB_TOKEN`). Make
     the new one fine-grained: only `mgold215/mixbase`, only Actions read/write.
   - ☐ Railway → Account → Tokens (`RAILWAY_API_TOKEN`) — Railway already
     killed the old one, so the admin panel's Railway view is blank until a
     new one is set.
8. ☐ **Leftovers** — if any of `MIXFOLIO_PASSWORD`, `SESSION_SECRET`,
   `SENDER_EMAIL`, `SENDER_APP_PASSWORD` still exist in Railway, delete them
   (nothing uses them). If `SENDER_APP_PASSWORD` ever held a real Gmail app
   password, revoke it at myaccount.google.com/apppasswords — an app password
   can read the whole mailbox.
9. ☐ **Every other Railway service and project** in the account (the trading
   bot's brokerage/exchange keys, anything else) — rotate all of their
   variables too. Railway's advice covers everything stored there.

### Phase 2 — once the new app build is what people run

10. ☐ The new iPhone/Mac build reaches TestFlight automatically when this
    change merges. Submit version **1.0.2** to the App Store so App Store
    users get it too.
11. ☐ **Supabase → API Keys → "Legacy API keys" → disable** the JWT-based
    `anon` and `service_role` keys. Then **JWT Keys → Previously used →
    legacy secret → Revoke.** Only now are the leaked legacy service key and
    JWT secret fully dead. Any device still on App Store 1.0.1 (or a TestFlight
    build older than this change) loses its connection until it updates. In
    the last 30 days that was 3 iOS accounts besides yours (2 of them App
    Review demo accounts). Supabase retires the legacy keys at the end of
    2026 regardless, so this step is due by then at the latest. Both switches
    can be flipped back if something was missed.
