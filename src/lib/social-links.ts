// Artist social links for the curator-submission portal.
//
// The pitch a curator receives should carry the artist's Spotify + YouTube.
// Two sources, in priority order:
//   1. An exact profile URL the artist saved in Settings (profiles.spotify_url /
//      youtube_url) — the real channel, used verbatim.
//   2. Otherwise a keyless *name-search* URL derived from artist_name. These
//      always resolve (they never 404) and land the curator on the artist by
//      name — that's the automatic "name detection", requiring no setup and no
//      API keys. The artist can upgrade to their exact profile any time.
//
// Pure + dependency-free so it runs identically on the server (submit page,
// profile API) and the client (Settings auto-fill) and is unit-testable in Node.

export type SocialSource = 'profile' | 'name'
export type SocialLink = { url: string; source: SocialSource }

// True for a syntactically valid http(s) URL — the only shape we store or emit.
export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (!trimmed) return false
  try {
    const u = new URL(trimmed)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

// Keyless search URLs — resolve for any artist name without an API key.
export function spotifySearchUrl(name: string): string {
  return `https://open.spotify.com/search/${encodeURIComponent(name.trim())}/artists`
}
export function youtubeSearchUrl(name: string): string {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(name.trim())}`
}

// Resolve both links from a stored URL (wins) or the artist name (fallback).
// A link is null only when there's neither a valid stored URL nor a name.
export function resolveArtistLinks(input: {
  artistName?: string | null
  spotifyUrl?: string | null
  youtubeUrl?: string | null
}): { spotify: SocialLink | null; youtube: SocialLink | null } {
  const name = (input.artistName ?? '').trim()
  const pick = (stored: string | null | undefined, search: (n: string) => string): SocialLink | null => {
    if (isHttpUrl(stored)) return { url: stored.trim(), source: 'profile' }
    if (name) return { url: search(name), source: 'name' }
    return null
  }
  return {
    spotify: pick(input.spotifyUrl, spotifySearchUrl),
    youtube: pick(input.youtubeUrl, youtubeSearchUrl),
  }
}
