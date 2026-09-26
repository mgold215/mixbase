-- 040: per-mix "Share to feed" opt-out.
--
-- Every upload used to land on the community feed automatically. Uploaders now
-- get a "Share to feed" checkbox (web + iOS), ticked by default. Unticking it
-- stores in_feed = false and getFeed() (src/lib/feed.ts) skips that mix, both
-- as a feed entry and in a project's "older mixes" browser.
--
-- Default true keeps every existing mix exactly where it is today, and any
-- client that doesn't send the field (older app builds) keeps publishing.

alter table public.mb_versions
  add column if not exists in_feed boolean not null default true;
