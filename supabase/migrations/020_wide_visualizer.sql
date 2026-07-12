-- Horizontal (16:9) visualizer pin, alongside the existing vertical pin.
--
-- mb_projects.visualizer_url remains the vertical pin: it loops in the phone
-- player (Spotify-Canvas style) and feeds the "Finalize Short" 9:16 render.
-- visualizer_wide_url is the horizontal pin that feeds the "Finalize
-- Full-Length" 16:9 render, so each finished video is built from a loop in
-- its own orientation instead of center-cropping the other one.
--
-- Also self-heals at runtime via ensureProjectVisualizerColumn (schema-heal.ts)
-- and /api/db-init, same as visualizer_url (migration 015).

alter table mb_projects add column if not exists visualizer_wide_url text;
