'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import Image from 'next/image'
import { Play, Pause, Music } from 'lucide-react'
import { audioProxyUrl } from '@/lib/supabase'
import { extractDominantColor } from '@/lib/audio-analysis'
import type { Release } from '@/lib/supabase'

type Project = { title: string; artwork_url: string | null; user_id: string } | null

type Props = {
  release: Release
  project: Project
  artistName: string
  audioUrl: string | null
}

const PLATFORMS = [
  {
    key: 'spotify_url' as keyof Release,
    name: 'Spotify',
    color: '#1DB954',
    bg: 'rgba(29,185,84,0.12)',
    border: 'rgba(29,185,84,0.35)',
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
        <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/>
      </svg>
    ),
  },
  {
    key: 'apple_music_url' as keyof Release,
    name: 'Apple Music',
    color: '#fc3c44',
    bg: 'rgba(252,60,68,0.12)',
    border: 'rgba(252,60,68,0.35)',
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
        <path d="M23.994 6.124a9.23 9.23 0 00-.24-2.19c-.317-1.31-1.062-2.31-2.18-3.043a6.303 6.303 0 00-1.905-.83 9.564 9.564 0 00-1.699-.204c-.06-.005-.12-.01-.17-.015H6.197c-.1.01-.198.015-.297.02C5.3.09 4.795.15 4.3.27c-1.15.27-2.08.87-2.778 1.806A5.664 5.664 0 00.483 4.132 9.166 9.166 0 00.24 5.965C.224 6.17.215 6.38.21 6.59V17.41c.005.207.014.413.03.62.06.71.205 1.39.49 2.04.28.64.67 1.19 1.18 1.65.5.46 1.08.79 1.72 1.01.55.19 1.12.29 1.71.32.25.02.5.02.75.02h11.25c.25 0 .5 0 .75-.02.59-.03 1.16-.13 1.71-.32.64-.22 1.22-.55 1.72-1.01.51-.46.9-1.01 1.18-1.65.285-.65.43-1.33.49-2.04.016-.207.025-.413.03-.62V6.59c-.005-.207-.014-.413-.03-.62zm-6.834 9.97l-.006.005c-.36.44-.85.68-1.42.71-.57.03-1.08-.16-1.47-.55l-3.19-3.19c-.04-.04-.08-.04-.12 0l-1.38 1.38c-.2.2-.44.3-.71.3h-.02c-.28-.01-.52-.12-.71-.32l-.01-.01-.37-.41c-.16-.18-.23-.39-.22-.61.01-.22.1-.42.27-.56l1.42-1.42c.04-.04.04-.08 0-.12l-3.19-3.19c-.4-.4-.58-.92-.55-1.47.03-.57.27-1.06.71-1.42l.005-.006c.44-.36.94-.5 1.5-.44.56.07 1.02.34 1.36.79l3.07 3.96c.04.05.1.05.14 0l3.07-3.96c.34-.45.8-.72 1.36-.79.56-.06 1.06.08 1.5.44l.005.006c.44.36.68.85.71 1.42.03.55-.15 1.07-.55 1.47l-3.19 3.19c-.04.04-.04.08 0 .12l1.42 1.42c.17.14.26.34.27.56.01.22-.06.43-.22.61l-.37.41z"/>
      </svg>
    ),
  },
  {
    key: 'youtube_url' as keyof Release,
    name: 'YouTube',
    color: '#FF0000',
    bg: 'rgba(255,0,0,0.12)',
    border: 'rgba(255,0,0,0.35)',
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
        <path d="M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
      </svg>
    ),
  },
  {
    key: 'tidal_url' as keyof Release,
    name: 'Tidal',
    color: '#00FFFF',
    bg: 'rgba(0,255,255,0.08)',
    border: 'rgba(0,255,255,0.3)',
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
        <path d="M12.012 3.992L8.008 7.996 4.004 3.992 0 7.996l4.004 4.004 4.004-4.004 4.004 4.004 4.004-4.004zM8.008 16.004l4.004-4.004 4.004 4.004 4.004-4.004-4.004-4.004-4.004 4.004-4.004-4.004-4.004 4.004z"/>
      </svg>
    ),
  },
  {
    key: 'amazon_music_url' as keyof Release,
    name: 'Amazon Music',
    color: '#00A8E1',
    bg: 'rgba(0,168,225,0.12)',
    border: 'rgba(0,168,225,0.35)',
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
        <path d="M13.958 10.09c0 1.232.029 2.256-.591 3.351-.502.891-1.301 1.438-2.186 1.438-1.214 0-1.922-.924-1.922-2.292 0-2.692 2.415-3.182 4.699-3.182v.685zm3.186 7.705c-.209.189-.512.201-.745.074-1.047-.871-1.234-1.276-1.814-2.106-1.734 1.768-2.962 2.297-5.209 2.297-2.66 0-4.731-1.641-4.731-4.925 0-2.565 1.391-4.309 3.37-5.164 1.715-.754 4.11-.891 5.942-1.099v-.41c0-.753.06-1.642-.384-2.294-.384-.578-1.128-.817-1.784-.817-1.214 0-2.294.622-2.56 1.913-.054.285-.261.566-.548.58l-3.061-.329c-.259-.056-.548-.266-.472-.66C5.977 1.795 8.806.5 11.33.5c1.297 0 2.993.345 4.017 1.329C16.645 2.98 16.527 4.84 16.527 6.86v4.604c0 1.383.576 1.993 1.118 2.742.189.266.23.584-.01.78-.607.507-1.686 1.45-2.278 1.979l-.213-.17zm3.488 2.987c-2.495 1.84-6.11 2.816-9.225 2.816-4.363 0-8.287-1.613-11.263-4.296-.234-.211-.025-.5.256-.335 3.207 1.867 7.17 2.99 11.264 2.99 2.76 0 5.796-.572 8.591-1.758.421-.18.776.277.377.583zm1.084-1.233c-.319-.41-2.117-.194-2.926-.097-.246.028-.284-.184-.062-.339 1.433-1.008 3.783-.717 4.059-.379.277.341-.073 2.7-1.418 3.826-.207.173-.404.081-.312-.147.302-.757.978-2.453.659-2.864z"/>
      </svg>
    ),
  },
  {
    key: 'soundcloud_url' as keyof Release,
    name: 'SoundCloud',
    color: '#FF5500',
    bg: 'rgba(255,85,0,0.12)',
    border: 'rgba(255,85,0,0.35)',
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
        <path d="M1.175 12.225C.528 12.225 0 12.75 0 13.4v.15c0 .65.528 1.175 1.175 1.175.648 0 1.175-.525 1.175-1.175V13.4c0-.65-.527-1.175-1.175-1.175zm-1.175-2.8v5.325c0 .65.528 1.175 1.175 1.175.648 0 1.175-.525 1.175-1.175V9.425c0-.648-.527-1.175-1.175-1.175C.528 8.25 0 8.777 0 9.425zm3.6 7.6c.648 0 1.175-.526 1.175-1.175V8.1c0-.648-.527-1.175-1.175-1.175C2.95 6.925 2.425 7.452 2.425 8.1v5.75c0 .649.525 1.175 1.175 1.175zm3.6.625c.648 0 1.175-.526 1.175-1.175v-8.7c0-.647-.527-1.175-1.175-1.175C6.55 5.8 6.025 6.328 6.025 6.975v8.7c0 .649.525 1.175 1.175 1.175zm3.6.65c.648 0 1.175-.527 1.175-1.175v-11c0-.648-.527-1.175-1.175-1.175C9.15 3.15 8.625 3.677 8.625 4.325v11c0 .648.525 1.175 1.175 1.175zm5.55-11.725c-.3 0-.588.05-.862.138C14.838 4.637 13.1 3.15 11.05 3.15c-.462 0-.9.088-1.3.238v11.487c0 .6.463 1.1 1.05 1.175H19.8c1.763 0 3.2-1.437 3.2-3.2 0-1.762-1.437-3.2-3.2-3.2-.025 0-.05 0-.075.002-.375-2.4-2.45-4.222-4.975-4.222z"/>
      </svg>
    ),
  },
  {
    key: 'bandcamp_url' as keyof Release,
    name: 'Bandcamp',
    color: '#1DA0C3',
    bg: 'rgba(29,160,195,0.12)',
    border: 'rgba(29,160,195,0.35)',
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
        <path d="M0 18.75l7.437-13.5H24l-7.438 13.5z"/>
      </svg>
    ),
  },
]

