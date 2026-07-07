# mixBase

Rough-to-release version control for music. Musicians upload mix versions, gather
timestamped feedback via public share links, generate cover artwork and looping
visualizers, render finished YouTube/Shorts videos, and run a release checklist —
across a Next.js web app and a native SwiftUI iOS app.

- **Prod:** https://mixbase.app · **Staging:** https://mixbase-staging.up.railway.app
- **Stack:** Next.js 16 (App Router, React 19) · Supabase (Postgres + Auth + Storage) ·
  Railway (hosting) · Stripe (billing) · Replicate / Runway / Anthropic (AI) · Sentry

## Architecture notes

- **Auth:** middleware (`src/proxy.ts`) verifies the `sb-access-token` JWT locally
  against `SUPABASE_JWT_SECRET`, refreshes when expired, and injects `X-User-Id`.
  Routes read identity from that header only — never from the request body. A
  `Authorization: Bearer <token>` header is also accepted (for the iOS app).
- **Uploads never route file bytes through Railway** (its proxy truncates bodies
  over 10 MB). Files ≤50 MB use a signed URL direct to Supabase; larger files use
  TUS chunked upload through `/api/tus` (8 MB chunks). Both paths are authenticated.
- **Audio** is served through `/api/audio/[...path]` so Range requests work
  (seeking/duration). Always wrap Supabase audio URLs with `audioProxyUrl()`.
- **iOS** (`ios/`) is a fully native SwiftUI app with its own `AVPlayer` engine — not
  a WebView wrapper. **macOS** (`macos/`) is an internal infra-monitoring dashboard.

## Development

```bash
npm install
npm run dev            # http://localhost:3000
npm run lint           # must pass before every push
npm run build          # must pass before every push
npm test               # renderer + JWT smoke tests (no network/secrets needed)
npm run test:e2e       # Playwright (targets staging by default; BASE_URL to override)
```

Node ≥ 20.9 (`.nvmrc` pins 20). Copy `.env.example` to `.env.local` and fill in
the required variables.

### Key environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Admin DB/auth/storage access (bypasses RLS) |
| `SUPABASE_JWT_SECRET` | staging+prod | Local JWT signature verification (auth-bypass risk if unset) |
| `NEXT_PUBLIC_SUPABASE_URL` / `..._ANON_KEY` | yes | Client Supabase access |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / price IDs | if billing | Subscriptions |
| `ANTHROPIC_API_KEY` / `REPLICATE_API_TOKEN` / `RUNWAY_API_KEY` | optional | AI features |
| `SUPABASE_MANAGEMENT_TOKEN` | optional | Runtime schema self-heal + `/api/db-init` |
| `NEXT_PUBLIC_SENTRY_DSN` | optional | Error monitoring (not a secret) |

See `.env.example` for the full list.

## Deploying

`main` is production and is branch-protected. The path to prod is a PR from `tst`
merged once the **Build & Lint** and **Secret Scanning** checks are green:

```bash
git push origin tst
# open a PR tst → main and merge when required checks pass (deploys prod)
```

Database changes ship as files in `supabase/migrations/` and, where they must
survive a deploy that races the migration, as idempotent runtime self-heals in
`src/lib/schema-heal.ts` (also mirrored into `/api/db-init`).

## Testing

- `npm test` runs `scripts/verify-token-test.mjs`, `scripts/finalize-test.mjs`, and
  `scripts/video-test.mjs` — self-contained, exercising the real JWT-verify,
  artwork (sharp + opentype), and video (bundled ffmpeg) code paths.
- `scripts/test-upload.mjs <url>` and `scripts/test-infra.mjs <url> <email> <pass>`
  smoke-test a deployed instance.
