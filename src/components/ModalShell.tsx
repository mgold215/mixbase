'use client'

import { useCallback, useEffect, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { X } from 'lucide-react'

// Overlay used by the intercepted /projects/* routes. Closing just navigates
// back — the page underneath stays fresh because every mutation inside the
// modal (save, upload, artwork, …) already calls router.refresh() itself.
// Do NOT refresh here: refreshing on unmount invalidates the whole client
// router cache on every close/navigation and makes the app feel sluggish.
export default function ModalShell({ children }: { children: ReactNode }) {
  const router = useRouter()

  const dismiss = useCallback(() => router.back(), [router])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') dismiss()
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [dismiss])

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-6"
      style={{ backgroundColor: 'rgba(0,0,0,0.72)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)' }}
      onClick={e => { if (e.target === e.currentTarget) dismiss() }}
    >
      <div
        className="relative w-full max-w-3xl overflow-y-auto rounded-t-2xl sm:rounded-2xl overscroll-contain"
        style={{ backgroundColor: 'var(--bg-page)', border: '1px solid var(--border)', maxHeight: '92dvh' }}
      >
        {/* Zero-height sticky strip so the close button stays visible while scrolling */}
        <div className="sticky top-0 z-10 flex justify-end" style={{ height: 0 }}>
          <button
            onClick={dismiss}
            aria-label="Close"
            className="m-3 w-8 h-8 flex items-center justify-center rounded-full transition-colors hover:opacity-80"
            style={{ backgroundColor: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
          >
            <X size={15} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
