import type { MetadataRoute } from 'next'
import { SITE_URL } from '@/lib/site'

// Served at /robots.txt (Next.js file convention). Must be reachable without
// auth — /robots.txt and /sitemap.xml are allow-listed in src/proxy.ts, or the
// middleware would redirect crawlers to /login and the site would look
// un-indexable.
//
// Policy: let search engines crawl the public marketing + legal pages, but
// keep the entire signed-in app, the API, and — importantly — private
// /share/ feedback-token links out of the index. Those tokens are the only
// thing protecting a private mix, so they must never end up in search results.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: [
        '/api/',
        '/dashboard',
        '/projects',
        '/collections',
        '/media',
        '/pipeline',
        '/player',
        '/profile',
        '/submit',
        '/share/', // private token links — never index
        '/album/', // canonical album share links — same privacy rules
      ],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  }
}
