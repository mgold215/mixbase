---
name: promote-to-main
description: Promote tst branch to main after staging tests pass. Fast-forward only — never force.
---

# Skill: promote-to-main

Promotes `tst` to `main` after staging tests pass. Use only after the post-deploy test loop reports green.

## Steps

1. Confirm current branch is `tst`:
   ```
   git branch --show-current
   ```
   If not on `tst`, stop and report which branch you're on.

2. Run the fast-forward merge and push:
   ```
   git checkout main
   git merge --ff-only tst
   git push origin main
   git checkout tst
   ```

3. If `--ff-only` fails (branches have diverged): **do NOT force it**.
   Report: "Fast-forward failed — tst and main have diverged. Manual intervention needed."

4. Report: "Promoted to main. Railway production deploy triggered."

## What NOT to do
- Never `git push --force` or `git push --force-with-lease`
- Never `git merge` without `--ff-only`
- Never push directly to `main` without staging green
- Never leave the working directory on `main` after promoting
