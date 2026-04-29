'use client'

import Image from 'next/image'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Play, Pause, SkipBack, SkipForward, Maximize2, Music } from 'lucide-react'
import { usePlayer } from '@/contexts/PlayerContext'
import { formatDuration } from '@/lib/supabase'

const MINIPLAYER_STYLES = `
  @keyframes miniPlayerSlideUp {
    from { transform: translateY(100%); opacity: 0; }
    to   { transform: translateY(0);    opacity: 1; }
  }
`

export default function MiniPlayer() {
  const { currentTrack, isPlaying, currentTime, duration, togglePlay, seek, next, prev } = usePlayer()
  const pathname = usePathname()

  // Hide on the full player page or when nothing is loaded
  if (!currentTrack || pathname.startsWith('/player')) return null

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0

  return (
    <>
    <style>{MINIPLAYER_STYLES}</style>
    <div className="fixed bottom-0 md:bottom-0 left-0 right-0 z-40 backdrop-blur-md mb-16 md:mb-0"
      style={{ backgroundColor: 'color-mix(in srgb, var(--nav-bg) 95%, transparent)', borderTop: '1px solid var(--surface-2)', paddingBottom: 'env(safe-area-inset-bottom)', animation: 'miniPlayerSlideUp 0.32s cubic-bezier(0.25, 0.46, 0.45, 0.94) both' }}
    >
      {/* Progress bar — thin line along top edge */}
      <div className="relative h-[2px] bg-[#1a1a1a]">
        <div
          className="absolute inset-y-0 left-0 bg-[#2dd4bf] transition-none"
          style={{ width: `${progress}%` }}
        />
        {/* Scrubber hit area */}
        <div
          className="absolute inset-y-0 left-0 right-0 cursor-pointer"
          style={{ height: 16, top: -7 }}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            const ratio = (e.clientX - rect.left) / rect.width
            seek(ratio * duration)
          }}
        />
      </div>

      {/* Main bar */}
      <div className="flex items-center gap-3 px-4 h-14">
        {/* Artwork */}
        <div className="flex-shrink-0 w-9 h-9 rounded-md overflow-hidden bg-[#1a1a1a]">
          {currentTrack.artwork_url ? (
            <Image
              src={currentTrack.artwork_url}
              alt={currentTrack.title}
              width={36}
              height={36}
              className="object-cover w-full h-full"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <Music size={16} className="text-[#444]" />
            </div>
          )}
        </div>

        {/* Track info */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-white truncate leading-tight">{currentTrack.title}</p>
          <p className="text-[11px] text-[#555] truncate leading-tight">
            {currentTrack.version} · {formatDuration(Math.floor(currentTime))}
            {duration > 0 && ` / ${formatDuration(Math.floor(duration))}`}
          </p>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={prev}
            className="p-2 text-[#666] hover:text-white transition-colors"
            aria-label="Previous"
          >
            <SkipBack size={16} />
          </button>
          <button
            onClick={togglePlay}
            className="w-9 h-9 rounded-full bg-[#2dd4bf] hover:bg-[#14b8a6] flex items-center justify-center transition-colors"
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? <Pause size={15} fill="white" className="text-white" /> : <Play size={15} fill="white" className="text-white ml-0.5" />}
          </button>
          <button
            onClick={next}
            className="p-2 text-[#666] hover:text-white transition-colors"
            aria-label="Next"
          >
            <SkipForward size={16} />
          </button>
        </div>

        {/* Expand to full player */}
        <Link
          href={`/player?track=${currentTrack.project_id}`}
          className="p-2 text-[#555] hover:text-white transition-colors flex-shrink-0"
          aria-label="Open full player"
        >
          <Maximize2 size={15} />
        </Link>
      </div>
    </div>
    </>
  )
}
