'use client'

import { Play, Pause } from 'lucide-react'
import { usePlayer } from '@/contexts/PlayerContext'

export default function DashPlayButton({ projectId }: { projectId: string }) {
  const { playTrack, pause, currentTrack, isPlaying } = usePlayer()
  const isActive = currentTrack?.project_id === projectId

  function handleClick(e: React.MouseEvent) {
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
      onClick={handleClick}
      className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
        isActive
          ? 'bg-[#a78bfa] hover:bg-[#9370f0]'
          : 'bg-[#1a1a1a] hover:bg-[#252525] border border-[#2a2a2a]'
      }`}
      aria-label={isActive && isPlaying ? 'Pause' : 'Play'}
    >
      {isActive && isPlaying
        ? <Pause size={13} fill="white" className="text-white" />
        : <Play size={13} fill={isActive ? 'white' : '#888'} className={isActive ? 'text-white ml-0.5' : 'text-[#888] ml-0.5'} />
      }
    </button>
  )
}
