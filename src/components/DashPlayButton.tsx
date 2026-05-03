'use client'

import type { MouseEvent } from 'react'
import { Play, Pause } from 'lucide-react'
import { usePlayer } from '@/contexts/PlayerContext'

export default function DashPlayButton({ projectId }: { projectId: string }) {
  const { playTrack, pause, currentTrack, isPlaying } = usePlayer()
  const isActive = currentTrack?.project_id === projectId

  function handleClick(e: MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    if (isActive && isPlaying) {
      pause()
    } else {
      playTrack(projectId)
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`flex-shrink-0 rounded-full flex items-center justify-center transition-colors ${
        isActive
          ? 'bg-[#2dd4bf] hover:bg-[#14b8a6]'
          : 'bg-[#1a1a1a] hover:bg-[#252525] border border-[#2a2a2a]'
      }`}
      style={{ width: 44, height: 44 }}
      aria-label={isActive && isPlaying ? 'Pause' : 'Play'}
    >
      {isActive && isPlaying
        ? <Pause size={13} fill="white" className="text-white" />
        : <Play size={13} fill={isActive ? 'white' : '#888'} className={isActive ? 'text-white ml-0.5' : 'text-[#888] ml-0.5'} />
      }
    </button>
  )
}
