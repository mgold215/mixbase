// instrumentation.ts — loaded by Next.js on startup to register Sentry
// on the server (Node.js runtime) and edge runtime.
// onRequestError captures errors from Server Components, middleware, and API routes.
import * as Sentry from '@sentry/nextjs'

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config')

    // Fire-and-forget schema heals for the newest migrations (026/027), so a
    // deploy that beat its hand-applied migration converges at BOOT instead of
    // on the first user request that happens to hit the missing table/columns.
    // Deliberately not awaited: a slow/failed Management API call must never
    // delay or crash startup — the per-route heals remain the fallback.
    import('./src/lib/schema-heal')
      .then(m => {
        void m.ensureLibraryTracksTable()
        void m.ensureDistroKidColumns()
      })
      .catch(() => {})

    // Fire-and-forget WebM→MP4 visualizer heal: iOS AVPlayer can't decode
    // WebM, so any WebM loop still referenced by the library or a project pin
    // gets an H.264 twin and the rows are repointed. Idempotent and
    // sequential; a failure must never delay or crash startup.
    import('./src/lib/visualizer-transcode')
      .then(m => { void m.healWebmVisualizers() })
      .catch(() => {})
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config')
  }
}

export const onRequestError = Sentry.captureRequestError
