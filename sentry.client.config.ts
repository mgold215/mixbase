import * as Sentry from '@sentry/nextjs'

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Capture 10% of transactions for performance monitoring (keeps quota low)
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,

  // Don't send errors in development — reduces noise
  enabled: process.env.NODE_ENV === 'production',

  // Session replay: capture 1% of sessions, 100% of sessions with errors
  replaysSessionSampleRate: 0.01,
  replaysOnErrorSampleRate: 1.0,

  integrations: [
    Sentry.replayIntegration({
      // Mask all text and inputs by default to avoid capturing PII
      maskAllText: true,
      blockAllMedia: false,
    }),
  ],
})
