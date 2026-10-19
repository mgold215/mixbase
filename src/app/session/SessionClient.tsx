'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { Check, Copy, Sparkles, TriangleAlert, X, Loader2, ListChecks } from 'lucide-react'
import CassetteIcon from '@/components/CassetteIcon'
import { usePlayer } from '@/contexts/PlayerContext'
import { audioProxyUrl, artworkProxyUrl } from '@/lib/supabase'
import { clock, type MixSession, type SessionNote, type SessionPlan, type SessionSong } from '@/lib/mix-session'

type SessionResponse = MixSession & { done_supported: boolean; text: string }

const PRIORITY_COLOR: Record<string, string> = { high: '#f87171', medium: '#fbbf24', low: 'var(--text-muted)' }

export default function SessionClient() {
  const { playUrl, seek, togglePlay, currentUrl, isPlaying } = usePlayer()
  const [session, setSession] = useState<SessionResponse | null>(null)
  const [loadError, setLoadError] = useState('')
  const [showDone, setShowDone] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  // 'all' or a project id while the assistant is working
  const [organizing, setOrganizing] = useState<string | null>(null)
  const [plan, setPlan] = useState<SessionPlan | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/mix-session')
      const data = await res.json().catch(() => null)
      if (!res.ok || !Array.isArray(data?.songs)) throw new Error(data?.error ?? 'Could not load your mix session.')
      setSession(data)
      setLoadError('')
      return data as SessionResponse
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load your mix session.')
      return null
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const notesById = useMemo(() => {
    const map = new Map<string, { note: SessionNote; song: SessionSong }>()
    for (const song of session?.songs ?? []) for (const note of song.notes) map.set(note.id, { note, song })
    return map
  }, [session])

  // Optimistic tick; the server is the record, so a failure rolls back.
  async function setDone(ids: string[], done: boolean) {
    if (!session) return
    const apply = (value: (n: SessionNote) => boolean) => setSession(s => s && {
      ...s,
      songs: s.songs.map(song => {
        const notes = song.notes.map(n => ids.includes(n.id) ? { ...n, done: value(n) } : n)
        const open = notes.filter(n => !n.done).length
        return { ...song, notes, open_count: open, done_count: notes.length - open }
      }),
    })
    const before = new Map(ids.map(id => [id, notesById.get(id)?.note.done ?? false]))
    apply(() => done)
    setError('')
    const results = await Promise.all(ids.map(id =>
      fetch(`/api/mix-session/notes/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ done }),
      }).then(async res => ({ id, ok: res.ok, error: (await res.json().catch(() => null))?.error as string | undefined }))
        .catch(() => ({ id, ok: false, error: 'Network error. Try again.' })),
    ))
    const failed = results.filter(r => !r.ok)
    if (failed.length) {
      const failedIds = new Set(failed.map(f => f.id))
      setSession(s => s && {
        ...s,
        songs: s.songs.map(song => {
          const notes = song.notes.map(n => failedIds.has(n.id) ? { ...n, done: before.get(n.id) ?? n.done } : n)
          const open = notes.filter(n => !n.done).length
          return { ...song, notes, open_count: open, done_count: notes.length - open }
        }),
      })
      setError(failed[0].error ?? 'Could not save that. Try again.')
    }
  }

  function playAt(song: SessionSong, seconds: number) {
    const url = audioProxyUrl(song.version.audio_url)
    if (currentUrl === url) {
      seek(seconds)
      if (!isPlaying) togglePlay()
    } else {
      playUrl(url, song.title, undefined, song.artwork_url ? artworkProxyUrl(song.artwork_url) : undefined, song.version.display_label, seconds)
    }
  }

  // Always copy the server's current text, so it matches what's ticked now.
  async function copyList() {
    setError('')
    const fresh = await load()
    if (!fresh) return
    try {
      await navigator.clipboard.writeText(fresh.text)
    } catch {
      const blob = new Blob([fresh.text], { type: 'text/plain' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = 'mix session.txt'
      a.click()
      URL.revokeObjectURL(a.href)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  async function organize(projectId: string | null) {
    setOrganizing(projectId ?? 'all')
    setError('')
    try {
      const res = await fetch('/api/mix-session/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(projectId ? { project_ids: [projectId] } : {}),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.plan) throw new Error(data?.error ?? 'The session assistant hit an error. Try again.')
      setPlan(data.plan)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The session assistant hit an error. Try again.')
    } finally {
      setOrganizing(null)
    }
  }

  if (loadError && !session) {
    return (
      <div className="rounded-xl p-4 text-sm" style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
        {loadError}{' '}
        <button onClick={() => void load()} className="underline" style={{ color: 'var(--accent)' }}>Try again</button>
      </div>
    )
  }
  if (!session) {
    return <div className="flex justify-center py-16"><Loader2 className="animate-spin" size={20} style={{ color: 'var(--accent)' }} /></div>
  }

  // Every song stays on screen — ticking a song's last note shouldn't make
  // its card vanish mid-session; it collapses to "All done" instead.
  const visibleSongs = session.songs
  const openCount = session.songs.reduce((n, s) => n + s.open_count, 0)
  const doneCount = session.songs.reduce((n, s) => n + s.done_count, 0)

  if (!session.songs.length) {
    return (
      <div className="rounded-xl p-8 text-center" style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}>
        <ListChecks size={28} className="mx-auto mb-3" style={{ color: 'var(--text-muted)', opacity: 0.5 }} />
        <p className="text-sm" style={{ color: 'var(--text)' }}>No notes on your current mixes yet.</p>
        <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
          Add notes while you listen in the Player, or share a mix to collect feedback.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs mr-auto" style={{ color: 'var(--text-secondary)' }}>
          <strong style={{ color: 'var(--text)' }}>{openCount}</strong> open · {doneCount} done
        </span>
        {doneCount > 0 && (
          <button
            onClick={() => setShowDone(v => !v)}
            className="px-3 py-1.5 text-xs rounded-lg"
            style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
          >
            {showDone ? 'Hide done' : `Show done (${doneCount})`}
          </button>
        )}
        <button
          onClick={() => void copyList()}
          disabled={openCount === 0}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg disabled:opacity-40"
          style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? 'Copied!' : 'Copy list'}
        </button>
        <button
          onClick={() => void organize(null)}
          disabled={openCount === 0 || organizing !== null}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg disabled:opacity-40"
          style={{ background: 'var(--accent)', color: '#080808' }}
        >
          {organizing === 'all' ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
          {organizing === 'all' ? 'Organizing…' : 'Organize with AI'}
        </button>
      </div>

      {!session.done_supported && (
        <p className="text-xs rounded-lg px-3 py-2" style={{ background: 'var(--surface)', color: 'var(--text-secondary)' }}>
          Ticking notes off isn&apos;t available yet — it switches on automatically within a few minutes.
        </p>
      )}
      {error && <p className="text-xs" style={{ color: '#f87171' }}>{error}</p>}
      {openCount === 0 && (
        <p className="text-sm text-center py-2" style={{ color: 'var(--text-muted)' }}>Every note is done. Nice.</p>
      )}

      {plan && (
        <PlanPanel
          plan={plan}
          notesById={notesById}
          canTick={session.done_supported}
          onDone={setDone}
          onPlay={playAt}
          onClose={() => setPlan(null)}
        />
      )}

      {visibleSongs.map(song => (
        <div key={song.project_id} className="rounded-xl overflow-hidden" style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}>
          <div className="flex items-center gap-3 p-3" style={{ borderBottom: '1px solid var(--border)' }}>
            <div className="relative w-10 h-10 rounded-md overflow-hidden shrink-0" style={{ background: 'var(--surface)' }}>
              {song.artwork_url ? (
                <Image src={artworkProxyUrl(song.artwork_url)} alt="" fill sizes="40px" className="object-cover" />
              ) : (
                <span className="absolute inset-0 flex items-center justify-center">
                  <CassetteIcon size={14} style={{ color: 'var(--text-muted)', opacity: 0.4 }} />
                </span>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <Link href={`/projects/${song.project_id}`} className="block text-sm font-semibold truncate hover:underline" style={{ color: 'var(--text)' }}>
                {song.title}
              </Link>
              <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {song.version.display_label} · {song.open_count ? `${song.open_count} open` : 'all done'}
              </p>
            </div>
            {song.open_count > 0 && (
              <button
                onClick={() => void organize(song.project_id)}
                disabled={organizing !== null}
                className="flex items-center gap-1 px-2.5 py-1 text-[11px] rounded-lg disabled:opacity-40"
                style={{ border: '1px solid var(--border)', color: 'var(--accent)' }}
                title="Organize this song's notes into a session order"
              >
                {organizing === song.project_id ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
                Organize
              </button>
            )}
          </div>
          <ul>
            {song.notes.filter(n => showDone || !n.done).map(note => (
              <NoteRow
                key={note.id}
                note={note}
                canTick={session.done_supported}
                onToggle={() => void setDone([note.id], !note.done)}
                onPlay={note.at_seconds != null ? () => playAt(song, note.at_seconds!) : undefined}
              />
            ))}
          </ul>
          {song.open_count === 0 && !showDone && (
            <p className="px-3 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>All done — upload the next mix when it&apos;s ready.</p>
          )}
        </div>
      ))}
    </div>
  )
}

function NoteRow({ note, canTick, onToggle, onPlay, compact = false }: {
  note: SessionNote
  canTick: boolean
  onToggle: () => void
  onPlay?: () => void
  compact?: boolean
}) {
  return (
    <li className={`flex items-start gap-2.5 ${compact ? 'py-1.5' : 'px-3 py-2.5'}`} style={compact ? undefined : { borderTop: '1px solid var(--border)' }}>
      {canTick && (
        <button
          onClick={onToggle}
          aria-label={note.done ? 'Mark as not done' : 'Mark as done'}
          aria-pressed={note.done}
          className="mt-0.5 w-[18px] h-[18px] rounded-full flex items-center justify-center shrink-0 transition-colors"
          style={{
            border: `1.5px solid ${note.done ? 'var(--accent)' : 'var(--text-muted)'}`,
            background: note.done ? 'var(--accent)' : 'transparent',
          }}
        >
          {note.done && <Check size={11} strokeWidth={3} color="#080808" />}
        </button>
      )}
      {onPlay ? (
        <button
          onClick={onPlay}
          className="mt-0.5 min-w-[42px] px-1.5 py-0.5 rounded-full text-[11px] text-center font-mono tabular-nums shrink-0"
          style={{ background: 'color-mix(in srgb, var(--accent) 14%, transparent)', color: 'var(--accent)' }}
          title="Play from here"
        >
          {clock(note.at_seconds!)}
        </button>
      ) : (
        <span className="mt-0.5 min-w-[42px] px-1.5 py-0.5 text-[11px] text-center shrink-0" style={{ color: 'var(--text-muted)' }} title="Whole-mix note">—</span>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm whitespace-pre-wrap break-words" style={{ color: note.done ? 'var(--text-muted)' : 'var(--text)', textDecoration: note.done ? 'line-through' : undefined }}>
          {note.comment}
        </p>
        {!note.own && (
          <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {note.reviewer}{note.rating ? ` · ${'★'.repeat(note.rating)}` : ''}
          </p>
        )}
      </div>
    </li>
  )
}

function PlanPanel({ plan, notesById, canTick, onDone, onPlay, onClose }: {
  plan: SessionPlan
  notesById: Map<string, { note: SessionNote; song: SessionSong }>
  canTick: boolean
  onDone: (ids: string[], done: boolean) => Promise<void>
  onPlay: (song: SessionSong, seconds: number) => void
  onClose: () => void
}) {
  return (
    <div className="rounded-xl p-4 space-y-4" style={{ background: 'var(--card-bg)', border: '1px solid color-mix(in srgb, var(--accent) 40%, transparent)' }}>
      <div className="flex items-start gap-2">
        <Sparkles size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--accent)' }} />
        <div className="flex-1">
          <p className="text-sm font-semibold" style={{ color: 'var(--text)' }}>Session order</p>
          {plan.overview && <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>{plan.overview}</p>}
        </div>
        <button onClick={onClose} aria-label="Close session order" style={{ color: 'var(--text-muted)' }}><X size={14} /></button>
      </div>

      {plan.songs.map(ps => (
        <div key={ps.project_id} className="space-y-2">
          <div>
            <p className="text-xs font-semibold" style={{ color: 'var(--text)' }}>{ps.title}</p>
            {ps.focus && <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{ps.focus}</p>}
          </div>
          <ol className="space-y-2">
            {ps.steps.map((step, i) => {
              const notes = step.note_ids.map(id => notesById.get(id)).filter((x): x is { note: SessionNote; song: SessionSong } => !!x)
              const allDone = notes.length > 0 && notes.every(x => x.note.done)
              const song = notes[0]?.song
              return (
                <li key={i} className="rounded-lg p-2.5" style={{ background: 'var(--surface)', opacity: allDone ? 0.55 : 1 }}>
                  <div className="flex items-start gap-2">
                    <span className="text-[11px] font-mono mt-0.5 w-4 shrink-0" style={{ color: 'var(--text-muted)' }}>{i + 1}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5 mb-1">
                        <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: PRIORITY_COLOR[step.priority] ?? PRIORITY_COLOR.medium }}>{step.priority_label}</span>
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>· {step.area_label}</span>
                        {step.at_seconds != null && song && (
                          <button
                            onClick={() => onPlay(song, step.at_seconds!)}
                            className="px-1.5 rounded-full text-[10px] font-mono"
                            style={{ background: 'color-mix(in srgb, var(--accent) 14%, transparent)', color: 'var(--accent)' }}
                            title="Play from here"
                          >
                            {clock(step.at_seconds)}
                          </button>
                        )}
                      </div>
                      <p className="text-sm" style={{ color: 'var(--text)', textDecoration: allDone ? 'line-through' : undefined }}>{step.action}</p>
                      {notes.length > 0 && (
                        <ul className="mt-1.5">
                          {notes.map(({ note, song: s }) => (
                            <NoteRow
                              key={note.id}
                              note={note}
                              compact
                              canTick={canTick}
                              onToggle={() => void onDone([note.id], !note.done)}
                              onPlay={note.at_seconds != null ? () => onPlay(s, note.at_seconds!) : undefined}
                            />
                          ))}
                        </ul>
                      )}
                    </div>
                    {canTick && notes.length > 0 && (
                      <button
                        onClick={() => void onDone(notes.map(x => x.note.id), !allDone)}
                        className="text-[11px] px-2 py-1 rounded-md shrink-0"
                        style={{ border: '1px solid var(--border)', color: allDone ? 'var(--text-muted)' : 'var(--accent)' }}
                      >
                        {allDone ? 'Undo' : 'Done'}
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ol>
          {ps.conflicts.length > 0 && (
            <div className="rounded-lg p-2.5 space-y-1" style={{ background: 'color-mix(in srgb, #fbbf24 10%, transparent)' }}>
              {ps.conflicts.map((c, i) => (
                <p key={i} className="flex gap-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
                  <TriangleAlert size={12} className="mt-0.5 shrink-0" style={{ color: '#fbbf24' }} />
                  {c}
                </p>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
