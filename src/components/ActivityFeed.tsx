'use client'

import { Play, Pause } from 'lucide-react'
import { usePlayer } from '@/contexts/PlayerContext'

// Shape of activity rows from mb_activity table
type Activity = {
  id: string
  type: string
  project_id: string | null
  description: string | null
  created_at: string
}

// Minimal project shape — just what we need for matching
type Project = {
  id: string
  title: string
}

// Returns a text icon for each activity type
function activityIcon(type: string) {
  if (type === 'version_upload') return '\u2191'    // up arrow
  if (type === 'status_change') return '\u2192'     // right arrow
  if (type === 'feedback_received') return '\u2605'  // star
  if (type === 'release_created') return '\u25C6'    // diamond
  return '\u00B7'                                    // middle dot
}

// Returns a relative time string like "2h ago"
function timeAgo(date: string) {
  const diff = Date.now() - new Date(date).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

// Formats a date string into a readable date/time like "Apr 12, 2026 3:45 PM"
function formatDateTime(date: string) {
  return new Date(date).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export default function ActivityFeed({
  activity,
  projects,
}: {
  activity: Activity[]
  projects: Project[]
}) {
  const { playTrack, pause, currentTrack, isPlaying } = usePlayer()

  // Build a lookup map: project id -> project title
  const projectMap = new Map(projects.map(p => [p.id, p.title]))

  return (
    <div className="hidden lg:block bg-[#111] border border-[#1a1a1a] rounded-2xl p-5 h-fit">
      <h2 className="text-sm font-semibold text-white mb-4">Recent Activity</h2>
      {activity.length === 0 ? (
        <p className="text-[#444] text-xs">No activity yet</p>
      ) : (
        <div className="space-y-3">
          {activity.map(item => {
            // Look up the project name from the projects array
            const projectTitle = item.project_id ? projectMap.get(item.project_id) : null
            // Check if this activity's track is the one currently playing
            const isActive = currentTrack?.project_id === item.project_id
            const isCurrentlyPlaying = isActive && isPlaying

            return (
              <div key={item.id} className="flex gap-3 items-start">
                {/* Activity type icon */}
                <span className="text-[#2dd4bf] text-sm mt-0.5 flex-shrink-0 w-4 text-center">
                  {activityIcon(item.type)}
                </span>

                {/* Main content: project name, description, timestamps */}
                <div className="min-w-0 flex-1">
                  {/* Project / track name */}
                  {projectTitle && (
                    <p className="text-xs font-semibold text-[#2dd4bf] leading-tight truncate">
                      {projectTitle}
                    </p>
                  )}
                  {/* Activity description */}
                  <p className="text-xs text-[#888] leading-relaxed">{item.description}</p>
                  {/* Timestamps: relative + actual date/time */}
                  <p className="text-[10px] text-[#444] mt-0.5">
                    {timeAgo(item.created_at)} &middot; {formatDateTime(item.created_at)}
                  </p>
                </div>

                {/* Play button — only shown if this activity has a project */}
                {item.project_id && (
                  <button
                    onClick={() => {
                      if (isCurrentlyPlaying) {
                        pause()
                      } else {
                        playTrack(item.project_id!)
                      }
                    }}
                    className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center transition-colors mt-0.5 ${
                      isActive
                        ? 'bg-[#2dd4bf] hover:bg-[#14b8a6]'
                        : 'bg-[#1a1a1a] hover:bg-[#252525] border border-[#2a2a2a]'
                    }`}
                    aria-label={isCurrentlyPlaying ? 'Pause' : 'Play'}
                  >
                    {isCurrentlyPlaying ? (
                      <Pause size={10} fill="white" className="text-white" />
                    ) : (
                      <Play
                        size={10}
                        fill={isActive ? 'white' : '#888'}
                        className={isActive ? 'text-white ml-0.5' : 'text-[#888] ml-0.5'}
                      />
                    )}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