function isPresave(releaseDate: string | null): boolean {
  if (!releaseDate) return false
  return new Date(releaseDate).getTime() > Date.now()
}

function daysUntil(dateStr: string): number {
  return Math.ceil((new Date(dateStr).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
}

export default function ReleaseClient({ release, project, artistName, audioUrl }: Props) {
  const [accent, setAccent] = useState<[number, number, number]>([139, 92, 246])
  const [isPlaying, setIsPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const audioRef = useRef<HTMLAudioElement>(null)
  const presave = isPresave(release.release_date)
  const days = release.release_date && presave ? daysUntil(release.release_date) : null
  const artworkUrl = project?.artwork_url ?? null
  const proxiedAudio = audioUrl ? audioProxyUrl(audioUrl) : null

  const accentCss = `rgb(${accent[0]},${accent[1]},${accent[2]})`
  const accentDim = `rgba(${accent[0]},${accent[1]},${accent[2]},0.15)`

  useEffect(() => {
    if (artworkUrl) extractDominantColor(artworkUrl).then(setAccent).catch(() => {})
  }, [artworkUrl])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const onPlay = () => setIsPlaying(true)
    const onPause = () => setIsPlaying(false)
    const onEnded = () => { setIsPlaying(false); setProgress(0) }
    const onTime = () => setProgress(audio.duration ? audio.currentTime / audio.duration : 0)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('ended', onEnded)
    audio.addEventListener('timeupdate', onTime)
    return () => {
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('timeupdate', onTime)
    }
  }, [])

  const togglePlay = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    if (isPlaying) audio.pause()
    else audio.play().catch(() => {})
  }, [isPlaying])

  const activeLinks = PLATFORMS.filter(p => !!release[p.key])

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-start pb-16"
      style={{ background: `radial-gradient(ellipse at top, ${accentDim} 0%, #0a0a0a 60%)`, backgroundColor: '#0a0a0a' }}
    >
      {/* Header */}
      <header className="w-full flex items-center justify-center py-5 border-b border-white/5">
        <span className="font-[family-name:var(--font-jost)] flex items-baseline gap-0">
          <span className="text-[15px] font-bold tracking-[0.04em] text-white">mix</span>
          <span className="text-[15px] font-bold tracking-[0.04em]" style={{ color: accentCss }}>BASE</span>
        </span>
      </header>

      <div className="w-full max-w-sm mx-auto px-5 pt-10 flex flex-col items-center gap-6">
        {/* Artwork */}
        <div
          className="relative w-48 h-48 rounded-2xl overflow-hidden shadow-2xl flex-shrink-0"
          style={{ boxShadow: `0 8px 40px ${accentDim}` }}
        >
          {artworkUrl ? (
            <Image src={artworkUrl} alt={release.title} fill className="object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-white/5">
              <Music className="w-16 h-16 text-white/20" />
            </div>
          )}
        </div>

        {/* Title + Artist */}
        <div className="text-center">
          <h1 className="text-2xl font-bold text-white font-[family-name:var(--font-jost)] leading-tight">
            {release.title}
          </h1>
          <p className="mt-1 text-sm" style={{ color: accentCss }}>{artistName}</p>
          {release.release_date && (
            <p className="mt-1 text-xs text-white/40">
              {presave
                ? `Out in ${days} day${days === 1 ? '' : 's'}`
                : `Out now · ${new Date(release.release_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`}
            </p>
          )}
        </div>

        {/* Audio preview */}
        {proxiedAudio && (
          <button
            onClick={togglePlay}
            className="flex items-center gap-3 px-5 py-2.5 rounded-full text-sm font-medium transition-all"
            style={{ background: accentDim, border: `1px solid ${accentCss}40`, color: accentCss }}
          >
            {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            {isPlaying ? 'Pause preview' : 'Play preview'}
            {isPlaying && progress > 0 && (
              <span className="ml-1 text-xs text-white/40">{Math.round(progress * 100)}%</span>
            )}
          </button>
        )}

        {/* Streaming links */}
        {activeLinks.length > 0 ? (
          <div className="w-full flex flex-col gap-3">
            <p className="text-center text-xs text-white/30 uppercase tracking-widest">
              {presave ? 'Pre-save' : 'Stream now'}
            </p>
            {activeLinks.map(platform => (
              <a
                key={platform.key}
                href={release[platform.key] as string}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-4 px-5 py-3.5 rounded-xl text-sm font-semibold transition-all hover:scale-[1.02] active:scale-[0.98]"
                style={{
                  background: platform.bg,
                  border: `1px solid ${platform.border}`,
                  color: platform.color,
                }}
              >
                <span className="flex-shrink-0">{platform.icon}</span>
                <span className="flex-1">{platform.name}</span>
                <span className="text-xs opacity-60">{presave ? 'Pre-save →' : 'Listen →'}</span>
              </a>
            ))}
          </div>
        ) : (
          <p className="text-center text-xs text-white/20 py-4">Streaming links coming soon</p>
        )}
      </div>

      {/* Footer */}
      <div className="mt-auto pt-12 text-center">
        <a
          href="https://mixbase.app"
          className="text-xs text-white/20 hover:text-white/40 transition-colors"
        >
          Powered by mixBASE
        </a>
      </div>

      {proxiedAudio && <audio ref={audioRef} src={proxiedAudio} preload="none" />}
    </div>
  )
}
