'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ListMusic, RefreshCw, Check, Copy, Download, ExternalLink, Trash2, Search, Droplets } from 'lucide-react'
import { audioProxyUrl } from '@/lib/supabase'
import { versionDisplayLabel } from '@/lib/mix-status'
import { formatReleaseDate } from '@/lib/release-plan'

// One released track (mb_library_tracks row + optional project join).
type LibraryTrack = {
  id: string
  title: string
  artist_name: string | null
  isrc: string | null
  upc: string | null
  release_title: string | null
  release_date: string | null
  release_type: string | null
  source: string | null
  source_url: string | null
  project_id: string | null
  mb_projects: { title: string } | null
}

// Row/sync source → display name. A third source (MusicBrainz) backs Deezer
// up, so the old `=== 'spotify' ? 'Spotify' : 'Deezer'` ternary would have
// mislabelled every MusicBrainz row.
const SOURCE_LABELS: Record<string, string> = {
  spotify: 'Spotify',
  deezer: 'Deezer',
  musicbrainz: 'MusicBrainz',
}
const sourceLabel = (source: string | null | undefined) =>
  (source && SOURCE_LABELS[source]) || 'the catalog source'

type VersionLite = { id: string; project_id: string; version_number: number; status: string; audio_url: string; audio_filename: string | null }

type Props = {
  initialTracks: LibraryTrack[]
  profile: { artist_name: string | null; spotify_url: string | null } | null
  projects: { id: string; title: string }[]
  versions: VersionLite[]
}

