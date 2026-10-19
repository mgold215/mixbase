-- 041: Mix Session — tick a note off.
--
-- Mix notes and listener feedback (mb_feedback) had no state: a note was just
-- text and a timestamp, so "what do I still have to fix?" could only be answered
-- by re-reading everything. The Mix Session (web /session + the app's Mix
-- Session screen, both via /api/mix-session) lists the open notes on each song's
-- current mix and lets the artist tick them off. resolved_at is that tick:
-- NULL = still open, a timestamp = done (and when).
--
-- Nullable with no default, so every existing note starts open — exactly what
-- they are today. Written only by PATCH /api/mix-session/notes/[id] (service
-- role, ownership checked); no policy change. Healed at runtime by
-- ensureFeedbackResolvedColumn (src/lib/schema-heal.ts), so a deploy that beats
-- this migration still works.

alter table public.mb_feedback
  add column if not exists resolved_at timestamptz;
