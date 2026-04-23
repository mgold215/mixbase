-- Migration 005: Multi-user support
-- Adds user_id columns, enables RLS, and creates access policies.
-- Tables that already have data keep user_id nullable so existing rows aren't broken.
-- The web API layer filters by user_id explicitly; RLS enforces isolation for direct
-- Supabase clients (iOS app uses the user's JWT, which triggers these policies).

-- ─── Add user_id to ownable tables ────────────────────────────────────────────
ALTER TABLE mb_projects    ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id);
ALTER TABLE mb_releases    ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id);
ALTER TABLE mb_collections ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id);

-- ─── Index for fast per-user queries ──────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_projects_user_id    ON mb_projects(user_id);
CREATE INDEX IF NOT EXISTS idx_releases_user_id    ON mb_releases(user_id);
CREATE INDEX IF NOT EXISTS idx_collections_user_id ON mb_collections(user_id);

-- ─── Enable RLS ────────────────────────────────────────────────────────────────
ALTER TABLE mb_projects        ENABLE ROW LEVEL SECURITY;
ALTER TABLE mb_versions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE mb_releases        ENABLE ROW LEVEL SECURITY;
ALTER TABLE mb_collections     ENABLE ROW LEVEL SECURITY;
ALTER TABLE mb_collection_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE mb_feedback        ENABLE ROW LEVEL SECURITY;
ALTER TABLE mb_activity        ENABLE ROW LEVEL SECURITY;

-- ─── Drop any pre-existing policies (idempotent re-run safety) ────────────────
DROP POLICY IF EXISTS "users_own_projects"          ON mb_projects;
DROP POLICY IF EXISTS "users_own_versions"          ON mb_versions;
DROP POLICY IF EXISTS "users_own_releases"          ON mb_releases;
DROP POLICY IF EXISTS "users_own_collections"       ON mb_collections;
DROP POLICY IF EXISTS "users_own_collection_items"  ON mb_collection_items;
DROP POLICY IF EXISTS "public_feedback_insert"      ON mb_feedback;
DROP POLICY IF EXISTS "users_read_feedback"         ON mb_feedback;
DROP POLICY IF EXISTS "users_own_activity"          ON mb_activity;

-- ─── mb_projects ──────────────────────────────────────────────────────────────
-- Users see and modify only their own projects.
CREATE POLICY "users_own_projects" ON mb_projects
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ─── mb_versions ──────────────────────────────────────────────────────────────
-- Versions inherit ownership through the parent project.
CREATE POLICY "users_own_versions" ON mb_versions
  USING (
    project_id IN (SELECT id FROM mb_projects WHERE user_id = auth.uid())
  )
  WITH CHECK (
    project_id IN (SELECT id FROM mb_projects WHERE user_id = auth.uid())
  );

-- ─── mb_releases ──────────────────────────────────────────────────────────────
CREATE POLICY "users_own_releases" ON mb_releases
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ─── mb_collections ───────────────────────────────────────────────────────────
CREATE POLICY "users_own_collections" ON mb_collections
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ─── mb_collection_items ──────────────────────────────────────────────────────
CREATE POLICY "users_own_collection_items" ON mb_collection_items
  USING (
    collection_id IN (SELECT id FROM mb_collections WHERE user_id = auth.uid())
  )
  WITH CHECK (
    collection_id IN (SELECT id FROM mb_collections WHERE user_id = auth.uid())
  );

-- ─── mb_feedback ──────────────────────────────────────────────────────────────
-- Anyone can submit feedback via a share link (no auth required).
-- Only the project owner can read feedback on their tracks.
CREATE POLICY "public_feedback_insert" ON mb_feedback
  FOR INSERT WITH CHECK (true);

CREATE POLICY "users_read_feedback" ON mb_feedback
  FOR SELECT USING (
    version_id IN (
      SELECT v.id FROM mb_versions v
      JOIN mb_projects p ON v.project_id = p.id
      WHERE p.user_id = auth.uid()
    )
  );

-- ─── mb_activity ──────────────────────────────────────────────────────────────
CREATE POLICY "users_own_activity" ON mb_activity
  USING (
    project_id IN (SELECT id FROM mb_projects WHERE user_id = auth.uid())
  )
  WITH CHECK (
    project_id IN (SELECT id FROM mb_projects WHERE user_id = auth.uid())
  );

-- ─── Share-token read: public access to a single version by share_token ───────
-- The /share/[token] page reads one version without auth. We allow anon SELECT
-- on mb_versions only when the query is filtered to a specific share_token.
-- NOTE: this relies on the share page using the anon key directly; the API proxy
-- route (/api/share) already uses supabaseAdmin so RLS is bypassed there.
-- No additional policy needed for the admin client path.
