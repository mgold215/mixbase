'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import { Play, Pause, Music, MessageCircle, Send } from 'lucide-react'
import { usePlayer } from '@/contexts/PlayerContext'
import { audioProxyUrl, artworkProxyUrl } from '@/lib/supabase'
import type { FeedItem, FeedComment } from '@/lib/feed'

function timeAgo(date: string) {
  const diff = Date.now() - new Date(date).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export default function FeedClient({
  initialItems,
  currentUserId,
  loadError,
}: {
  initialItems: FeedItem[]
  currentUserId: string
  loadError: boolean
}) {
  const { playUrl, togglePlay, currentUrl, isPlaying, audioRef } = usePlayer()
  const [items, setItems] = useState(initialItems)
  const [openComments, setOpenComments] = useState<Set<string>>(new Set())
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [posting, setPosting] = useState<Set<string>>(new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})

  const playItem = useCallback((item: FeedItem) => {
    playUrl(
      audioProxyUrl(item.audio_url),
      item.title,
      item.artist,
      item.artwork_url ? artworkProxyUrl(item.artwork_url) : undefined,
      item.version_label
    )
  }, [playUrl])

  function handlePlay(item: FeedItem) {
    if (currentUrl === audioProxyUrl(item.audio_url)) {
      togglePlay()
      return
    }
    playItem(item)
  }

  // ── Continuous play through the feed ────────────────────────────────────────
  // When a feed track finishes, start the next one in the list. The shared
  // engine's own 'ended' handler runs first and stops custom-URL playback (it
  // has no queue for them); this listener runs after and advances instead.
  // Mirrored via refs so the once-mounted listener always sees fresh state.
  const itemsRef = useRef(items)
  useEffect(() => { itemsRef.current = items }, [items])
  const currentUrlRef = useRef(currentUrl)
  useEffect(() => { currentUrlRef.current = currentUrl }, [currentUrl])
  const playItemRef = useRef(playItem)
  useEffect(() => { playItemRef.current = playItem }, [playItem])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const onEnded = () => {
      const list = itemsRef.current
      const idx = list.findIndex(it => audioProxyUrl(it.audio_url) === currentUrlRef.current)
      if (idx >= 0 && idx + 1 < list.length) playItemRef.current(list[idx + 1])
    }
    audio.addEventListener('ended', onEnded)
    return () => audio.removeEventListener('ended', onEnded)
  }, [audioRef])

  function toggleComments(versionId: string) {
    setOpenComments(prev => {
      const next = new Set(prev)
      if (next.has(versionId)) next.delete(versionId)
      else next.add(versionId)
      return next
    })
  }

  async function submitComment(item: FeedItem) {
    const text = (drafts[item.version_id] ?? '').trim()
    if (!text || posting.has(item.version_id)) return
    setPosting(prev => new Set(prev).add(item.version_id))
    setErrors(prev => ({ ...prev, [item.version_id]: '' }))
    try {
      const res = await fetch('/api/feed/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version_id: item.version_id, comment: text }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error ?? 'Failed to post comment')
      const created = data as FeedComment
      setItems(prev => prev.map(it =>
        it.version_id === item.version_id ? { ...it, comments: [...it.comments, created] } : it
      ))
      setDrafts(prev => ({ ...prev, [item.version_id]: '' }))
    } catch (e) {
      setErrors(prev => ({ ...prev, [item.version_id]: e instanceof Error ? e.message : 'Failed to post comment' }))
    } finally {
      setPosting(prev => {
        const next = new Set(prev)
        next.delete(item.version_id)
        return next
      })
    }
  }

  if (loadError) {
    return (
      <div className="text-center py-16 text-sm" style={{ color: 'var(--text-muted)' }}>
        Couldn&apos;t load the feed. Pull to refresh or try again in a moment.
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="text-center py-16 text-sm" style={{ color: 'var(--text-muted)' }}>
        No uploads yet — be the first to share a mix.
      </div>
    )
  }

  return (
    <div className="mt-4">
      {items.map(item => {
        const proxied = audioProxyUrl(item.audio_url)
        const isCurrent = currentUrl === proxied
        const playing = isCurrent && isPlaying
        const commentsOpen = openComments.has(item.version_id)
        const isMine = item.user_id === currentUserId
        return (
          <div
            key={item.version_id}
            className="py-3"
            style={{ borderBottom: '1px solid var(--border)' }}
          >
            {/* Whole row is the play/pause target — one tap anywhere starts the track */}
            <div
              className="flex items-center gap-3 cursor-pointer group"
              onClick={() => handlePlay(item)}
              role="button"
              aria-label={playing ? `Pause ${item.title}` : `Play ${item.title}`}
            >
              {/* Artwork with play/pause state */}
              <div
                className="relative shrink-0"
                style={{ width: 48, height: 48, background: 'var(--surface-2)', borderRadius: 6, overflow: 'hidden' }}
              >
                {item.artwork_url ? (
                  <Image src={artworkProxyUrl(item.artwork_url)} alt="" fill sizes="48px" className="object-cover" />
                ) : (
                  <span className="absolute inset-0 flex items-center justify-center">
                    <Music size={16} style={{ color: 'var(--text-muted)', opacity: 0.4 }} />
                  </span>
                )}
                <span
                  className={`absolute inset-0 flex items-center justify-center transition-opacity ${playing || isCurrent ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                  style={{ background: 'rgba(0,0,0,0.45)' }}
                >
                  {playing
                    ? <Pause size={18} fill="#fff" style={{ color: '#fff' }} />
                    : <Play size={18} fill="#fff" style={{ color: '#fff' }} />}
                </span>
              </div>

              {/* Title / artist / meta */}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate" style={{ color: isCurrent ? 'var(--accent)' : 'var(--text)' }}>
                  {item.title}
                  <span className="ml-2" style={{ fontFamily: 'var(--font-mono), monospace', fontSize: 10, color: 'var(--text-muted)' }}>
                    {item.version_label}
                  </span>
                </div>
                <div className="text-xs truncate mt-0.5" style={{ color: 'var(--accent)' }}>
                  {item.artist}{isMine && <span style={{ color: 'var(--text-muted)' }}> (you)</span>}
                </div>
              </div>

              <div className="flex items-center gap-3 shrink-0">
                <span style={{ fontFamily: 'var(--font-mono), monospace', fontSize: 10, color: 'var(--text-muted)' }}>
                  {timeAgo(item.created_at)}
                </span>
                <button
                  onClick={e => { e.stopPropagation(); toggleComments(item.version_id) }}
                  className="flex items-center gap-1 p-1 -m-1 transition-colors"
                  style={{ color: commentsOpen ? 'var(--accent)' : 'var(--text-muted)' }}
                  aria-label="Comments"
                >
                  <MessageCircle size={15} strokeWidth={1.75} />
                  <span style={{ fontFamily: 'var(--font-mono), monospace', fontSize: 10 }}>{item.comments.length}</span>
                </button>
              </div>
            </div>

            {/* Comments */}
            {commentsOpen && (
              <div className="mt-3 ml-[60px]">
                {item.comments.map(c => (
                  <div key={c.id} className="mb-2">
                    <span className="text-xs font-medium" style={{ color: c.user_id === currentUserId ? 'var(--accent)' : 'var(--text)' }}>
                      {c.artist}
                    </span>
                    <span className="ml-2" style={{ fontFamily: 'var(--font-mono), monospace', fontSize: 10, color: 'var(--text-muted)' }}>
                      {timeAgo(c.created_at)}
                    </span>
                    <p className="text-xs mt-0.5 whitespace-pre-wrap break-words" style={{ color: 'var(--text-muted)' }}>
                      {c.comment}
                    </p>
                  </div>
                ))}

                <div className="flex items-center gap-2 mt-2">
                  <input
                    type="text"
                    value={drafts[item.version_id] ?? ''}
                    onChange={e => setDrafts(prev => ({ ...prev, [item.version_id]: e.target.value }))}
                    onKeyDown={e => { if (e.key === 'Enter') submitComment(item) }}
                    placeholder="Leave a note for the artist…"
                    maxLength={2000}
                    className="flex-1 text-xs px-3 py-2 rounded-lg outline-none"
                    style={{ background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)' }}
                  />
                  <button
                    onClick={() => submitComment(item)}
                    disabled={posting.has(item.version_id) || !(drafts[item.version_id] ?? '').trim()}
                    className="p-2 rounded-lg transition-colors disabled:opacity-40"
                    style={{ background: 'var(--accent)', color: '#0d0b08' }}
                    aria-label="Post comment"
                  >
                    <Send size={13} strokeWidth={2} />
                  </button>
                </div>
                {errors[item.version_id] && (
                  <p className="text-xs mt-1" style={{ color: '#f87171' }}>{errors[item.version_id]}</p>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
