'use client'

import { useState, useEffect } from 'react'
import Image from 'next/image'
import dynamic from 'next/dynamic'
import { MessageSquare, Zap, Star, Clock, Music, GitMerge } from 'lucide-react'
import { formatDuration } from '@/lib/supabase'

const WaveformPlayer = dynamic(() => import('@/components/WaveformPlayer'), { ssr: false })

const FEEDBACK_TAGS = [
  { category: 'Structure', tags: ['Longer intro', 'Shorter intro', 'Needs bridge', 'Drop too early', 'Drop too late', 'Strong outro', 'Weak outro'] },
  { category: 'Sound',     tags: ['More bass', 'Less bass', 'Muddy mids', 'Harsh highs', 'Too much reverb', 'Too dry', 'Love the sound design'] },
  { category: 'Mix',       tags: ['Kick too loud', 'Kick too quiet', 'Vocals buried', 'Wide stereo', 'Needs compression', 'Good levels'] },
  { category: 'Vibe',      tags: ['Energy is right', 'Needs more energy', 'Melody is strong', 'Chord progression slaps', 'Feels repetitive', 'Unique sound'] },
]

type FeedVersion = {
  id: string
  version_number: number
  label: string | null
  audio_url: string
  audio_filename: string | null
  duration_seconds: number | null
  status: string
  feedback_context: string | null
  created_at: string
  mf_projects: { id: string; title: string; artwork_url: string | null; genre: string | null; bpm: number | null } | null
  mf_feedback: { id: string; producer_handle: string | null; tags: string[]; comment: string | null; rating: number | null; timestamp_seconds: number | null; created_at: string; is_community: boolean }[]
}

type Producer = { id: string; handle: string; credits: number }

type Props = { initialVersions: FeedVersion[] }

