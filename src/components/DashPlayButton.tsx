'use client'

import type { MouseEvent } from 'react'
import { Play, Pause } from 'lucide-react'
import { usePlayer } from '@/contexts/PlayerContext'
import { audioProxyUrl } from '@/lib/supabase'

type Props = {
  projectId: string
  audioUrl: string | null
  title: string
  artworkUrl: string | null
}

export default function DashPlayButton({ projectId, audioUrl, title, artworkUrl }: Props) {
  const { playTrack, playUrl, pause, currentTrack, currentUrl, isPlaying, tracks } = usePlayer()

  const proxyUrl = audioUrl ? audioProxyUrl(audioUrl) : null

  // Active when playing via playTrack (project ID match) OR via playUrl (URL match)
  const isActive =
    currentTrack?.project_id === projectId ||
    (proxyUrl !== null && currentUrl === proxyUrl)

  function handleClick(e: MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    if (!proxyUrl) return
    if (isActive && isPlaying) {
      pause()
      return
    }
    // Use playTrack when tracks are loaded (better integration: next/prev, player page highlight)
    // Fall back to playUrl when tracks haven't loaded yet — button always works
    if (tracks.length > 0) {
      playTrack(projectId)
    } else {
      playUrl(proxyUrl, title, 'mixBase', artworkUrl ?? undefined)
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
