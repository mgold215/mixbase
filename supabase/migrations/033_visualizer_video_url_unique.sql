-- 033: one mb_visualizers row per stored mf-video object.
--
-- ⚠️ WRITTEN BUT NOT APPLIED. Apply/verify/rollback steps are at the bottom.
-- Railway deploys the moment a PR merges but migrations here are applied by
-- hand, so the code always lands first. src/lib/visualizer-store.ts is written
-- to be correct BOTH before and after this file runs:
--   * before — indexVisualizer() looks the object up before inserting, which
--     collapses the common repeat claim (first row landed, its response was
--     lost) but cannot stop two claims that are genuinely in flight together;
--   * after  — the loser of that race fails on this index instead of writing a
--     duplicate, and indexVisualizer() re-reads and returns the winner's row.
-- The unique index is therefore the only thing that makes the guarantee total.
--
-- WHY
-- The full-resolution save path PUTs the clip straight to mf-video via a signed
-- URL and then POSTs a small JSON claim to /api/visualizer/finalize; only the
-- claim writes the row. fx/upload.ts retries that claim when its response is
-- lost — deliberately, because retrying a few hundred bytes of JSON beats
-- re-uploading the video, and beats the caller falling back to the legacy
-- multipart save (which stores a second COPY of the bytes). The claim handler
-- did a plain INSERT, so a retried claim could write a SECOND row over the SAME
-- object. The user then sees a duplicate in Media, and deleting either one takes
-- the shared bytes with it — DELETE /api/visualizer/[id] derives its storage key
-- from video_url — leaving the survivor pointing at a 404.
--
-- SHAPE
-- A plain unique index on video_url, not (user_id, video_url): every key is
-- `<projectId>/viz-<stamp>.<ext>` and a project has exactly one owner, so two
-- users can never legitimately hold the same URL. Global uniqueness is the
-- stronger statement and the one that matches reality.
--
-- The de-duplication below is not optional: `create unique index` fails outright
-- if any duplicates already exist. It keeps the OLDEST row per URL (the one a
-- project pin or a share link is most likely to have been built against — pins
-- match on video_url, so either row would serve, but the earliest is the one the
-- user's UI has seen) and deletes the rest. Those deleted rows describe bytes
-- that are NOT deleted: the surviving row still points at the same object, so
-- nothing becomes unreachable and nothing is orphaned.

-- Keep the earliest row per video_url; drop the duplicate claims over it.
with ranked as (
  select id,
         row_number() over (
           partition by video_url
           order by created_at asc nulls last, id asc
         ) as rn
  from mb_visualizers
)
delete from mb_visualizers v
using ranked r
where v.id = r.id
  and r.rn > 1;

create unique index if not exists mb_visualizers_video_url_uidx
  on mb_visualizers (video_url);

-- PostgREST caches the schema; nudge it so the constraint's error surfaces
-- normally on the very first duplicate insert after this runs.
notify pgrst, 'reload schema';

-- APPLY: run this file as-is in the Supabase SQL editor. Re-running is safe —
-- the delete matches nothing once the index exists, and the index is guarded by
-- `if not exists`.
--
-- PRE-CHECK (how many duplicate rows the delete above will remove; expect 0):
--   select video_url, count(*)
--   from mb_visualizers
--   group by video_url
--   having count(*) > 1
--   order by count(*) desc;
--
-- VERIFY (expect exactly one row, indexdef containing "UNIQUE"):
--   select indexname, indexdef
--   from pg_indexes
--   where tablename = 'mb_visualizers'
--     and indexname = 'mb_visualizers_video_url_uidx';
--
-- SMOKE TEST: render a clip in the FX studio and save it. It must appear in
-- Media exactly once. Then, with the browser devtools Network tab set to block
-- the response of POST /api/visualizer/finalize (or simply go offline for a few
-- seconds right after the upload completes), let the client's retry fire: the
-- save must still report success and STILL appear exactly once.
--
-- ROLLBACK (restores the ability to write duplicate rows; does not restore the
-- duplicate rows this migration removed — they were redundant descriptions of
-- objects the surviving rows still point at):
--   drop index if exists mb_visualizers_video_url_uidx;
--   notify pgrst, 'reload schema';
