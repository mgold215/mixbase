-- 039: drop seven tables that were never used.
--
-- ⚠️ WRITTEN BUT NOT APPLIED. Apply/verify/rollback steps are at the bottom.
--
-- WHAT THESE ARE
-- Seven tables from an earlier, wider product idea (press kits, social
-- scheduling, curator submissions, collaboration requests, a producer
-- directory, and Spotify link/stat tracking). None of it was built. They have
-- carried zero rows since they were created and nothing in the codebase reads
-- or writes them.
--
-- VERIFIED TWICE, INDEPENDENTLY, BEFORE WRITING THIS FILE (2026-08-31):
--   1. Row counts — all seven are empty in production. Re-checked against
--      pg_stat_user_tables and by direct count.
--   2. References — a full-repo grep across src/, ios/, macos/, scripts/,
--      supabase/ and .github/ finds NO runtime reader or writer for any of
--      them. The only hits are prose: a comment in delete-account/route.ts,
--      migration 006's RLS setup, and docs. `mb_producers` has literally no
--      reference anywhere in the repo.
-- Neither check alone is sufficient: an empty table with a reader is a feature
-- nobody has used yet, and a referenced-but-empty table would break on drop.
-- Both had to come back clean, and both did.
--
-- ORDER MATTERS — mb_spotify_stats FIRST
-- mb_spotify_stats.spotify_link_id carries the only inbound foreign key in the
-- set (mb_spotify_stats_spotify_link_id_fkey -> mb_spotify_links). Dropping
-- mb_spotify_links first fails on the dependency. The order below is the
-- dependency order, which is why this file does not use `cascade`: an explicit
-- order fails loudly if the shape ever changes, where `cascade` would silently
-- take whatever else had come to depend on these.
--
-- ⚠️ ONE-WAY DOOR FOR MIGRATION 006 — read before applying
-- None of these seven was created by any migration in this repo; they are
-- untracked schema from before the ledger existed. Migration 006 then does
-- UNGUARDED `alter table <t> enable row level security` (lines 63-67) and
-- `create policy` on five of them. So after this runs, REPLAYING 006 FROM
-- SCRATCH WILL ERROR on the first missing table. That does not affect this
-- database (006 is long applied) but it does mean 006 can no longer rebuild an
-- empty project as-is. That is a deliberate, accepted trade: the alternative is
-- carrying seven dead tables forever to keep a replay path nobody uses. If a
-- from-scratch rebuild is ever needed, guard those five statements in 006 with
-- a to_regclass() check rather than reverting this.
--
-- WHY BOTHER AT ALL
-- They are not costing money. They are costing clarity: every schema listing,
-- every advisor run and every "what tables do we have" question has to route
-- around seven tables that mean nothing, and migration 006's policies on them
-- add evaluation weight for zero benefit.

drop table if exists mb_spotify_stats;
drop table if exists mb_spotify_links;
drop table if exists mb_press_kits;
drop table if exists mb_social_posts;
drop table if exists mb_curator_submissions;
drop table if exists mb_collab_requests;
drop table if exists mb_producers;

-- PostgREST caches the schema; nudge it so the dropped tables stop being
-- advertised on the REST surface immediately rather than at the next reload.
notify pgrst, 'reload schema';

-- APPLY: run this file as-is in the Supabase SQL editor.
--
-- PRE-CHECK (expect seven rows, every count 0 — do NOT apply if any is > 0):
--   select c.relname,
--          (select n_live_tup from pg_stat_user_tables s where s.relname = c.relname) as rows
--   from pg_class c join pg_namespace n on n.oid = c.relnamespace
--   where n.nspname = 'public' and c.relkind = 'r'
--     and c.relname in ('mb_press_kits','mb_social_posts','mb_curator_submissions',
--                       'mb_collab_requests','mb_producers','mb_spotify_links','mb_spotify_stats')
--   order by c.relname;
--
-- VERIFY (expect zero rows):
--   select table_name from information_schema.tables
--   where table_schema = 'public'
--     and table_name in ('mb_press_kits','mb_social_posts','mb_curator_submissions',
--                        'mb_collab_requests','mb_producers','mb_spotify_links','mb_spotify_stats');
--
-- SMOKE TEST: none needed for the app — nothing reads these. Confirm the app
-- still loads (/, /feed, /pipeline) and that `select 1` style advisor runs are
-- clean. The meaningful check is the VERIFY above.
--
-- ROLLBACK: there is none, and none is needed — the tables are empty, so
-- nothing is lost. If the product ever wants any of these features, write a
-- fresh migration with the schema that feature actually needs rather than
-- restoring a guess made before it was designed.
