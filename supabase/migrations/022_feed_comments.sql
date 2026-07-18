-- ============================================================================
-- Migration 022: Feed comments
-- Inter-artist comments on the public upload feed. Unlike mb_feedback (anonymous
-- share-page feedback), every feed comment is attributed to a signed-in user.
-- ============================================================================

create table if not exists mb_feed_comments (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references mb_versions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  comment text not null,
  created_at timestamptz default now()
);

create index if not exists idx_feed_comments_version_id on mb_feed_comments(version_id);
create index if not exists idx_feed_comments_created on mb_feed_comments(created_at desc);

alter table mb_feed_comments enable row level security;

-- The feed is visible to every signed-in artist, so comments are too.
-- (Server routes use the service-role key and bypass RLS; these policies cover
-- the iOS app, which talks to PostgREST directly with the user's JWT.)
create policy "feed_comments_read_authenticated" on mb_feed_comments
  for select using (auth.uid() is not null);

create policy "feed_comments_insert_own" on mb_feed_comments
  for insert with check (user_id = auth.uid());

create policy "feed_comments_delete_own" on mb_feed_comments
  for delete using (user_id = auth.uid());
