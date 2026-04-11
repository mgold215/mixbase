'use client'

import { useState, type FormEvent } from 'react'
import { Star } from 'lucide-react'

type Props = {
  versionId: string
  onSubmitted?: () => void
}

export default function FeedbackForm({ versionId, onSubmitted }: Props) {
  const [name, setName] = useState('')
  const [rating, setRating] = useState(0)
  const [hoverRating, setHoverRating] = useState(0)
  const [comment, setComment] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!comment.trim()) return
    setSubmitting(true)
    setError('')

    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version_id: versionId, reviewer_name: name || 'Anonymous', rating, comment }),
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
          className="w-full bg-[#0f0f0f] border border-[#222] rounded-xl px-4 py-2.5 text-sm text-white placeholder-[#444] focus:outline-none focus:border-[#a78bfa]/40"
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
                star <= (hoverRating || rating) ? 'text-[#a78bfa] fill-[#a78bfa]' : 'text-[#333]'
              } transition-colors`}
            />
          </button>
        ))}
        {rating > 0 && (
          <span className="text-xs text-[#555] ml-1">{rating}/5</span>
        )}
      </div>

      <textarea
        placeholder="What do you think? Be specific — what's working, what isn't?"
        value={comment}
        onChange={e => setComment(e.target.value)}
        rows={3}
        className="w-full bg-[#0f0f0f] border border-[#222] rounded-xl px-4 py-3 text-sm text-white placeholder-[#444] focus:outline-none focus:border-[#a78bfa]/40 resize-none"
      />

      {error && <p className="text-red-400 text-sm">{error}</p>}

      <button
        type="submit"
        disabled={submitting || !comment.trim()}
        className="w-full bg-[#a78bfa] hover:bg-[#9370f0] disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-xl py-2.5 transition-colors"
      >
        {submitting ? 'Sending...' : 'Send Feedback'}
      </button>
    </form>
  )
}
