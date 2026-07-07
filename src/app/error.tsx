'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import * as Sentry from '@sentry/nextjs'

// Route-level error boundary. Catches unhandled render/data errors in any page
// and shows a branded recovery screen instead of a raw stack trace.
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    Sentry.captureException(error)
  }, [error])

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4 text-center"
      style={{ backgroundColor: 'var(--bg-page)' }}
    >
      <div className="max-w-sm">
        <h1 className="text-3xl font-bold tracking-[0.04em] font-[family-name:var(--font-jost)]">
          <span style={{ color: 'var(--text)' }}>mix</span>
          <span style={{ color: 'var(--accent)' }}>BASE</span>
        </h1>
        <p className="text-base mt-8" style={{ color: 'var(--text)' }}>Something went wrong.</p>
        <p className="text-sm mt-2" style={{ color: 'var(--text-muted)' }}>
          We hit an unexpected error. You can try again, or head back to your projects.
        </p>
        <div className="flex items-center justify-center gap-3 mt-8">
          <button
            onClick={reset}
            className="font-semibold rounded-xl px-6 py-3 transition-colors"
            style={{ backgroundColor: 'var(--accent)', color: 'var(--bg)' }}
          >
            Try again
          </button>
          <Link
            href="/dashboard"
            className="font-semibold rounded-xl px-6 py-3 transition-colors"
            style={{ border: '1px solid var(--border)', color: 'var(--text)' }}
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  )
}
