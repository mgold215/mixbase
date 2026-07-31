---
name: preflight-checks
description: The verification gate before every commit/push and before telling the user any fix or feature is "done". Use this whenever work is about to be committed, pushed, or reported complete — even for "small" or "one-line" changes, which is exactly where skipped checks bite. Maps each area of the codebase to the smoke test that covers it.
---

# Preflight Checks

"All relevant tests must pass before telling the user a fix is done" is a hard project rule. A fix that hasn't been verified is not done — report it as in-progress or broken, never as fixed.

## Always (every push, no exceptions)

```bash
npm run lint
npm run build
```

Both must exit 0. The CI "Build & Lint" check runs the same thing — catching it locally saves a failed-PR round trip.

## Usually

```bash
npm test        # renderer + unit suite: auth tokens, artwork models, share projection,
                # RLS, SQL guard, BPM, usage refunds, effects, finalize, video
```

Run it whenever the change touches `src/lib/` or any API route. It's fast and has caught regressions in nearly every subsystem.

## Targeted smoke tests — pick by what changed

| Files touched | Run |
|---|---|
| `tus`, `upload-url`, `audio`, storage, `ProjectClient` upload path | `SUPABASE_SERVICE_ROLE_KEY=... node scripts/test-upload.mjs https://mixbase-staging.up.railway.app` |
| artwork generation / finalize, fonts, `sharp` | `node scripts/finalize-test.mjs` |
| video render / visualizer / ffmpeg | `node scripts/video-test.mjs` |
| `src/lib/infra/`, `/api/infra/*` | `node scripts/test-infra.mjs <staging-url> <admin-email> <admin-pass>` |
| auth, middleware (`src/proxy.ts`), cookies | `node scripts/verify-token-test.mjs && node scripts/auth-errors-test.mjs` (also in `npm test`) |
| share pages / public routes | `node scripts/share-projection-test.mjs` |
| Full user flows / UI | `npm run test:e2e` (staging by default; `BASE_URL=http://localhost:3000` for local) |

## Commit hygiene

- The pre-commit gitleaks hook scans for secrets. If it fires, remove the secret — never `--no-verify`.
- Clear, descriptive commit messages.

## Honest reporting

If a test fails and you can't fix it this round, say so with the failing output. Never summarize a partially-verified change as complete — the user deploys straight to production on your word.
