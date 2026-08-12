-- 030: UGC moderation — content reports + user blocks (App Store Guideline 1.2)
--
-- The community feed is deliberately cross-user (022), which makes it
-- user-generated content in App Review's eyes. Apple requires: a way to
-- report objectionable content, a way to block abusive users, and acting on
-- reports. These tables back POST /api/feed/report and /api/feed/block.
--
-- Both tables are SERVER-ONLY: RLS is enabled with no policies, so the anon
-- and authenticated PostgREST roles are denied by default. All reads/writes go
-- through the API routes with supabaseAdmin, which validate identity from the
-- middleware's X-User-Id and rate-limit.

create table if not exists mb_content_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id) on delete cascade,
  -- Polymorphic on purpose (no FK on content_id): 'version' rows point at
  -- mb_versions (a feed item's audio), 'comment' rows at mb_feed_comments.
  -- Comments are hard-deleted at the report threshold; orphaned report rows
  -- are the audit trail, not a bug.
  content_type text not null check (content_type in ('version', 'comment')),
  content_id uuid not null,
  reason text,
  created_at timestamptz not null default now(),
  unique (reporter_id, content_type, content_id)
);
alter table mb_content_reports enable row level security;
create index if not exists idx_content_reports_content on mb_content_reports(content_type, content_id);

create table if not exists mb_user_blocks (
  id uuid primary key default gen_random_uuid(),
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (blocker_id, blocked_id)
);
alter table mb_user_blocks enable row level security;
create index if not exists idx_user_blocks_blocker on mb_user_blocks(blocker_id);
