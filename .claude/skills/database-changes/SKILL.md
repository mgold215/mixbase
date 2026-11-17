---
name: database-changes
description: How a schema or policy change reaches mixBASE's production database, and the rules its tables follow - numbered migrations, the /api/db-init bootstrap, runtime self-heals for new columns, row-level security, the usage RPCs, and the two migrations that must not be applied. Use before adding or changing a table, column, policy, index or SQL function, before applying anything to Supabase, and when a query fails on a missing column or returns nothing it should.
---

# Database changes

Supabase project `mdefkqaawrusoaojstpq`. Migration files are in `supabase/migrations/`, numbered in order.

## A deploy does not run migrations

Railway deploys new code the moment a PR merges. Nothing applies the migration files. A change is live in production only when:

- someone applies it (the Supabase MCP tool `apply_migration`, or `execute_sql`), or
- for an added column, the runtime self-heal adds it the first time a query fails on it.

Policies, constraints, indexes and functions are never healed. They are live only once applied.

## Adding a change

1. **Write the migration**: the next number in `supabase/migrations/`, every statement idempotent (`if not exists`).
2. **Account for it in the bootstrap.** `/api/db-init` carries its own copy of the schema (`SCHEMA_SQL`). `scripts/db-init-migration-parity-test.mjs` fails until the new migration is either folded into that copy or listed in the test's `EXCLUDED` with a reason.
3. **A new column needs a heal.** PostgREST rejects the WHOLE query when one referenced column is missing, so code that deploys before its column breaks every read of that table. Add an `ensure…Column()` to `src/lib/schema-heal.ts`, call it where the query fails on the missing column, and retry once. `scripts/schema-heal-parity-test.mjs` enforces it.
4. **Never read a failed query as an empty one.** Check `.error` before using `.data ?? default`. A silent zero looks like "no news" and nobody reports it.
5. **A new table** takes the `mb_` prefix, a `user_id` column and owner-only RLS, in the migration AND in `SCHEMA_SQL` (`scripts/db-init-rls-test.mjs`). A table created without RLS is readable and writable by anyone holding the public key.
6. **Apply it to production** before merging the code that needs it (the heal covers a column if the deploy wins the race anyway), then check it took: `select … from pg_policies`, `information_schema.columns`, or the Supabase MCP tool `list_migrations`.

## Before applying anything that is not purely additive

Dropping or tightening a policy, changing a constraint, rewriting rows:

- Rehearse it first on throwaway objects or a Supabase branch, with a real signed-in user, old rules beside new. Migration 044's header shows the method.
- Get the owner's go-ahead. Migrations 028 and 038 are what reasoning without a rehearsal produced.

## Do not apply

| Migration | Why |
|---|---|
| `028_storage_no_listing.sql` | **Never.** The same change caused a production outage on 2026-07-11 (uploads broke) and was rolled back the next day. Superseded by 044 |
| `038_storage_scope_uploads_to_owner.sql` | **Not yet.** It would break every upload from the app. The file is all comments; they hold the policy text, what must ship first, and that it needs the owner's go-ahead |

Details of both: the `uploads-and-audio` skill. If the owner asks for one of them to be applied, explain what would break before doing anything.

## What production has

Production's own migration table uses its own names and timestamps, not the file numbers, and several files were applied by hand or by a heal without being recorded there. So the file list is not proof of what is live. Check the real object (`pg_policies`, `information_schema`, `pg_proc`) when it matters.

## Row-level security

- Owner-only RLS on every app table (migration 005). The server uses `supabaseAdmin`, which bypasses RLS.
- **Not every table has a `user_id` column** (verified 2026-08-30). `mb_versions`, `mb_feedback` and `mb_collection_items` have none, and `profiles` keys on `id`. They scope through their parent, e.g. `mb_versions.users_own_versions` = `project_id in (select id from mb_projects where user_id = auth.uid())`. Check the actual columns before writing a policy or a filter against one of them.
- **`mb_feed_comments` is cross-user on purpose** (migration 022): any signed-in user reads all rows and inserts or deletes only their own. The community feed (`/feed`, `GET /api/feed`) shows every artist's uploads and comments to every signed-in artist, served through `supabaseAdmin`. Don't "fix" it to owner-only.

## Things the schema won't tell you

- `profiles` still carries legacy Stripe/Apple columns (`stripe_customer_id`, `stripe_subscription_id`, `apple_original_transaction_id`). Nothing uses them; there are no paid plans.
- `mb_usage` holds each user's monthly artwork/video counts, keyed `YYYY-MM`. It cannot see the owner's activity: the owner skips the quota.
- `mb_library_tracks` is the released-track library (ISRC/UPC/dates synced from Spotify/Deezer, migration 027).
- `sb_curators` / `sb_submissions` belong to the submit pages (`/api/sb-curators/*`).
- The same project holds `trading_*` tables that belong to a separate trading bot. Leave them alone.

## The usage RPCs

`increment_artwork_usage(p_user_id, p_month)` and `increment_video_usage(p_user_id, p_month)` are atomic on purpose and callable only by the service role. On any failure after a slot is reserved, refund it for the same month it was reserved in (`src/lib/tier.ts`).

## Checking a change

In `npm test`: `db-init-migration-parity`, `db-init-rls`, `schema-heal-parity`, `schema-heal-matcher`, `heal-retry`, `security-heal-trigger`, `usage-rpc-grants`, `usage-table-rls`, `usage-refund`, `profiles-rls` (each is `scripts/<name>-test.mjs`). They read the source; none of them touches a database.
