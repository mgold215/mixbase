---
name: staging-test-loop
description: Run the post-deploy test loop against staging. Call after every git push origin tst.
---

# Skill: staging-test-loop

Run after every `git push origin tst`. Loops silently until green or escalation threshold. On pass, calls promote-to-main automatically.

## Variables
- Staging URL: `https://mixbase-staging.up.railway.app`
- Production URL: `https://mixbase-production.up.railway.app`

## Steps

### 1. Wait for deploy (max 3 min)
Poll `$STAGING_URL/api/health` every 15 seconds. Expect HTTP 200 with `{"ok":true}`.
On timeout: ESCALATE.

### 2. Smoke test
GET `$STAGING_URL/login` — expect 200 and body contains `mixBase`.
On failure: diagnose → fix → commit to `tst` → `git push origin tst` → restart from Step 1.

### 3. Determine what changed
```
git log -1 --stat --name-only
```

### 4. Conditional upload test
If changed files contain any of: `tus`, `audio`, `upload-url`, `upload-audio`, `upload`:
```
SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY node scripts/test-upload.mjs $STAGING_URL
```
All 4 test groups must pass. On failure: diagnose → fix → commit → push → restart.

### 5. Route smoke tests
For each modified page or API route: GET the staging URL, expect no 500.
(307 auth redirects are acceptable for protected routes.)

### 6. On full PASS
Invoke the `promote-to-main` skill, then report to user.

### 7. Escalate only if
- Same failure 3+ times
- Fix requires product decision
- Staging returns 502 or consistently times out
