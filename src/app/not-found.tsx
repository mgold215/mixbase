import Link from 'next/link'

export default function NotFound() {
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
        <p className="text-6xl font-bold mt-8" style={{ color: 'var(--accent)' }}>404</p>
        <p className="text-base mt-4" style={{ color: 'var(--text)' }}>We couldn&apos;t find that page.</p>
        <p className="text-sm mt-2" style={{ color: 'var(--text-muted)' }}>
          The link may be broken, or the page may have moved.
        </p>
        <Link
          href="/dashboard"
          className="inline-block mt-8 font-semibold rounded-xl px-6 py-3 transition-colors"
          style={{ backgroundColor: 'var(--accent)', color: 'var(--bg)' }}
        >
          Back to your projects
        </Link>
      </div>
    </div>
  )
}
