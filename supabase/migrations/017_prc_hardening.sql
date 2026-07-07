-- 017_prc_hardening.sql
-- Security + robustness hardening surfaced by the 2026-07-06 production-readiness QA.
-- All changes are additive or tightening; none loosen access.

-- ── mb_visualizers: add owner-scoped RLS policies ──────────────────────────────
-- The table had RLS enabled with ZERO policies (deny-all for everyone except the
-- service-role bypass). That made the feature depend entirely on a valid
-- service-role key — the moment the server's admin client degraded to anon, an
-- insert failed with "violates row-level security policy" and visualizers could
-- not be saved. Give owners direct access to their own rows (the correct RLS
-- design, and it lets the native iOS app read them via PostgREST too). auth.uid()
-- is wrapped in a subselect per Supabase's initplan performance guidance.
DROP POLICY IF EXISTS "viz_owner_select" ON mb_visualizers;
CREATE POLICY "viz_owner_select" ON mb_visualizers
  FOR SELECT USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "viz_owner_insert" ON mb_visualizers;
CREATE POLICY "viz_owner_insert" ON mb_visualizers
  FOR INSERT WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "viz_owner_update" ON mb_visualizers;
CREATE POLICY "viz_owner_update" ON mb_visualizers
  FOR UPDATE USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "viz_owner_delete" ON mb_visualizers;
CREATE POLICY "viz_owner_delete" ON mb_visualizers
  FOR DELETE USING (user_id = (SELECT auth.uid()));

-- ── mb_feedback: scope anonymous inserts to real versions ──────────────────────
-- The public insert policy was WITH CHECK (true) — anyone could insert feedback
-- rows for any (or a non-existent) version_id. Restrict anonymous submissions to
-- version_ids that actually exist so the share-page form can't be used to inject
-- orphan/junk rows.
DROP POLICY IF EXISTS "public_feedback_insert" ON mb_feedback;
CREATE POLICY "public_feedback_insert" ON mb_feedback
  FOR INSERT WITH CHECK (
    version_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM mb_versions v WHERE v.id = version_id)
  );

-- ── Usage-counter RPCs: only the service-role may call them ─────────────────────
-- increment_artwork_usage / increment_video_usage are SECURITY DEFINER and were
-- callable by anon/authenticated via /rest/v1/rpc, letting a client inflate any
-- user's monthly quota. The server calls them with the service-role key, so lock
-- execution down to that role.
REVOKE EXECUTE ON FUNCTION public.increment_artwork_usage(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.increment_video_usage(uuid, text)   FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_artwork_usage(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.increment_video_usage(uuid, text)   TO service_role;

-- ── Missing foreign-key indexes (query performance at scale) ───────────────────
CREATE INDEX IF NOT EXISTS idx_mb_collection_items_collection_id ON mb_collection_items (collection_id);
CREATE INDEX IF NOT EXISTS idx_mb_collection_items_project_id    ON mb_collection_items (project_id);
CREATE INDEX IF NOT EXISTS idx_mb_releases_final_version_id      ON mb_releases (final_version_id);
CREATE INDEX IF NOT EXISTS idx_mb_visualizers_project_id         ON mb_visualizers (project_id);
CREATE INDEX IF NOT EXISTS idx_sb_curators_user_id               ON sb_curators (user_id);
CREATE INDEX IF NOT EXISTS idx_sb_submissions_version_id         ON sb_submissions (version_id);
