// Instant feedback while the intercepted project modal streams in.
export default function Loading() {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-6"
      style={{ backgroundColor: 'rgba(0,0,0,0.72)' }}
    >
      <div
        className="w-full max-w-3xl rounded-t-2xl sm:rounded-2xl p-8 space-y-4 animate-pulse"
        style={{ backgroundColor: 'var(--bg-page)', border: '1px solid var(--border)', minHeight: 320 }}
      >
        <div className="flex gap-6">
          <div className="w-32 h-32 rounded-xl" style={{ backgroundColor: 'var(--surface-2)' }} />
          <div className="flex-1 space-y-3 pt-1">
            <div className="h-6 w-2/3 rounded" style={{ backgroundColor: 'var(--surface-2)' }} />
            <div className="h-3 w-1/3 rounded" style={{ backgroundColor: 'var(--surface-2)' }} />
            <div className="h-3 w-1/2 rounded" style={{ backgroundColor: 'var(--surface-2)' }} />
          </div>
        </div>
        <div className="h-32 rounded-2xl" style={{ backgroundColor: 'var(--surface-2)' }} />
      </div>
    </div>
  )
}
