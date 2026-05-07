-- Split source artwork from finalized output.
--
-- Previously /api/finalize-artwork overwrote mb_projects.artwork_url with the
-- rendered output. Re-clicking "Finalize Artwork" then re-rendered text on top
-- of the prior render — the old text was permanently baked into the bitmap and
-- could never be cleared.
--
-- After this change:
--   * artwork_url            — immutable source (last Generate or Upload result)
--   * finalized_artwork_url  — rendered output of the most recent Finalize pass
--
-- /api/finalize-artwork reads the source from artwork_url and writes its output
-- to finalized_artwork_url. Generate/Upload write to artwork_url and null out
-- finalized_artwork_url so the next Finalize starts clean.

alter table mb_projects
  add column if not exists finalized_artwork_url text;
