-- Adds streaming platform link columns to mb_releases for the public release link page (/r/[id])
ALTER TABLE mb_releases
  ADD COLUMN IF NOT EXISTS spotify_url      text,
  ADD COLUMN IF NOT EXISTS apple_music_url  text,
  ADD COLUMN IF NOT EXISTS youtube_url      text,
  ADD COLUMN IF NOT EXISTS soundcloud_url   text,
  ADD COLUMN IF NOT EXISTS tidal_url        text,
  ADD COLUMN IF NOT EXISTS amazon_music_url text,
  ADD COLUMN IF NOT EXISTS bandcamp_url     text;
