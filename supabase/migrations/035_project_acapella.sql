-- Migration 035: per-project acapella slot
--
-- One pinned acapella (vocals-only) upload per project, stored in mf-audio
-- under <projectId>/acapella-<epochMs>.<ext> — same bucket and prefix shape as
-- mix versions, so /api/upload-url and /api/tus accept the key unchanged and
-- project-delete's prefix sweep already covers the bytes.
--
-- Owner-private: NOT added to any public projection (share pages, /api/tracks,
-- feed). Registered in ASSET_URL_COLUMNS so both delete paths see the
-- reference (src/lib/project-assets.ts).
--
-- Idempotent; also carried by /api/db-init and self-healed by
-- ensureProjectAcapellaColumn in src/lib/schema-heal.ts, since Railway deploys
-- code on merge while migrations are applied by hand.

alter table mb_projects add column if not exists acapella_url text;
