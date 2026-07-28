// src/lib/display-name.ts
// The one place that turns a profiles row into a name we are willing to show
// to somebody who is not that user.
//
// Why this exists: `profiles.display_name` DEFAULTS TO THE SIGNUP EMAIL.
// `handle_new_user` (supabase/migrations/006_multi_user_auth.sql:203-209) inserts
//   coalesce(new.raw_user_meta_data->>'full_name', new.email)
// and the signup route never sets `full_name` (src/app/api/auth/signup/route.ts),
// so for every account created through the app `display_name` IS the address.
// `artist_name` is OPTIONAL at signup (the input has no `required` —
// src/app/signup/page.tsx), so it is frequently null.
//
// That makes the naive `artist_name || display_name || fallback` chain an email
// leak on any surface a stranger can see. Route every such name through here.
//
// Pure + dependency-free ON PURPOSE: this module must be importable by a bare
// `node scripts/*.mjs` contract test, so it may never import supabaseAdmin.
// (src/lib/feed.ts re-exports it for the existing callers.)

/**
 * Public display name for a profile.
 *
 * Never falls back to `display_name` when it looks like an email address.
 * An artist who set no `artist_name` gets the caller's neutral fallback
 * instead of having their address published.
 *
 * @param fallback shown when there is no safe name — 'Artist' in the community
 *   feed, 'mixBASE' on share pages (which read as the brand, not a person).
 */
export function publicArtistName(
  p?: { artist_name?: string | null; display_name?: string | null } | null,
  fallback = 'Artist',
): string {
  if (p?.artist_name?.trim()) return p.artist_name.trim()
  const dn = p?.display_name?.trim()
  if (dn && !dn.includes('@')) return dn
  return fallback
}
