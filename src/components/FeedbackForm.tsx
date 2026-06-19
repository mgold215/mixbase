'use client'

import { useState, type FormEvent } from 'react'
import { Star, MapPin, X } from 'lucide-react'
import { formatDuration } from '@/lib/supabase'

type Props = {
  versionId: string
  /** Live playback position from the share-page player. Lets the listener pin
   *  their comment to a moment in the track ("the kick is too loud at 1:32"). */
  currentTime?: number
  onSubmitted?: () => void
}

export default function FeedbackForm({ versionId, currentTime, onSubmitted }: Props) {
  const [name, setName] = useState('')
  const [rating, setRating] = useState(0)
  const [hoverRating, setHoverRating] = useState(0)
  const [comment, setComment] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState('')
  // Frozen timestamp the comment is pinned to. Pre-filled with the position the
  // listener was at when they opened the form (the common case: they paused on a
  // spot to comment), but they can clear it for general feedback or re-pin to now.
  const [pinnedAt, setPinnedAt] = useState<number | null>(
    currentTime != null && currentTime >= 1 ? Math.floor(currentTime) : null,
  )
  const canPin = currentTime != null && currentTime >= 1

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!comment.trim()) return
    setSubmitting(true)
    setError('')

    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Omit timestamp_seconds when unpinned so the API stores null.
        body: JSON.stringify({
          version_id: versionId,
          reviewer_name: name || 'Anonymous',
          rating,
          comment,
          ...(pinnedAt != null ? { timestamp_seconds: pinnedAt } : {}),
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(data.error ?? 'Failed to send feedback. Please try again.')
        setSubmitting(false)
        return
      }
    } catch {
      setError('Network error — please try again.')
      setSubmitting(false)
      return
    }

    setSubmitted(true)
    setSubmitting(false)
    onSubmitted?.()
  }

  if (submitted) {
    return (
      <div className="text-center py-6">
        <p className="text-emerald-400 font-medium">Feedback sent!</p>
        <p className="text-[#555] text-sm mt-1">Thanks for listening.</p>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <h3 className="text-sm font-semibold text-white">Leave Feedback</h3>

      <div>
        <input
          type="text"
          placeholder="Your name (optional)"
          value={name}
          onChange={e => setName(e.target.value)}
          className="w-full bg-[#0f0f0f] border border-[#222] rounded-xl px-4 py-2.5 text-sm text-white placeholder-[#444] focus:outline-none focus:border-[#2dd4bf]/40"
        />
      </div>

      {/* Star rating */}
      <div className="flex items-center gap-1">
        {[1, 2, 3, 4, 5].map(star => (
          <button
            key={star}
            type="button"
            onClick={() => setRating(star)}
            onMouseEnter={() => setHoverRating(star)}
            onMouseLeave={() => setHoverRating(0)}
            className="transition-colors"
          >
            <Star
              size={20}
              className={`${
                star <= (hoverRating || rating) ? 'text-[#2dd4bf] fill-[#2dd4bf]' : 'text-[#333]'
              } transition-colors`}
            />
          </button>
        ))}
        {rating > 0 && (
          <span className="text-xs text-[#555] ml-1">{rating}/5</span>
        )}
      </div>

      <div>
        <textarea
          placeholder="What do you think? Be specific — what's working, what isn't?"
          value={comment}
          onChange={e => setComment(e.target.value.slice(0, 200))}
          maxLength={200}
          rows={3}
          className="w-full bg-[#0f0f0f] border border-[#222] rounded-xl px-4 py-3 text-sm text-white placeholder-[#444] focus:outline-none focus:border-[#2dd4bf]/40 resize-none"
        />
        <p className="text-right text-[11px] text-[#444] mt-1">{comment.length}/200</p>
      </div>

      {/* Pin-to-moment — only when the track has been played past 0:00 */}
      {(canPin || pinnedAt != null) && (
        <div className="flex items-center gap-2">
          {pinnedAt != null ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-[#2dd4bf] bg-[#2dd4bf]/10 border border-[#2dd4bf]/30 rounded-full pl-2.5 pr-1.5 py-1">
              <MapPin size={11} />
              Pinned to {formatDuration(pinnedAt)}
              <button
                type="button"
                onClick={() => setPinnedAt(null)}
                aria-label="Remove timestamp"
                className="text-[#2dd4bf]/70 hover:text-white transition-colors"
              >
                <X size={12} />
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setPinnedAt(Math.floor(currentTime!))}
              className="inline-flex items-center gap-1.5 text-xs text-[#777] hover:text-[#2dd4bf] border border-[#222] hover:border-[#2dd4bf]/40 rounded-full px-2.5 py-1 transition-colors"
            >
              <MapPin size={11} />
              Pin to {formatDuration(Math.floor(currentTime!))}
            </button>
          )}
        </div>
      )}

      {error && <p className="text-red-400 text-sm">{error}</p>}

      <button
        type="submit"
        disabled={submitting || !comment.trim()}
        className="w-full bg-[#2dd4bf] hover:bg-[#14b8a6] disabled:opacity-40 disabled:cursor-not-allowed text-[#0a0a0a] text-sm font-semibold rounded-xl py-2.5 transition-colors"
      >
        {submitting ? 'Sending...' : 'Send Feedback'}
      </button>
    </form>
  )
}
