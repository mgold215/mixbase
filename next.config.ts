import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const securityHeaders = [
  // Prevent the app being embedded in iframes — stops clickjacking
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  // Stop browsers sniffing MIME types — prevents certain upload-based attacks
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Only send the origin as referrer when navigating to HTTPS — no path leakage
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Disable browser features the app doesn't need
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  // Force HTTPS for 1 year in production (includeSubDomains makes www+bare consistent)
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
  // Basic XSS defence — allow scripts/styles from same origin + Supabase storage
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'", // Next.js requires unsafe-inline/eval for dev
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://mdefkqaawrusoaojstpq.supabase.co https://*.replicate.delivery https://replicate.delivery",
      "media-src 'self' blob: https://mdefkqaawrusoaojstpq.supabase.co",
      "connect-src 'self' https://mdefkqaawrusoaojstpq.supabase.co https://api.replicate.com",
      "font-src 'self'",
      "frame-ancestors 'self'",
    ].join('; '),
  },
]

const nextConfig: NextConfig = {
  // Bundle Futura Bold .ttf into the finalize-artwork route's deploy.
  // Next's tracer doesn't follow dynamic readFileSync(process.cwd()...), so without
  // this the font goes missing on Railway and the route throws at module load.
  outputFileTracingIncludes: {
    '/api/finalize-artwork': ['./src/fonts/**/*.ttf'],
  },

  // Apply security headers to every response
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: securityHeaders,
      },
    ]
  },

  // Allow images from Supabase storage and Replicate
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'mdefkqaawrusoaojstpq.supabase.co' },
      { protocol: 'https', hostname: '*.replicate.delivery' },
      { protocol: 'https', hostname: 'replicate.delivery' },
      { protocol: 'https', hostname: 'pbxt.replicate.delivery' },
    ],
  },
};

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG ?? 'moodmixformat',
  project: process.env.SENTRY_PROJECT ?? 'mixbase',
  authToken: process.env.SENTRY_AUTH_TOKEN,

  // Upload source maps during CI builds only — keeps local builds fast
  silent: !process.env.CI,

  // Route Sentry requests through /monitoring to avoid ad-blockers
  tunnelRoute: '/monitoring',

});
