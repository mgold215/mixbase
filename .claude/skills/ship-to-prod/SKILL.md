---
name: ship-to-prod
description: The one correct way to deploy mixbase to production. Use this EVERY time finished work needs to go live — the user says "push", "deploy", "ship", "push to main", "release", or a code change is complete and should reach prod. Direct pushes to main are rejected by branch protection (HTTP 403); this PR-based path is the only vehicle that lands on main.
---

# Ship to Prod

`main` is production and is server-side branch-protected: `git push origin main` always fails with 403, no matter what. The required vehicle is a PR from `tst` to `main` with the **Build & Lint** and **Secret Scanning** checks green. Merging that PR deploys prod on Railway.

Do NOT babysit staging. The user does not check staging, and merging is not gated on manually verifying it. Once the two required checks are green, merge.

## Steps

### 1. Preflight locally

Run the `preflight-checks` skill (at minimum `npm run lint` and `npm run build` — both must pass). Never push code that fails either.

### 2. Get the work onto `tst`

```bash
git fetch origin main tst
git checkout tst 2>/dev/null || git checkout -b tst origin/tst
git merge origin/main        # tst must contain everything on main
# ...apply/commit your changes here with a clear message...
```

The pre-commit gitleaks hook scans for secrets. If it flags something, fix the leak — never bypass with `--no-verify`.

### 3. Push `tst`

```bash
git push -u origin tst       # --force-with-lease ONLY if you rebased tst
```

On network failure, retry up to 4 times with backoff (2s, 4s, 8s, 16s).

### 4. Open the PR `tst` → `main`

Use the GitHub MCP tools (there is no `gh` CLI in remote sessions):

- `mcp__github__create_pull_request` — owner `mgold215`, repo `mixbase`, head `tst`, base `main`.
- If creation fails because a PR already exists for `tst`, find it with `mcp__github__list_pull_requests` and reuse it — pushing to `tst` already updated it.

### 5. Wait for the two required checks, then merge immediately

Poll the PR's checks (`mcp__github__pull_request_read` / `mcp__github__get_check_run`). When **Build & Lint** and **Secret Scanning** are both green, merge with `mcp__github__merge_pull_request` right away. Do not wait for user confirmation, do not verify staging first — the user has standing instructions to merge on green.

If a check fails: read the logs (`mcp__github__get_job_logs`), fix the cause locally, push to `tst` again, and repeat from step 5.

### 6. Report

Tell the user what shipped and that the merge triggered the production deploy (https://mixbase.app).

## Never

- `git push origin main` — always rejected (403). Don't "try it first".
- Force-push `main`, or force-push `tst` without `--force-with-lease`.
- `--no-verify` to skip the gitleaks hook.
- Fast-forward-merge main locally and push it — the old pre-protection workflow. It no longer works.
- Loop on staging smoke tests before merging — checks green means merge.
