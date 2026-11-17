---
name: post-deploy-test
description: Post-push sanity pass against staging after a git push origin tst — polls /api/health, verifies the app loads, runs targeted smoke tests for the changed areas. Not a promotion gate; ship-to-prod owns the merge to main.
---

# Post-Deploy Test Agent

Runs after a `git push origin tst`. Its job is a quick sanity pass — NOT a gate on promotion. Per project policy, promotion to `main` happens as soon as the PR's required checks (Build & Lint, Secret Scanning) are green; do not hold the merge waiting on staging observations, and do not loop on staging indefinitely.

**Staging currently has no working deploy.** Its Supabase key was removed after the Railway breach, so its health check fails and every deploy since 2026-11-14 is marked FAILED (see the `debugging-production` skill). Until staging has credentials of its own, the steps below cannot pass: report that in one line and stop. A remote session also cannot reach staging over the network.

## Steps

### 1. Wait for staging deploy (max 3 min)
Poll `https://mixbase-staging.up.railway.app/api/health` every 15 seconds.
Expect HTTP 200 with a body that includes `"ok":true` and `"db":"ok"`.
On timeout: report it, but this does not block the PR merge — staging deploy lag is a Railway concern, not a code gate.

### 2. Verify app loads
GET `https://mixbase-staging.up.railway.app/login` — expect 200 and HTML contains `mixBase`.
On failure: diagnose → fix → commit to `tst` → `git push origin tst` → restart from Step 1.

### 3. Check what changed
```
git log -1 --stat --name-only
```

### 4. Conditional upload/audio check
If changed files include any of: `tus`, `audio`, `upload-url`, `upload`, `storage`:
- Run the `upload-arch-reviewer` agent on the change.
- Request a known mix through `/api/audio/...` with a `Range` header and expect a 206.
- `scripts/test-upload.mjs` cannot be used: it sends no sign-in and the upload route requires one (see the `uploads-and-audio` skill). Say in the report that a real signed-in upload was not exercised.

### 5. Route smoke tests
For each modified page or API route in the changed files:
- GET the corresponding staging URL
- Expect no 500 response (307 redirect for auth-protected routes is acceptable)

### 6. Promotion
Promotion is NOT done here and NEVER via `git push origin main` — `main` is branch-protected and direct pushes are rejected (403). The `ship-to-prod` skill owns promotion: PR `tst` → `main`, merged via the GitHub MCP `merge_pull_request` as soon as Build & Lint + Secret Scanning are green.

### 7. Escalate only if
- Same failure reproduces 3+ times in a row
- Fix requires a product decision
- Staging returns 502 or consistently times out
