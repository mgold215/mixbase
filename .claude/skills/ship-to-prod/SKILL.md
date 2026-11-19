---
name: ship-to-prod
description: The one way to deploy mixBASE to production - a pull request from tst to main, merged as soon as the two required checks are green. Use every time finished work should go live, when the owner says push, deploy, ship or release, and when a push to main is rejected (403).
---

# Ship to Prod

`main` is production and is server-side branch-protected: `git push origin main` always fails with 403, no matter what. The required vehicle is a PR from `tst` to `main` with the **Build & Lint** and **Secret Scanning** checks green. Merging that PR deploys prod on Railway.

Do NOT babysit staging. The user does not check staging, and merging is not gated on manually verifying it. Once the two required checks are green, merge.

## Steps

### 1. Preflight locally

Run the `preflight-checks` skill (at minimum `npm run lint` and `npm run build` — both must pass). Never push code that fails either.

Gate in a **clean worktree**, never the main checkout, with `NODE_ENV` unset — untracked tool junk in the checkout and an exported `NODE_ENV=production` (strips devDeps on install) have each produced thousands of phantom lint errors (2026-08-19 and 08-20).

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

Use the GitHub MCP tools (in a remote session the `gh` CLI has no usable login):

- `mcp__github__create_pull_request` — owner `mgold215`, repo `mixbase`, head `tst`, base `main`.
- If creation fails because a PR already exists for `tst`, find it with `mcp__github__list_pull_requests` and reuse it — pushing to `tst` already updated it.

### 5. Wait for the two required checks, then merge immediately

Poll the PR's checks (`mcp__github__pull_request_read` / `mcp__github__get_check_run`). When **Build & Lint** and **Secret Scanning** are both green, merge with `mcp__github__merge_pull_request` right away. Do not wait for user confirmation, do not verify staging first — the user has standing instructions to merge on green.

If a check fails: read the logs (`mcp__github__get_job_logs`), fix the cause locally, push to `tst` again, and repeat from step 5.

### 6. Report

Tell the owner what shipped. The merge deploys production (https://mixbase.app) only if it touched something the site is built from (`watchPatterns` in `railway.toml`); say which it was. A change under `ios/` or `macos/` also starts the TestFlight builds. **Check that they finished**: list the runs of `ios-testflight.yml` and `macos-testflight.yml` for the merge commit and read their conclusion. On 2026-11-17 both failed on an Apple-side upload error ("exportArchive Error Downloading App Information") and nobody looked, so the owner's phone showed the old screens for a day while being told the new ones were on their way. A failed upload is retried by the next merge that touches the apps. To confirm the deploy finished and the site is healthy, use the `debugging-production` skill.

## Never

- `git push origin main` — always rejected (403). Don't "try it first".
- Force-push `main`, or force-push `tst` without `--force-with-lease`.
- `--no-verify` to skip the gitleaks hook.
- Fast-forward-merge main locally and push it — the old pre-protection workflow. It no longer works.
- Loop on staging smoke tests before merging — checks green means merge.
