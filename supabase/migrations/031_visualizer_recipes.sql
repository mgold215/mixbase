-- 031: persist the FX-engine recipe that produced a saved visualizer.
--
-- `settings` holds the VizRecipe JSON (see src/lib/fx/types.ts) for clips made
-- by the web FX studio — null for pre-engine rows, AI renders, and finished
-- YouTube/Shorts videos. The server treats it as opaque (size/shape-capped at
-- write time in /api/visualizer routes); only the web engine interprets it,
-- re-validating through validateRecipe() on every read. iOS Codable ignores
-- unknown JSON keys, so shipped app builds are unaffected.
--
-- Deploys can beat migrations to prod: src/lib/schema-heal.ts carries the same
-- idempotent ALTER (ensureVisualizerSettingsColumn) as a runtime heal.

alter table mb_visualizers add column if not exists settings jsonb;
