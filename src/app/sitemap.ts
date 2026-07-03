import type { MetadataRoute } from 'next'
import { SITE_URL, PUBLIC_MARKETING_PATHS } from '@/lib/site'

// Served at /sitemap.xml (Next.js file convention). Lists ONLY the public
// marketing/legal pages — the app and private /share/ links are deliberately
// absent (and disallowed in robots.ts). Reachable without auth via the
// allow-list in src/proxy.ts.
export default function sitemap(): MetadataRoute.Sitemap {
  // Per-path relative priority: the landing page is the entry point, signup
  // matters for acquisition, legal pages are low-priority but worth indexing.
  const priority: Record<string, number> = {
    '/': 1,
    '/signup': 0.7,
    '/login': 0.3,
    '/privacy': 0.2,
    '/terms': 0.2,
    '/support': 0.3,
    '/dmca': 0.1,
  }

  return PUBLIC_MARKETING_PATHS.map(path => ({
    url: `${SITE_URL}${path === '/' ? '' : path}`,
    changeFrequency: path === '/' ? 'weekly' : 'monthly',
    priority: priority[path] ?? 0.5,
  }))
}
