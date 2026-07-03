-- Final videos (YouTube + Shorts renders from the video finalizer).
--
-- No new tables: finished videos are mb_visualizers rows with kind
-- 'youtube' | 'shorts' (kind is free text), stored in the existing mf-video
-- bucket — so they surface in the Media library like every other render.
--
-- The only schema change needed is the bucket ceiling: mf-video was created at
-- 50 MB for short loops, but a full-song 1080p H.264 render runs to hundreds
-- of MB. 500 MB comfortably covers the renderer's own cap (12-minute songs at
-- maxrate 4 Mbps ≈ 380 MB).
--
-- MUST be direct SQL: the Storage API (updateBucket) clamps to the project's
-- global upload limit and silently downgrades — same gotcha as mf-audio's 2 GB.
-- Runtime self-heal in src/lib/schema-heal.ts (ensureVideoBucketLimit) runs
-- this same statement before large uploads in case a deploy beats the migration.

update storage.buckets
set file_size_limit = 524288000
where id = 'mf-video'
  and (file_size_limit is null or file_size_limit < 524288000);
