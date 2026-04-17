# Post-Deploy Test Agent

Run after every `git push origin tst`. Do not contact the user between iterations — loop silently until green or escalation threshold.

## Steps

### 1. Wait for staging deploy (max 3 min)
Poll `https://mixbase-staging.up.railway.app/api/health` every 15 seconds.
Expect HTTP 200 with body `{"ok":true}`.
On timeout: ESCALATE — "staging deploy did not come up after 3 minutes".

### 2. Verify app loads
GET `https://mixbase-staging.up.railway.app/login` — expect 200 and HTML contains `mixBase`.
On failure: diagnose → fix → commit to `tst` → `git push origin tst` → restart from Step 1.

### 3. Check what changed
```
git log -1 --stat --name-only
```

### 4. Conditional upload/audio test
If changed files include any of: `tus`, `audio`, `upload-url`, `upload-audio`, `upload`:
```
SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY node scripts/test-upload.mjs https://mixbase-staging.up.railway.app
```
All test groups must pass (TUS session creation, chunk upload, storage size verification, audio proxy Range requests).
On failure: diagnose → fix → commit → push → restart from Step 1.

### 5. Route smoke tests
For each modified page or API route in the changed files:
- GET the corresponding staging URL
- Expect no 500 response (307 redirect for auth-protected routes is acceptable)

### 6. On full PASS
```
git checkout main && git merge --ff-only tst && git push origin main && git checkout tst
```
Report to user: "Staging green — promoted to main. Production deploy in progress."

### 7. Escalate only if
- Same failure reproduces 3+ times in a row
- Fix requires a product decision
- Staging returns 502 or consistently times out
