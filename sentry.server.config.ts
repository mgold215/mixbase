import * as Sentry from '@sentry/nextjs'

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Capture 10% of server transactions
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,

  enabled: process.env.NODE_ENV === 'production',
})
