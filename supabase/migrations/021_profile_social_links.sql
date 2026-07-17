-- Migration 021: artist social links on profiles.
-- The curator-submission portal auto-includes the artist's Spotify + YouTube
-- links in every pitch. These optional columns cache the artist's exact profile
-- URLs when they set them; when null, the portal falls back to a keyless
-- name-search link derived from artist_name (see src/lib/social-links.ts).

alter table public.profiles
  add column if not exists spotify_url text,
  add column if not exists youtube_url text;
