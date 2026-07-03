// Canonical production origin for SEO / social metadata, robots, and sitemap.
//
// This is ALWAYS the production domain — never the staging URL — so that
// share-preview cards (OpenGraph/Twitter), canonical URLs, robots.txt and
// sitemap.xml all point at the real public site regardless of which
// environment happens to render them. Single source of truth so the landing
// page metadata, robots route and sitemap route can never drift apart.
export const SITE_URL = 'https://mixbase.app'

// The public, crawlable marketing/legal pages. Everything else (the app,
// the API, and private /share/ token links) is deliberately excluded from
// the sitemap and disallowed in robots.txt. Kept here so robots.ts and
// sitemap.ts stay in agreement.
export const PUBLIC_MARKETING_PATHS = [
  '/',
  '/signup',
  '/login',
  '/privacy',
  '/terms',
  '/support',
  '/dmca',
] as const
