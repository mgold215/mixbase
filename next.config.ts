import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

// Supabase origin the browser talks to (storage public URLs, direct signed-URL
// PUTs). Derived from the env so CSP follows the project if it is ever
// re-pointed, instead of being hardcoded in three directives.
const SUPABASE_ORIGIN = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://mdefkqaawrusoaojstpq.supabase.co').origin
  } catch {
    return 'https://mdefkqaawrusoaojstpq.supabase.co'
  }
})()

// Next.js needs 'unsafe-eval' for its dev-mode React refresh runtime, but the
// production bundle does not. Keeping it out of prod meaningfully tightens the
// XSS surface. 'unsafe-inline' is still required for Next's inline bootstrap
// scripts and the pre-paint theme script.
const scriptSrc =
  process.env.NODE_ENV === 'production'
    ? "script-src 'self' 'unsafe-inline'"
    : "script-src 'self' 'unsafe-inline' 'unsafe-eval'"

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
      scriptSrc,
      "style-src 'self' 'unsafe-inline'",
      `img-src 'self' data: blob: ${SUPABASE_ORIGIN} https://*.replicate.delivery https://replicate.delivery`,
      `media-src 'self' blob: ${SUPABASE_ORIGIN} https://*.runwayml.com https://*.cloudfront.net https://*.replicate.delivery`,
      // `blob:` is NOT a network destination — it can only address bytes this
      // page itself put in memory, so it adds no exfiltration reach (unlike a
      // CDN wildcard, which anyone can register a bucket on). Needed because
      // 'self' does not cover blob: for connect-src: without it the touch
      // share-sheet path can't read a freshly recorded visualizer.
      `connect-src 'self' blob: ${SUPABASE_ORIGIN} https://api.replicate.com`,
      "font-src 'self'",
      "frame-ancestors 'self'",
    ].join('; '),
  },
]

const nextConfig: NextConfig = {
  // Bundle Futura Bold .ttf into the finalize-artwork route's deploy.
  // Next's tracer doesn't follow dynamic readFileSync(process.cwd()...), so without
  // this the font goes missing on Railway and the route throws at module load.
  // finalize-video additionally needs the ffmpeg/ffprobe binaries traced.
  outputFileTracingIncludes: {
    '/api/finalize-artwork': ['./src/fonts/**/*.ttf'],
    '/api/finalize-video': [
      './src/fonts/**/*.ttf',
      './node_modules/@ffmpeg-installer/**',
      './node_modules/@ffprobe-installer/**',
    ],
  },

  // Keep the ffmpeg binary wrappers unbundled — their exported paths resolve
  // relative to node_modules at runtime and break if the bundler inlines them.
  serverExternalPackages: ['@ffmpeg-installer/ffmpeg', '@ffprobe-installer/ffprobe'],

  // Canonicalize www → apex. Session cookies are host-only, so www.mixbase.app
  // and mixbase.app hold two independent sessions — a user drifting between the
  // hosts (bookmark vs typed URL) sees phantom logouts and double session churn.
  // Redirecting before anything else keeps every session on one host.
  async redirects() {
    return [
      {
        source: '/:path*',
        has: [{ type: 'host', value: 'www.mixbase.app' }],
        destination: 'https://mixbase.app/:path*',
        permanent: true,
      },
      // Same canonicalization for the raw Railway production domain — nobody
      // should ever see (or re-share) a *.up.railway.app URL. API routes are
      // deliberately excluded: Railway's healthcheck and any API client pinned
      // to the deployment URL must keep answering in place.
      {
        source: '/:path((?!api/).*)',
        has: [{ type: 'host', value: 'mixbase-production.up.railway.app' }],
        destination: 'https://mixbase.app/:path',
        permanent: true,
      },
    ]
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
