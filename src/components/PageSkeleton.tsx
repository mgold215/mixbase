// Lightweight pulsing placeholder shown by loading.tsx while force-dynamic
// pages fetch on the server. Sized to roughly match a page of cards below Nav.
export default function PageSkeleton() {
  return (
    <div className="min-h-screen" style={{ backgroundColor: 'var(--bg-page)' }}>
      <div className="pt-20 px-6 max-w-6xl mx-auto animate-pulse">
        <div className="h-8 w-48 rounded-lg mb-8" style={{ backgroundColor: 'var(--surface-2)' }} />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-40 rounded-xl" style={{ backgroundColor: 'var(--surface)' }} />
          ))}
        </div>
      </div>
    </div>
  )
}