export default function LibraryClient({ initialTracks, profile, projects, versions }: Props) {
  const [tracks, setTracks] = useState(initialTracks)
  const [query, setQuery] = useState(() => profile?.spotify_url?.trim() || profile?.artist_name?.trim() || '')
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [findingId, setFindingId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  function flashError(msg: string) {
    setActionError(msg)
    setTimeout(() => setActionError(null), 4000)
  }

  async function copyValue(key: string, value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(key)
      setTimeout(() => setCopied(prev => (prev === key ? null : prev)), 1500)
    } catch {
      flashError('Clipboard unavailable in this browser.')
    }
  }

  // Sync pulls the discography server-side (Spotify when keys are configured,
  // otherwise Deezer with MusicBrainz behind it) and upserts it, then re-reads
  // the merged library.
  async function handleSync() {
    setSyncing(true)
    setSyncError(null)
    setSyncMsg(null)
    try {
      const res = await fetch('/api/library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ artist: query.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Sync failed')
      const listRes = await fetch('/api/library')
      if (listRes.ok) setTracks(await listRes.json())
      const via = sourceLabel(data.source)
      // Report what actually landed, not what was attempted. A run where most
      // writes failed used to render as a clean "Synced N tracks".
      if (data.failed > 0) {
        setSyncError(`${data.failed} of ${data.total} track${data.total === 1 ? '' : 's'} could not be saved${data.error ? ` — ${data.error}` : ''}. ${data.created} new, ${data.updated} updated.`)
      } else {
        setSyncMsg(`Synced ${data.total} track${data.total === 1 ? '' : 's'} for ${data.artistName} via ${via} — ${data.created} new, ${data.updated} updated.`)
      }
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : 'Sync failed — please try again')
    }
    setSyncing(false)
  }

  // Targeted MusicBrainz lookup for one track the sync couldn't cover.
  async function handleFindIsrc(track: LibraryTrack) {
    setFindingId(track.id)
    try {
      const res = await fetch('/api/library/find-isrc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ track_id: track.id }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Lookup failed')
      if (data.id) {
        setTracks(prev => prev.map(t => t.id === data.id ? data : t))
      } else {
        flashError(data.message ?? 'No ISRC found for this track.')
      }
    } catch (e) {
      flashError(e instanceof Error ? e.message : 'Lookup failed — please try again.')
    }
    setFindingId(null)
  }

  async function linkProject(trackId: string, projectId: string) {
    try {
      const res = await fetch(`/api/library/${trackId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId || null }),
      })
      if (!res.ok) throw new Error()
      const data = await res.json()
      setTracks(prev => prev.map(t => t.id === trackId ? data : t))
    } catch {
      flashError('Could not link the project — please try again.')
    }
  }

  async function deleteTrack(id: string) {
    if (!confirm('Remove this track from your library?')) return
    try {
      const res = await fetch(`/api/library/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error()
      setTracks(prev => prev.filter(t => t.id !== id))
    } catch {
      flashError('Could not remove the track — please try again.')
    }
  }

  // The "original file": the linked project's most polished version —
  // Released > Finished > latest (versions arrive newest-first).
  function originalFile(track: LibraryTrack): VersionLite | undefined {
    if (!track.project_id) return undefined
    const own = versions.filter(v => v.project_id === track.project_id)
    return own.find(v => v.status === 'Released') ?? own.find(v => v.status === 'Finished') ?? own[0]
  }

  const missingIsrcCount = tracks.filter(t => !t.isrc).length

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 pb-36 md:pb-10">
      {actionError && (
        <div
          className="fixed bottom-24 md:bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-xl text-sm font-medium shadow-lg"
          style={{ backgroundColor: 'var(--surface)', color: '#f87171', border: '1px solid var(--surface-2)' }}
          role="alert"
        >
          {actionError}
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between mb-8 gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text)] flex items-center gap-2.5">
            <ListMusic size={22} className="text-violet-400" />
            Released Library
          </h1>
          <p className="text-[var(--text-muted)] text-sm mt-0.5">Everything you&apos;ve put out — ISRCs, UPCs, dates, and original files for DistroKid uploads</p>
        </div>
        <Link
          href="/pipeline"
          className="flex items-center gap-2 text-sm font-semibold px-4 py-2.5 rounded-xl transition-colors text-sky-400 bg-sky-400/10 hover:bg-sky-400/20"
        >
          <Droplets size={16} />
          Release Pipeline
        </Link>
      </div>

      {/* Sync bar */}
      <div className="rounded-2xl p-5 mb-6" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}>
        <div className="flex gap-2">
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && query.trim() && !syncing) handleSync() }}
            placeholder="Artist name or Spotify artist link"
            className="flex-1 rounded-xl px-3 py-2 text-sm text-[var(--text)] focus:outline-none"
            style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)' }}
          />
          <button
            onClick={handleSync}
            disabled={syncing || !query.trim()}
            className="flex items-center gap-2 bg-[#2dd4bf] hover:bg-[#14b8a6] disabled:opacity-40 disabled:cursor-not-allowed text-[#0a0a0a] text-sm font-semibold px-5 rounded-xl transition-colors"
          >
            <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
            {syncing ? 'Syncing…' : 'Sync Catalog'}
          </button>
        </div>
        <p className="text-xs text-[var(--text-muted)] mt-2.5">
          Pulls your released songs from Spotify, Deezer, or MusicBrainz — re-run it any time a new drop goes live. Re-released tracks keep one row under their original drop.
        </p>
        {syncMsg && (
          <p className="text-xs text-emerald-400 bg-emerald-400/10 border border-emerald-400/20 rounded-xl px-3 py-2 mt-3">{syncMsg}</p>
        )}
        {syncError && (
          <p className="text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded-xl px-3 py-2 mt-3">{syncError}</p>
        )}
      </div>

      {/* Library */}
      {tracks.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}>
            <ListMusic size={24} className="text-[var(--text-muted)]" />
          </div>
          <p className="text-[var(--text-muted)]">No released tracks yet — sync your catalog above to fill the library.</p>
        </div>
      ) : (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
              {tracks.length} released track{tracks.length === 1 ? '' : 's'}
            </h2>
            {missingIsrcCount > 0 && (
              <span className="text-xs text-amber-400">{missingIsrcCount} missing ISRC</span>
            )}
          </div>
          <div className="space-y-2">
            {tracks.map(track => {
              const file = originalFile(track)
              return (
                <div key={track.id} className="rounded-2xl p-4" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}>
                  <div className="flex items-center gap-3 flex-wrap">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-[var(--text)] truncate">{track.title}</span>
                        {track.source_url && (
                          <a href={track.source_url} target="_blank" rel="noreferrer" title={`View on ${sourceLabel(track.source)}`} className="text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors flex-shrink-0">
                            <ExternalLink size={11} />
                          </a>
                        )}
                      </div>
                      <div className="flex items-center gap-2.5 mt-1 text-xs text-[var(--text-muted)] flex-wrap">
                        {track.release_title && track.release_title !== track.title && <span className="truncate">{track.release_title}</span>}
                        {track.release_date && <span>{formatReleaseDate(track.release_date)}</span>}
                        {track.release_type && <span className="uppercase text-[10px] tracking-wider">{track.release_type}</span>}
                      </div>
                    </div>

                    <div className="flex items-center gap-3 flex-shrink-0 flex-wrap">
                      {/* ISRC — the DistroKid reuse code */}
                      {track.isrc ? (
                        <button
                          onClick={() => copyValue(`${track.id}:isrc`, track.isrc!)}
                          title="Copy ISRC"
                          className="flex items-center gap-1.5 text-xs font-mono text-[var(--text-secondary)] hover:text-[var(--text)] px-2.5 py-1 rounded-lg transition-colors"
                          style={{ border: '1px solid var(--border)' }}
                        >
                          {track.isrc}
                          {copied === `${track.id}:isrc` ? <Check size={11} className="text-[#2dd4bf]" /> : <Copy size={11} />}
                        </button>
                      ) : (
                        <button
                          onClick={() => handleFindIsrc(track)}
                          disabled={findingId === track.id}
                          className="flex items-center gap-1.5 text-xs font-semibold text-amber-400 bg-amber-400/10 hover:bg-amber-400/20 disabled:opacity-40 px-2.5 py-1 rounded-lg transition-colors"
                          title="Search MusicBrainz for this track's ISRC"
                        >
                          <Search size={11} />
                          {findingId === track.id ? 'Searching…' : 'Find ISRC'}
                        </button>
                      )}

                      {/* UPC */}
                      {track.upc && (
                        <button
                          onClick={() => copyValue(`${track.id}:upc`, track.upc!)}
                          title="Copy UPC"
                          className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
                        >
                          UPC {track.upc}
                          {copied === `${track.id}:upc` ? <Check size={11} className="text-[#2dd4bf]" /> : <Copy size={11} />}
                        </button>
                      )}

                      {/* Original file from the matched project */}
                      {file ? (
                        <a
                          href={audioProxyUrl(file.audio_url)}
                          download={file.audio_filename ?? true}
                          title={`Download from “${track.mb_projects?.title ?? 'project'}” (${versionDisplayLabel(file)} · ${file.status})`}
                          className="flex items-center gap-1.5 text-xs text-[#2dd4bf] hover:text-[#14b8a6] transition-colors"
                        >
                          <Download size={12} />
                          Original file
                        </a>
                      ) : (
                        <select
                          value={track.project_id ?? ''}
                          onChange={e => linkProject(track.id, e.target.value)}
                          title="Link the mixBASE project that holds this track's original file"
                          className="rounded-lg px-2 py-1 text-xs text-[var(--text-muted)] focus:outline-none appearance-none max-w-36"
                          style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)' }}
                        >
                          <option value="" style={{ backgroundColor: 'var(--surface)' }}>Link project…</option>
                          {projects.map(p => (
                            <option key={p.id} value={p.id} style={{ backgroundColor: 'var(--surface)' }}>{p.title}</option>
                          ))}
                        </select>
                      )}

                      <button
                        onClick={() => deleteTrack(track.id)}
                        className="text-[var(--text-muted)] hover:text-red-400 transition-colors"
                        title="Remove from library"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
