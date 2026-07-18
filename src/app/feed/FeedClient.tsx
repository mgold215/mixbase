'use client'

import { memo, useEffect, useState } from 'react'
import Image from 'next/image'
import { Play, Pause, Music, MessageCircle, Send, History } from 'lucide-react'
import { usePlayer } from '@/contexts/PlayerContext'
import { audioProxyUrl, artworkProxyUrl } from '@/lib/supabase'
import { timeAgo } from '@/lib/time'
import type { FeedItem, FeedComment } from '@/lib/feed'

export default function FeedClient({
  initialItems,
  currentUserId,
  loadError,
}: {
  initialItems: FeedItem[]
  currentUserId: string
  loadError: boolean
}) {
  const { playUrl, togglePlay, currentUrl, isPlaying, setUrlQueue } = usePlayer()
  const [items, setItems] = useState(initialItems)

  // Hand the feed order to the player engine. Continuous play, loop modes and
  // the mini-player / lock-screen next/prev are all handled there — one
  // end-of-track policy, still working after navigating away from /feed.
  useEffect(() => {
    setUrlQueue(items.map(item => ({
      url: audioProxyUrl(item.audio_url),
      title: item.title,
      artist: item.artist,
      artworkUrl: item.artwork_url ? artworkProxyUrl(item.artwork_url) : null,
      versionLabel: item.version_label,
    })))
  }, [items, setUrlQueue])

  // Play (or toggle) any mix belonging to a feed item — the live one or an
  // older version. Metadata (title/artist/artwork) comes from the item; the
  // label distinguishes which mix is playing.
  function handlePlayMix(item: FeedItem, audioUrl: string, label: string) {
    const url = audioProxyUrl(audioUrl)
    if (currentUrl === url) {
      togglePlay()
      return
    }
    playUrl(url, item.title, item.artist, item.artwork_url ? artworkProxyUrl(item.artwork_url) : undefined, label)
  }

  function handleCommentPosted(versionId: string, comment: FeedComment) {
    setItems(prev => prev.map(it =>
      it.version_id === versionId ? { ...it, comments: [...it.comments, comment] } : it
    ))
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
      {items.map(item => (
        <FeedRow
          key={item.project_id}
          item={item}
          currentUrl={currentUrl}
          isPlaying={isPlaying}
          isMine={item.user_id === currentUserId}
          currentUserId={currentUserId}
          onPlayMix={handlePlayMix}
          onCommentPosted={handleCommentPosted}
        />
      ))}
    </div>
  )
}

