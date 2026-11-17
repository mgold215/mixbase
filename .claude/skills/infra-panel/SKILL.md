---
name: infra-panel
description: The owner's infrastructure control panel - the admin-only /api/infra routes that read Railway, Supabase, GitHub and Sentry, its Claude chat with a read-only SQL tool, its confirmation-gated actions, and the MixbaseInfra macOS client. Use before changing anything under src/lib/infra/ or /api/infra/, adding a panel action, or touching the chat's SQL guard.
---

# Infra control panel

Admin-only. `/api/infra/*` (and `/admin`, `/api/admin/*`) pass through `withAdminCheck` → `assertAdmin` in `src/proxy.ts`. Code in `src/lib/infra/`.

| Route | What it does |
|---|---|
| `GET /api/infra/{topology,railway,supabase,github,sentry}` | Read-only views |
| `POST /api/infra/chat` | Claude tool-loop over those views, plus a `run_readonly_sql` tool |
| `POST /api/infra/actions` | Railway restart/redeploy and CI re-run |

## Rules to keep

- **Read endpoints never 500 on a missing token.** They answer `configured: false`, so the panel still draws.
- **Actions are reversible only, and each needs a confirmation.** Don't add one that deletes, scales or changes configuration.
- **The chat's SQL runs with a role that bypasses RLS and has no confirmation step.** `src/lib/infra/sql-guard.ts` is the only thing between the model and a side effect, and the chat feeds untrusted text (Sentry titles, Railway errors, database rows) back to the model. Any new escape it should refuse gets a case in `scripts/infra-sql-guard-test.mjs`. The guard is a blocklist, not a sandbox: the real fix is a database role with only SELECT grants.
- Default project ids in `src/lib/infra/railway.ts` come from AGENTS.md → Environments and can be overridden by environment variables.

## The macOS client

Scheme `MixbaseInfra` in `macos/project.yml`. Build with `cd macos && ./build.sh` (see the `ios-build-deploy` skill).

## Checking a change

- `scripts/infra-sql-guard-test.mjs` (in `npm test`).
- `node scripts/test-infra.mjs <base-url> <admin-email> <admin-password>` signs in as an admin and walks every route against a deployed instance. It needs a network path to that instance, which a remote session does not have.
