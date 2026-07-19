-- ============================================================================
-- Migration 023: Notification read cursor
-- profiles.activity_seen_at marks when the user last opened their
-- notifications — mb_activity rows for them newer than this are "unread".
-- ============================================================================

alter table profiles
  add column if not exists activity_seen_at timestamptz default now();
