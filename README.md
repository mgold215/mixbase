# mixBase

Rough-to-release version control for music. Musicians upload mix versions, gather
timestamped feedback via public share links, generate cover artwork and looping
visualizers, render finished YouTube/Shorts videos, and run a release checklist —
across a Next.js web app and a native SwiftUI iOS app.

- **Prod:** https://mixbase.app · **Staging:** https://mixbase-staging.up.railway.app
- **Stack:** Next.js 16 (App Router, React 19) · Supabase (Postgres + Auth + Storage) ·
  Railway (hosting) · Replicate / Runway / Anthropic (AI) · Sentry
- **Free:** there are no paid plans, on the website or in the apps.

## Architecture notes

- **Web** is a Next.js app; **iOS** (`ios/`) is a fully native SwiftUI app with its own
  `AVPlayer` engine, not a WebView wrapper; **macOS** (`macos/`) builds the same app from
  the iOS source tree, plus a separate infrastructure control panel.
- A feature's logic lives in a server route that both the web and the apps call.
- The rules that are easy to break (uploads and storage limits, auth, database changes,
  deploys) are written once, in `AGENTS.md` and the notes under `.claude/skills/`.
  Start there before changing anything.

## Development

```bash
npm install
npm run dev            # http://localhost:3000
npm run lint           # must pass before every push
npm run build          # must pass before every push
npm test               # every unit suite (Node 22+; no network/secrets needed)
npm run test:e2e       # Playwright (targets staging by default; BASE_URL to override)
```

Node ≥ 20.9 (`.nvmrc` pins 20). Copy `.env.example` to `.env.local` and fill in
the required variables.

### Key environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Admin DB/auth/storage access (bypasses RLS) |
| `SUPABASE_JWT_SECRET` | legacy | Verifies old HS256 tokens; removed once JWT signing keys are in use |
| `NEXT_PUBLIC_SUPABASE_URL` / `..._ANON_KEY` | yes | Client Supabase access |
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

- `npm test` runs every unit suite in `scripts/*-test.mjs` (auth, uploads, database
  rules, artwork, video, share pages and more) with no network or secrets.
- `scripts/test-infra.mjs <url> <email> <pass>` smoke-tests a deployed instance.
- `.claude/skills/preflight-checks/SKILL.md` lists which suites cover which area.
