import { SITE_URL } from './site.ts'

// Builders for the URLs users actually copy and send. ALWAYS anchored to the
// canonical production domain — window.location.origin leaks whatever host the
// app happens to be running on (mixbase-production.up.railway.app, staging,
// a PWA installed from the Railway URL), and nobody should ever paste a
// "railway" link into a group chat.

// URL-safe slug for display segments (artist name, collection title). These
// segments are cosmetic — the share token at the end of the path is the only
// thing the server looks up — so a lossy slug is fine.
export function slugify(input: string | null | undefined, fallback: string): string {
  const slug = (input ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics: Beyoncé → beyonce
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
  return slug || fallback
}

// Public album/collection player: mixbase.app/album/<artist>/<title>/<key>
export function albumShareUrl(
  artistName: string | null | undefined,
  title: string | null | undefined,
  token: string,
): string {
  return `${SITE_URL}/album/${slugify(artistName, 'artist')}/${slugify(title, 'untitled')}/${token}`
}

// Public single-track player: mixbase.app/listen/<artist>/<title>/<token>
//
// The artist and title segments are what people SEE when the link lands in a
// chat, so callers pass them whenever they have them. Without them the link
// is the bare mixbase.app/share/<token> form, which the server upgrades to the
// pretty address in place (a permanent redirect) — every link ever sent in that
// form keeps working the same way.
export function trackShareUrl(
  token: string,
  display?: { artistName?: string | null; title?: string | null },
): string {
  if (!display || (!display.artistName && !display.title)) return `${SITE_URL}/share/${token}`
  return `${SITE_URL}/listen/${slugify(display.artistName, 'artist')}/${slugify(display.title, 'untitled')}/${token}`
}