// One feed row. Memoized, and it owns its comment-draft state locally — so
// typing in one row's input re-renders that row only, not the whole list.
const FeedRow = memo(function FeedRow({
  item,
  currentUrl,
  isPlaying,
  isMine,
  currentUserId,
  onPlayMix,
  onCommentPosted,
}: {
  item: FeedItem
  currentUrl: string | null
  isPlaying: boolean
  isMine: boolean
  currentUserId: string
  onPlayMix: (item: FeedItem, audioUrl: string, label: string) => void
  onCommentPosted: (versionId: string, comment: FeedComment) => void
}) {
  const [commentsOpen, setCommentsOpen] = useState(false)
  const [olderOpen, setOlderOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState('')

  const isCurrent = currentUrl === audioProxyUrl(item.audio_url)
  const playing = isCurrent && isPlaying

  async function submitComment() {
    const text = draft.trim()
    if (!text || posting) return
    setPosting(true)
    setError('')
    try {
      const res = await fetch('/api/feed/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version_id: item.version_id, comment: text }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error ?? 'Failed to post comment')
      onCommentPosted(item.version_id, data as FeedComment)
      setDraft('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to post comment')
    } finally {
      setPosting(false)
    }
  }

  return (
    <div className="py-3" style={{ borderBottom: '1px solid var(--border)' }}>
      {/* Whole row is the play/pause target — one tap anywhere starts the track.
          Keyboard-accessible: focusable, Enter/Space activate. */}
      <div
        className="flex items-center gap-3 cursor-pointer group rounded-md focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--accent)]"
        onClick={() => onPlayMix(item, item.audio_url, item.version_label)}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onPlayMix(item, item.audio_url, item.version_label)
          }
        }}
        role="button"
        tabIndex={0}
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
            onClick={e => { e.stopPropagation(); setCommentsOpen(o => !o) }}
            className="flex items-center gap-1 p-1 -m-1 transition-colors"
            style={{ color: commentsOpen ? 'var(--accent)' : 'var(--text-muted)' }}
            aria-label="Comments"
            aria-expanded={commentsOpen}
          >
            <MessageCircle size={15} strokeWidth={1.75} />
            <span style={{ fontFamily: 'var(--font-mono), monospace', fontSize: 10 }}>{item.comments.length}</span>
          </button>
        </div>
      </div>

      {/* Older mixes browser */}
      {item.older.length > 0 && (
        <button
          onClick={() => setOlderOpen(o => !o)}
          className="ml-[60px] mt-1.5 flex items-center gap-1.5 transition-colors"
          style={{ fontFamily: 'var(--font-mono), monospace', fontSize: 10, color: olderOpen ? 'var(--accent)' : 'var(--text-muted)' }}
          aria-expanded={olderOpen}
        >
          <History size={11} strokeWidth={1.75} />
          {olderOpen ? 'Hide older mixes' : `Listen to older mixes (${item.older.length})`}
        </button>
      )}
      {olderOpen && (
        <div className="ml-[60px] mt-1.5">
          {item.older.map(o => {
            const oCurrent = currentUrl === audioProxyUrl(o.audio_url)
            const oPlaying = oCurrent && isPlaying
            return (
              <div
                key={o.version_id}
                className="flex items-center gap-2 py-1.5 cursor-pointer rounded-md focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--accent)]"
                onClick={() => onPlayMix(item, o.audio_url, o.version_label)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onPlayMix(item, o.audio_url, o.version_label)
                  }
                }}
                role="button"
                tabIndex={0}
                aria-label={oPlaying ? `Pause ${item.title} ${o.version_label}` : `Play ${item.title} ${o.version_label}`}
              >
                <span className="flex items-center justify-center shrink-0" style={{ width: 16, color: oCurrent ? 'var(--accent)' : 'var(--text-muted)' }}>
                  {oPlaying
                    ? <Pause size={11} fill="currentColor" />
                    : <Play size={11} fill="currentColor" />}
                </span>
                <span
                  className="truncate"
                  style={{ fontFamily: 'var(--font-mono), monospace', fontSize: 11, color: oCurrent ? 'var(--accent)' : 'var(--text)' }}
                >
                  {o.version_label}
                </span>
                <span style={{ fontFamily: 'var(--font-mono), monospace', fontSize: 10, color: 'var(--text-muted)' }}>
                  {timeAgo(o.created_at)}
                </span>
              </div>
            )
          })}
        </div>
      )}

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
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                // isComposing guard: Enter that commits an IME composition
                // (Japanese/Chinese/Korean input) must not submit the comment.
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) submitComment()
              }}
              placeholder="Leave a note for the artist…"
              maxLength={2000}
              className="flex-1 text-xs px-3 py-2 rounded-lg outline-none"
              style={{ background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)' }}
            />
            <button
              onClick={submitComment}
              disabled={posting || !draft.trim()}
              className="p-2 rounded-lg transition-colors disabled:opacity-40"
              style={{ background: 'var(--accent)', color: '#0d0b08' }}
              aria-label="Post comment"
            >
              <Send size={13} strokeWidth={2} />
            </button>
          </div>
          {error && (
            <p className="text-xs mt-1" style={{ color: '#f87171' }}>{error}</p>
          )}
        </div>
      )}
    </div>
  )
})
