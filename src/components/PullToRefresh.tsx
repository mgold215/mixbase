'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { RefreshCw } from 'lucide-react'

const THRESHOLD = 80 // px you need to pull down to trigger a refresh

export default function PullToRefresh() {
  const router = useRouter()
  const startY = useRef(0)
  const [pullDistance, setPullDistance] = useState(0) // how far the user has pulled (0–THRESHOLD)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    function onTouchStart(e: TouchEvent) {
      // Only start tracking if we're already scrolled to the very top
      if (window.scrollY === 0) {
        startY.current = e.touches[0].clientY
      } else {
        startY.current = 0
      }
    }

    function onTouchMove(e: TouchEvent) {
      if (!startY.current || refreshing) return
      const delta = e.touches[0].clientY - startY.current
      if (delta <= 0) {
        setPullDistance(0)
        return
      }
      // Cap visual travel at THRESHOLD
      setPullDistance(Math.min(delta, THRESHOLD))
    }

    function onTouchEnd() {
      if (pullDistance >= THRESHOLD && !refreshing) {
        setRefreshing(true)
        setPullDistance(0)
        router.refresh()
        // Hide the spinner after Next.js re-fetches (gives it ~1.5s to finish)
        setTimeout(() => setRefreshing(false), 1500)
      } else {
        setPullDistance(0)
      }
      startY.current = 0
    }

    document.addEventListener('touchstart', onTouchStart, { passive: true })
    document.addEventListener('touchmove', onTouchMove, { passive: true })
    document.addEventListener('touchend', onTouchEnd)

    return () => {
      document.removeEventListener('touchstart', onTouchStart)
      document.removeEventListener('touchmove', onTouchMove)
      document.removeEventListener('touchend', onTouchEnd)
    }
  }, [pullDistance, refreshing, router])

  // Nothing visible when idle
  if (!refreshing && pullDistance === 0) return null

  // How far we've progressed toward the threshold (0–1)
  const progress = pullDistance / THRESHOLD

  return (
    <div
      className="fixed top-0 left-0 right-0 z-50 flex items-center justify-center pointer-events-none"
      style={{
        height: refreshing ? 48 : pullDistance,
        transition: refreshing ? 'height 0.2s ease' : 'none',
      }}
    >
      <RefreshCw
        size={20}
        style={{
          color: 'var(--accent)',
          opacity: refreshing ? 1 : progress,
          transform: refreshing
            ? 'none'
            : `rotate(${progress * 180}deg)`,
          // Spin when actively refreshing
          animation: refreshing ? 'spin 0.8s linear infinite' : 'none',
        }}
      />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
