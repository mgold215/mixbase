---
name: debugging-production
description: How to find out what actually happened in mixBASE's production from a remote session, and how to test a feature live - the Supabase and Railway MCP tools, which logs answer which question, the health endpoint, why a job can vanish mid-run, and the throwaway-admin method for owner-only features. Use when something is broken or behaving oddly for the owner, when a deploy needs checking, before saying a tool or service is unreachable, and before any live test.
---

# Debugging and testing production

## What a remote session can reach

- The sandbox blocks direct HTTPS to `mixbase.app` and `supabase.co`. MCP tools go through their own relay and still work.
- **Attempt a real tool call before believing a banner.** On 2026-08-13 the Supabase MCP was fully working (`execute_sql`, `query_logs`) while the session-start banner said it needed OAuth and `mcp.supabase.com` failed a curl probe. An outage diagnosis was nearly completed blind because no call was attempted. Report a capability missing only after an actual call has failed.
- Supabase project ref `mdefkqaawrusoaojstpq`. Railway project `9ff29ad4-39cd-45d5-a0e9-5cbd4ffa2227`. Sentry `moodmixformat/mixbase`.

## Start with Supabase

The Supabase tools that read (`execute_sql`, `query_logs`, the `list_` and `get_` tools) are pre-approved in `.claude/settings.json`, so they run without asking the owner. The ones that change the project (`apply_migration`, `deploy_edge_function`, branches, pausing) still ask.

`pg_policies`, `storage.objects` and the logs usually settle "what actually happened" in minutes. Read them before theorizing from code.

| Question | Where to look (Supabase MCP) |
|---|---|
| Did the request reach Supabase, and what did it answer? | `query_logs`, source `edge_logs` |
| Did an upload or download fail, and why? | `query_logs`, source `storage_logs`; then `storage.objects` for what is really stored |
| Did a sign-in or token refresh fail? | `query_logs`, source `auth_logs` |
| Is a policy blocking it? | `select * from pg_policies where tablename = …` |
| Is the row or column really there? | `execute_sql` |

Each `query_logs` call covers a 24-hour window.

## Is the site up?

Fetch the health endpoint from the database, since the sandbox cannot:

```sql
select status, content from extensions.http_get('https://mixbase.app/api/health');
```

A healthy answer is 200 with `{"ok":true,"db":"ok","service_key":true,"admin_power":true,"admin_session_leak":false}`.

- `service_key: false`: the server's Supabase key is missing or wrong. Every protected API call is refused until it is fixed.
- `admin_power: false`: the server is acting as an anonymous user. Reads come back empty instead of failing.
- `admin_session_leak: true`: a user session has attached to the server's admin client. Server-side deletes are refused while reporting success.

## Deploys and server logs

Use the Railway MCP tools (`list-deployments`, `get-logs`, `get-deployment-diagnosis`). `list-services` gives the service and environment ids for production and staging.

- Railway ids: service `c8d681cc-7798-4ee0-b569-5667002ccb5e`; production environment `79a0efb1-e494-4bbf-8ad5-a9009ed1c267`; staging environment `866f14c6-0ed1-450b-9679-9499866c4df4`.
- **Staging deploys fail, and that is expected.** Staging has no `SUPABASE_SERVICE_ROLE_KEY` (removed after the Railway breach), so `/api/health` fails and Railway marks every `tst` deploy FAILED at the health check. It says nothing about the code. A failed staging deploy is not a reason to hold a merge.
- A merge to `main` deploys the web app. While replicas swap, the old deployment still serves; it is finished when the previous deployment reads `REMOVED`.
- Feature code logs with a bracketed prefix, e.g. `[cassette-quick] motion plan by …`. Search the deploy logs for the prefix.

## When something "vanishes" mid-run

- Production is two processes (us-east4 + us-west2). A job kept in one process's memory (a finished-video render, a Cassette Studio run) is unknown to the other, so a status poll answered by the other process sees nothing.
- Every deploy restarts both, and in-process jobs are lost by design.
- Mix Check writes its run state on the database row to avoid this (see the `mix-check` skill). The other jobs do not.
- Rate limits are per process too, and reset on deploy.

## Testing live

- **Say what a paid test will cost and get the owner's yes first** (AGENTS.md → Working with the owner). Image generation, Claude calls and Runway filming all cost money.
- Never start a run while a deploy is still swapping replicas: the job dies with the old process, paid pictures and all.

### Owner-only features without the owner's account

Cassette Studio and Mix Check answer 404 to everyone but the owner. The method used so far (2026-11-10 and 2026-11-17):

1. Create a throwaway user and make it an admin through `ADMIN_USER_IDS` (production reads it at its next deploy).
2. Deploy a temporary Supabase edge function that signs in as that user and calls the routes. Drive it from `execute_sql` with `extensions.http`.
3. Remove all of it afterwards: the user, its songs and files, and empty `ADMIN_USER_IDS`.

The edge function `studio-qa` is left as a 410 stub, because no MCP tool deletes one. A later test can deploy over it.

### What cannot be tested from a remote session

- `scripts/test-upload.mjs` sends no sign-in and has failed with 401 since `/api/tus` became authenticated.
- `npm run test:e2e` (Playwright) targets staging, which the sandbox cannot reach.
- Anything on a real phone. Say so in the report instead of implying it was checked.
