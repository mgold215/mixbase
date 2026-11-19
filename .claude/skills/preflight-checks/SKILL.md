---
name: preflight-checks
description: The checks that must pass before any commit, push, or telling the owner something is done or fixed in mixBASE - lint, build, the unit suites, which suites cover which area, and what cannot be checked from a remote session. Use every time work is about to be committed, pushed or reported complete, including one-line changes.
---

# Preflight checks

A fix that hasn't been verified is not done. Report it as in progress or broken, never as fixed: the owner ships to production on your word.

## Every push

```bash
npm run lint     # must exit 0
npm run build    # must exit 0
npm test         # every unit suite, about 3 minutes, no network or secrets
```

- CI runs the same lint and build as the required **Build & Lint** check, and the suites as **Renderer Tests**.
- `npm test` needs Node 22 or newer (the suites import the `.ts` sources directly).
- `lint` and `build` collide with each other; `npm test` can run beside either.
- Run them in a clean checkout with `NODE_ENV` unset. Untracked junk in the checkout and `NODE_ENV=production` (which skips devDependencies on install) have each produced thousands of phantom lint errors. If lint reports thousands of errors on code CI says is green, suspect the environment.
- If `npm run build` stops once with a Next.js security notice, run it again: the notice interrupts a single run. Tell the owner what it said.

## While iterating: the suites for the area

Run one with `node scripts/<name>-test.mjs`.

| Area | Suites |
|---|---|
| Auth, keys, admin, input limits | `verify-token` `auth-errors` `supabase-keys` `admin-identity` `admin-client-role` `rate-limit-key` `public-input-caps` `write-route-guards` |
| Uploads, storage keys, playback | `upload-ownership` `uuid-storage-key` `ios-storage-key` `archived-playback` `audio-duration` `duration-backfill` `tracks-duration-heal` `download-default` `asset-url-write-guard` |
| Database, heals, quotas | `db-init-migration-parity` `db-init-rls` `schema-heal-parity` `schema-heal-matcher` `heal-retry` `security-heal-trigger` `profiles-rls` `usage-rpc-grants` `usage-table-rls` `usage-refund` |
| Deleting a project or an account | `project-delete-assets` `project-delete-scope` `delete-account-scope` `delete-account-bound` `survivor-scan-bound` `survivor-scan-routing` |
| Cassette Studio | `cassette-studio` `cassette-art` `cassette-quick` `handwriting-pen` `handwriting-glyphs` `cover-filters` `cassette-motion` `cover-motion` `film-finish` `artwork-history` |
| Artwork, visualizers, video | `artwork-models` `finalize-options` `finalize` `visualizer-source` `effects` `fx` `free-render` `viz-save` `viz-claim-idempotency` `viz-key-shape` `viz-webm-replay` `viz-finalize` `viz-recover` `video-orphan-reaper` `visualizer-transcode` `video` `video-timeout` |
| Share pages | `share-projection` `share-url` `share-target` `share-palette` `share-duration-heal` `waveform-peaks` |
| Mixes, notes, loudness | `mix-check` `intern` `intern-rules` `intern-find` `mix-session` `mix-notes` `mix-status` `loudness` `loudness-compare` `loudness-auto` `bpm` |
| The apps | `ios-parity` `macos-sheet-close` |
| Product rules | `no-paid-plans` |
| Other features | `notification-loop` `release-pipeline` `thumb-drive` `catalog` `release-isrc` `submit-links` `infra-sql-guard` |
| What makes Railway deploy | `deploy-watch` |
| These instruction files | `agent-docs` |

## A new suite

- Unit suites live in `scripts/*-test.mjs`. `tests/` is Playwright end-to-end ONLY: a unit suite dropped there never runs.
- Register it in the `SUITES` array of `scripts/run-renderer-tests.mjs`, and add it to the table above. The runner fails on an unregistered suite, and `agent-docs` fails on one missing from the table.
- When briefing subagents, have them report new test filenames instead of editing the shared array.

## Checks that need a deployed site

| Check | State |
|---|---|
| `node scripts/test-infra.mjs <base-url> <admin-email> <admin-password>` | Works, with an admin login |
| `npm run test:e2e` | Playwright against staging; `BASE_URL=http://localhost:3000` for local |
| `node scripts/test-upload.mjs <base-url>` | Broken: it sends no sign-in, and the upload route requires one |

Staging has had no working deploy since 2026-11-14 (it has no Supabase key), and a remote session cannot reach staging or production over the network, so none of these run there. Use the `debugging-production` skill for what can be checked, and say plainly in the report what was not.

## Before saying "done"

Passing tests are the floor. For any change to a screen the owner uses, follow AGENTS.md → Working with the owner: walk what they do after the first success, on the web AND in the app, and look at the real output.

## Commits

- The pre-commit gitleaks hook scans for secrets. Remove the secret; never `--no-verify`.
- Clear commit messages that say what changed for the person using it.
