// instrumentation.ts — loaded by Next.js on startup to register Sentry
// on the server (Node.js runtime) and edge runtime.
// onRequestError captures errors from Server Components, middleware, and API routes.
import * as Sentry from '@sentry/nextjs'

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config')
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config')
  }
}

export const onRequestError = Sentry.captureRequestError