export default function FeedClient({ initialVersions }: Props) {
  const [versions] = useState(initialVersions)
  const [producer, setProducer] = useState<Producer | null>(null)
  const [handleInput, setHandleInput] = useState('')
  const [handleError, setHandleError] = useState('')
  const [joiningAs, setJoiningAs] = useState(false)
  const [activeVersion, setActiveVersion] = useState<string | null>(null)
  const [feedbackState, setFeedbackState] = useState<Record<string, {
    tags: string[]; comment: string; timestamp: string; rating: number; submitting: boolean; done: boolean; error: string
  }>>({})
  const [collabState, setCollabState] = useState<Record<string, {
    open: boolean; message: string; submitting: boolean; done: boolean; error: string
  }>>({})

  // Persist producer handle in localStorage
  useEffect(() => {
    const saved = localStorage.getItem('mf_producer_handle')
    if (saved) fetchProducer(saved)
  }, [])

  async function fetchProducer(handle: string) {
    const res = await fetch(`/api/producers?handle=${handle}`)
    const data = await res.json()
    if (data) { setProducer(data); localStorage.setItem('mf_producer_handle', data.handle) }
  }

  async function joinFeed(e: React.FormEvent) {
    e.preventDefault()
    setHandleError('')
    setJoiningAs(true)
    const res = await fetch('/api/producers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: handleInput }),
    })
    const data = await res.json()
    if (res.ok) {
      setProducer(data)
      localStorage.setItem('mf_producer_handle', data.handle)
    } else if (res.status === 409) {
      // Handle taken — try to fetch it (same person returning)
      await fetchProducer(handleInput.trim().toLowerCase().replace(/[^a-z0-9_]/g, ''))
      if (!producer) setHandleError('Handle taken — if that\'s you, it\'s been loaded')
    } else {
      setHandleError(data.error ?? 'Something went wrong')
    }
    setJoiningAs(false)
  }

  function getFeedback(versionId: string) {
    return feedbackState[versionId] ?? { tags: [], comment: '', timestamp: '', rating: 0, submitting: false, done: false, error: '' }
  }

  function setFeedback(versionId: string, patch: Partial<typeof feedbackState[string]>) {
    setFeedbackState(prev => ({ ...prev, [versionId]: { ...getFeedback(versionId), ...patch } }))
  }

  function toggleTag(versionId: string, tag: string) {
    const current = getFeedback(versionId).tags
    const next = current.includes(tag) ? current.filter(t => t !== tag) : [...current, tag]
    setFeedback(versionId, { tags: next })
  }

  async function submitFeedback(versionId: string) {
    if (!producer) return
    const fb = getFeedback(versionId)
    setFeedback(versionId, { submitting: true, error: '' })

    const res = await fetch('/api/community-feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version_id: versionId,
        producer_handle: producer.handle,
        tags: fb.tags,
        comment: fb.comment,
        timestamp_seconds: fb.timestamp ? Math.round(Number(fb.timestamp)) : null,
        rating: fb.rating || null,
      }),
    })
    const data = await res.json()
    if (res.ok) {
      setFeedback(versionId, { done: true, submitting: false })
      setProducer(p => p ? { ...p, credits: data.new_credits } : p)
    } else {
      setFeedback(versionId, { error: data.error ?? 'Failed to submit', submitting: false })
    }
  }

  function getCollab(versionId: string) {
    return collabState[versionId] ?? { open: false, message: '', submitting: false, done: false, error: '' }
  }

  function setCollab(versionId: string, patch: Partial<typeof collabState[string]>) {
    setCollabState(prev => ({ ...prev, [versionId]: { ...getCollab(versionId), ...patch } }))
  }

  async function submitCollabRequest(versionId: string) {
    if (!producer) return
    const collab = getCollab(versionId)
    setCollab(versionId, { submitting: true, error: '' })

    const res = await fetch('/api/collab-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version_id: versionId, producer_handle: producer.handle, message: collab.message }),
    })
    const data = await res.json()
    if (res.ok) {
      setCollab(versionId, { done: true, submitting: false })
    } else {
      setCollab(versionId, { error: data.error ?? 'Failed to send', submitting: false })
    }
  }

  const communityCount = versions.reduce((sum, v) => sum + v.mf_feedback.filter(f => f.is_community).length, 0)

  return (
    <div className="max-w-2xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">Producer Feedback</h1>
        <p className="text-[#555] text-sm mt-1">Give feedback, earn credits, get your tracks heard by real producers</p>
      </div>

      {/* Producer identity bar */}
      {producer ? (
        <div className="flex items-center justify-between bg-[#111] border border-[#1a1a1a] rounded-2xl px-4 py-3 mb-6">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-[#a78bfa]/20 flex items-center justify-center">
              <span className="text-xs font-bold text-[#a78bfa]">{producer.handle[0].toUpperCase()}</span>
            </div>
            <div>
              <p className="text-sm font-semibold text-white">{producer.handle}</p>
              <p className="text-xs text-[#555]">{communityCount} pieces of feedback in the community</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 bg-[#a78bfa]/10 border border-[#a78bfa]/20 rounded-full px-3 py-1">
            <Zap size={12} className="text-[#a78bfa]" />
            <span className="text-xs font-semibold text-[#a78bfa]">{producer.credits} credits</span>
          </div>
        </div>
      ) : (
        <div className="bg-[#111] border border-[#1a1a1a] rounded-2xl p-5 mb-6">
          <p className="text-sm font-semibold text-white mb-1">Join the feed</p>
          <p className="text-xs text-[#555] mb-4">Pick a producer handle. You start with 3 credits — give feedback to earn more.</p>
          <form onSubmit={joinFeed} className="flex gap-3">
            <div className="flex-1">
              <div className="flex items-center bg-[#0f0f0f] border border-[#222] rounded-xl px-3 py-2 focus-within:border-[#a78bfa]/40">
                <span className="text-[#444] text-sm mr-1">@</span>
                <input
                  value={handleInput}
                  onChange={e => setHandleInput(e.target.value)}
                  placeholder="yourhandle"
                  className="flex-1 bg-transparent text-sm text-white placeholder-[#333] focus:outline-none"
                />
              </div>
              {handleError && <p className="text-xs text-red-400 mt-1">{handleError}</p>}
            </div>
            <button
              type="submit"
              disabled={joiningAs || handleInput.length < 2}
              className="bg-[#a78bfa] hover:bg-[#9370f0] disabled:opacity-40 text-white text-sm font-semibold px-4 rounded-xl transition-colors"
            >
              {joiningAs ? 'Joining...' : 'Join'}
            </button>
          </form>
        </div>
      )}

      {/* How it works */}
      {!producer && (
        <div className="grid grid-cols-3 gap-3 mb-6">
          {[
            { icon: '🎧', title: 'Listen', desc: 'Hear what other producers are working on' },
            { icon: '💬', title: 'Give feedback', desc: 'Drop specific notes — earn 1 credit per track' },
            { icon: '⚡', title: 'Get heard', desc: 'Use credits to put your track on the feed' },
          ].map(step => (
            <div key={step.title} className="bg-[#111] border border-[#1a1a1a] rounded-xl p-4 text-center">
              <div className="text-2xl mb-2">{step.icon}</div>
              <p className="text-xs font-semibold text-white mb-1">{step.title}</p>
              <p className="text-[10px] text-[#555]">{step.desc}</p>
            </div>
          ))}
        </div>
      )}

      {/* Feed */}
      {versions.length === 0 ? (
        <div className="text-center py-20">
          <Music size={32} className="mx-auto text-[#222] mb-3" />
          <p className="text-[#555] text-sm">No tracks on the feed yet</p>
          <p className="text-[#333] text-xs mt-1">Submit a version from your project page to start</p>
        </div>
      ) : (
        <div className="space-y-4">
          {versions.map(version => {
            const project = version.mf_projects
            const communityFeedback = version.mf_feedback.filter(f => f.is_community)
            const fb = getFeedback(version.id)
            const isOpen = activeVersion === version.id
            const alreadyGave = producer && communityFeedback.some(f => f.producer_handle === producer.handle)

            return (
              <div key={version.id} className="bg-[#111] border border-[#1a1a1a] rounded-2xl overflow-hidden">
                {/* Track header */}
                <div className="p-4">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="relative w-14 h-14 rounded-xl overflow-hidden bg-[#1a1a1a] flex-shrink-0">
                      {project?.artwork_url ? (
                        <Image src={project.artwork_url} alt={project.title ?? ''} fill className="object-cover" />
                      ) : (
                        <div className="absolute inset-0 flex items-center justify-center text-[#333]">♪</div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-white truncate">{project?.title ?? 'Untitled'}</p>
                      <p className="text-xs text-[#555] mt-0.5">
                        {version.label ? `v${version.version_number} — ${version.label}` : `Version ${version.version_number}`}
                        {project?.genre && <span className="ml-2">{project.genre}</span>}
                        {project?.bpm && <span className="ml-2">{project.bpm} BPM</span>}
                        {version.duration_seconds && <span className="ml-2">{formatDuration(version.duration_seconds)}</span>}
                      </p>
                      {version.feedback_context && (
                        <p className="text-xs text-[#a78bfa] mt-1 italic">"{version.feedback_context}"</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-[#444]">
                      <MessageSquare size={12} />
                      {communityFeedback.length}
                    </div>
                  </div>

                  <WaveformPlayer audioUrl={version.audio_url} compact />
                </div>

                {/* Existing community feedback */}
                {communityFeedback.length > 0 && (
                  <div className="px-4 pb-4 space-y-2">
                    {communityFeedback.slice(0, 3).map(f => (
                      <div key={f.id} className="bg-[#0f0f0f] rounded-xl p-3">
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-xs font-medium text-[#a78bfa]">@{f.producer_handle}</span>
                          <div className="flex items-center gap-2">
                            {f.timestamp_seconds && (
                              <span className="text-[10px] text-[#444] flex items-center gap-1">
                                <Clock size={9} /> {formatDuration(f.timestamp_seconds)}
                              </span>
                            )}
                            {f.rating && (
                              <div className="flex gap-0.5">
                                {[1,2,3,4,5].map(s => (
                                  <Star key={s} size={9} className={s <= f.rating! ? 'text-[#a78bfa] fill-[#a78bfa]' : 'text-[#333]'} />
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                        {f.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1 mb-1.5">
                            {f.tags.map(tag => (
                              <span key={tag} className="text-[10px] bg-[#1a1a1a] text-[#888] px-2 py-0.5 rounded-full">{tag}</span>
                            ))}
                          </div>
                        )}
                        {f.comment && <p className="text-xs text-[#666]">{f.comment}</p>}
                      </div>
                    ))}
                  </div>
                )}

                {/* Feedback form */}
                {producer && !alreadyGave && (
                  <div className="border-t border-[#1a1a1a]">
                    {!isOpen ? (
                      <button
                        onClick={() => setActiveVersion(version.id)}
                        className="w-full py-3 text-xs text-[#555] hover:text-[#a78bfa] transition-colors flex items-center justify-center gap-2"
                      >
                        <MessageSquare size={12} />
                        Leave feedback · earn 1 credit
                      </button>
                    ) : fb.done ? (
                      <div className="py-4 text-center">
                        <p className="text-xs text-emerald-400">Feedback submitted — +1 credit earned</p>
                      </div>
                    ) : (
                      <div className="p-4 space-y-4">
                        {/* Tag picker */}
                        <div className="space-y-2">
                          {FEEDBACK_TAGS.map(cat => (
                            <div key={cat.category}>
                              <p className="text-[10px] text-[#444] uppercase tracking-wider mb-1.5">{cat.category}</p>
                              <div className="flex flex-wrap gap-1.5">
                                {cat.tags.map(tag => (
                                  <button
                                    key={tag}
                                    onClick={() => toggleTag(version.id, tag)}
                                    className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                                      fb.tags.includes(tag)
                                        ? 'bg-[#a78bfa]/20 border-[#a78bfa]/40 text-[#a78bfa]'
                                        : 'border-[#222] text-[#555] hover:border-[#333] hover:text-[#888]'
                                    }`}
                                  >
                                    {tag}
                                  </button>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>

                        {/* Timestamp + rating + comment */}
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block text-xs text-[#555] mb-1.5">Timestamp (optional)</label>
                            <input
                              type="text"
                              placeholder="e.g. 1:23"
                              value={fb.timestamp}
                              onChange={e => setFeedback(version.id, { timestamp: e.target.value })}
                              className="w-full bg-[#0f0f0f] border border-[#222] rounded-xl px-3 py-2 text-xs text-white placeholder-[#333] focus:outline-none focus:border-[#a78bfa]/40"
                            />
                          </div>
                          <div>
                            <label className="block text-xs text-[#555] mb-1.5">Overall rating</label>
                            <div className="flex gap-1 mt-0.5">
                              {[1,2,3,4,5].map(s => (
                                <button key={s} onClick={() => setFeedback(version.id, { rating: s })}>
                                  <Star size={18} className={s <= fb.rating ? 'text-[#a78bfa] fill-[#a78bfa]' : 'text-[#333] hover:text-[#555]'} />
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>

                        <textarea
                          value={fb.comment}
                          onChange={e => setFeedback(version.id, { comment: e.target.value })}
                          placeholder="Specific notes for the producer..."
                          rows={2}
                          className="w-full bg-[#0f0f0f] border border-[#222] rounded-xl px-3 py-2 text-xs text-white placeholder-[#333] focus:outline-none focus:border-[#a78bfa]/40 resize-none"
                        />

                        {fb.error && <p className="text-xs text-red-400">{fb.error}</p>}

                        <div className="flex gap-2">
                          <button
                            onClick={() => submitFeedback(version.id)}
                            disabled={fb.submitting || (fb.tags.length === 0 && !fb.comment.trim())}
                            className="flex-1 bg-[#a78bfa] hover:bg-[#9370f0] disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold rounded-xl py-2.5 transition-colors"
                          >
                            {fb.submitting ? 'Submitting...' : 'Submit feedback · +1 credit'}
                          </button>
                          <button
                            onClick={() => setActiveVersion(null)}
                            className="px-3 text-xs text-[#444] hover:text-white transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {alreadyGave && (
                  <div className="border-t border-[#1a1a1a] py-3 text-center">
                    <p className="text-xs text-[#444]">You gave feedback on this track</p>
                  </div>
                )}

                {/* Collab request */}
                {producer && (() => {
                  const collab = getCollab(version.id)
                  return (
                    <div className="border-t border-[#1a1a1a]">
                      {collab.done ? (
                        <div className="py-3 text-center">
                          <p className="text-xs text-emerald-400">Collab request sent</p>
                        </div>
                      ) : !collab.open ? (
                        <button
                          onClick={() => setCollab(version.id, { open: true })}
                          className="w-full py-3 text-xs text-[#444] hover:text-[#a78bfa] transition-colors flex items-center justify-center gap-2"
                        >
                          <GitMerge size={12} />
                          Request to collab
                        </button>
                      ) : (
                        <div className="p-4 space-y-3">
                          <div>
                            <p className="text-xs font-semibold text-white mb-1">Request to collaborate</p>
                            <p className="text-[10px] text-[#555]">Tell them what you bring to the table</p>
                          </div>
                          <textarea
                            value={collab.message}
                            onChange={e => setCollab(version.id, { message: e.target.value })}
                            placeholder="e.g. I produce melodic techno, I'd love to add a lead synth to this..."
                            rows={3}
                            className="w-full bg-[#0f0f0f] border border-[#222] rounded-xl px-3 py-2 text-xs text-white placeholder-[#333] focus:outline-none focus:border-[#a78bfa]/40 resize-none"
                          />
                          {collab.error && <p className="text-xs text-red-400">{collab.error}</p>}
                          <div className="flex gap-2">
                            <button
                              onClick={() => submitCollabRequest(version.id)}
                              disabled={collab.submitting}
                              className="flex-1 bg-[#a78bfa] hover:bg-[#9370f0] disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold rounded-xl py-2.5 transition-colors"
                            >
                              {collab.submitting ? 'Sending...' : 'Send request'}
                            </button>
                            <button
                              onClick={() => setCollab(version.id, { open: false })}
                              className="px-3 text-xs text-[#444] hover:text-white transition-colors"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })()}

                {!producer && (
                  <div className="border-t border-[#1a1a1a] py-3 text-center">
                    <p className="text-xs text-[#444]">Join the feed above to leave feedback</p>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
