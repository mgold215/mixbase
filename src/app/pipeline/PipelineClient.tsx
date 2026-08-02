'use client'

import { useState, type Dispatch, type FormEvent, type SetStateAction } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { Plus, ChevronDown, ChevronUp, Trash2, CalendarRange, ClipboardList, Check, Copy, Droplets, ExternalLink, Download, AlertTriangle, AlertCircle, ArrowUp, ArrowDown, X, ListMusic } from 'lucide-react'
import { displayArtworkUrl, audioProxyUrl, type Release } from '@/lib/supabase'
import { PRE_LAUNCH_ITEMS, LAUNCH_CAMPAIGN_ITEMS, releaseCompletionPercent, buildReleasePlan, getReleaseStatus, releaseDatePresets, formatReleaseDate, type ReleaseStatusKey } from '@/lib/release-plan'
import { distroKidTracklist, validateForDistroKid, distroKidFields, buildDistroKidSheet, waterfallDates } from '@/lib/distrokid'
import type { ArtistCatalog, CatalogRelease } from '@/lib/catalog'

// Tailwind classes for each release-status badge tone.
const STATUS_TONE: Record<ReleaseStatusKey, string> = {
  ready: 'text-emerald-400 bg-emerald-400/10',
  'at-risk': 'text-red-400 bg-red-400/10',
  'due-soon': 'text-amber-400 bg-amber-400/10',
}

type ReleaseWithProject = Release & {
  mb_projects: { title: string; artwork_url: string | null; finalized_artwork_url: string | null } | null
}
type VersionLite = { id: string; project_id: string; version_number: number; label: string | null; status: string; audio_url: string; audio_filename: string | null }

type Props = {
  initialReleases: ReleaseWithProject[]
  projects: { id: string; title: string }[]
  versions: VersionLite[]
  // Seeds the waterfall-form prefill + catalog search; null when unavailable.
  profile: { artist_name: string | null; spotify_url: string | null } | null
}

function daysUntil(dateStr: string | null): string | null {
  if (!dateStr) return null
  const diff = new Date(dateStr).getTime() - Date.now()
  const days = Math.ceil(diff / (1000 * 60 * 60 * 24))
  if (days < 0) return 'Released'
  if (days === 0) return 'Today'
  if (days === 1) return '1 day'
  return `${days} days`
}

// Copy text to the clipboard, falling back to a .md file download where the
// Clipboard API is unavailable (some webviews / non-secure contexts) so the
// export still works inside the iOS wrapper. Mirrors ProjectClient's helper.
async function copyMarkdown(md: string, filename: string, onCopied: () => void) {
  try {
    await navigator.clipboard.writeText(md)
    onCopied()
  } catch {
    const blob = new Blob([md], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }
}

// One inline-editable metadata field, controlled with a local draft.
//
// MetaInput and ReleaseCard live at MODULE scope on purpose. They used to be
// declared inside PipelineClient, which made each parent render produce a new
// component *type* — so React unmounted and remounted the whole card subtree
// on every state change. With the then-uncontrolled inputs, that destroyed the
// DOM node holding the user's draft: type in one field, Tab to the next, and
// when the first field's PATCH resolved the remount silently WIPED the
// characters just typed and stole focus. Stable identities fix the remount;
// the local draft state (legal now that the component survives renders) keeps
// typing intact while still re-adopting the canonical value on external
// changes (catalog backfill, the server's null→default coercion, save-error
// reverts) whenever the field isn't actively being edited.
function MetaInput({ release, field, label, placeholder, onSave }: {
  release: Release
  field: keyof Release & string
  label: string
  placeholder?: string
  onSave: (releaseId: string, field: string, value: string | null) => void
}) {
  const value = (release[field] as string | null) ?? ''
  const [draft, setDraft] = useState(value)
  const [editing, setEditing] = useState(false)
  // Adopt external canonical changes (catalog backfill, server coercion,
  // error reverts) via React's render-phase adjustment pattern — but never
  // while the user is mid-edit, or we'd overwrite their typing.
  const [prevValue, setPrevValue] = useState(value)
  if (prevValue !== value) {
    setPrevValue(value)
    if (!editing) setDraft(value)
  }
  return (
    <div>
      <label className="block text-[10px] text-[var(--text-muted)] uppercase tracking-wider mb-1">{label}</label>
      <input
        type="text"
        value={draft}
        placeholder={placeholder}
        onChange={e => setDraft(e.target.value)}
        onFocus={() => setEditing(true)}
        onBlur={e => {
          setEditing(false)
          const v = e.target.value.trim()
          if (v !== value) onSave(release.id, field, v || null)
          else setDraft(value)
        }}
        className="w-full rounded-lg px-2.5 py-1.5 text-sm text-[var(--text)] focus:outline-none"
        style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)' }}
      />
    </div>
  )
}

// Everything ReleaseCard needs from the board, passed explicitly so the
// component can live at module scope (see the MetaInput comment for why).
type ReleaseCardProps = {
  release: ReleaseWithProject
  releases: ReleaseWithProject[]
  versions: VersionLite[]
  todayStr: string
  expandedId: string | null
  setExpandedId: Dispatch<SetStateAction<string | null>>
  copiedPlanId: string | null
  setCopiedPlanId: Dispatch<SetStateAction<string | null>>
  copiedField: string | null
  setCopiedField: Dispatch<SetStateAction<string | null>>
  copyFieldValue: (key: string, value: string) => void
  updateField: (releaseId: string, field: string, value: string | boolean | null) => Promise<boolean>
  updateReleaseDate: (releaseId: string, value: string) => void
  toggleCheck: (releaseId: string, field: string, current: boolean) => void
  deleteRelease: (id: string) => void
}

function ReleaseCard({
  release, releases, versions, todayStr,
  expandedId, setExpandedId, copiedPlanId, setCopiedPlanId, copiedField, setCopiedField,
  copyFieldValue, updateField, updateReleaseDate, toggleCheck, deleteRelease,
}: ReleaseCardProps) {
  const isExpanded = expandedId === release.id
  const pct = releaseCompletionPercent(release)
  const countdown = daysUntil(release.release_date)
  // Readiness judgment (At risk / Due soon / Ready) — null when nothing to flag.
  const status = getReleaseStatus(release, todayStr)
  const copiedPlan = copiedPlanId === release.id

  // ── DistroKid prep inputs ──
  // The tracklist for this drop (new track + earlier waterfall tracks),
  // the file that would be uploaded (explicit link, else the project's
  // latest version — matching the create form's "Latest / none" semantics),
  // and the readiness issues derived from all of it.
  const wfTotal = release.waterfall_group_id ? releases.filter(r => r.waterfall_group_id === release.waterfall_group_id).length : 0
  const tracklist = distroKidTracklist(release, releases)
  const finalVersion = versions.find(v => v.id === release.final_version_id)
    ?? (release.project_id ? versions.find(v => v.project_id === release.project_id) : undefined)
  const artworkUrl = displayArtworkUrl(release.mb_projects ?? {})
  const issues = validateForDistroKid(release, { hasFinalVersion: !!finalVersion, hasArtwork: !!artworkUrl, tracklist, todayStr })
  const dkFields = distroKidFields(release, tracklist)
  const copiedSheet = copiedField === `${release.id}:__sheet`

  const copySheet = () =>
    copyMarkdown(
      buildDistroKidSheet(release, tracklist, issues, release.mb_projects?.title ?? null),
      `${release.title} — DistroKid sheet.md`,
      () => {
        setCopiedField(`${release.id}:__sheet`)
        setTimeout(() => setCopiedField(prev => (prev === `${release.id}:__sheet` ? null : prev)), 2000)
      },
    )

  // Export the whole release plan — checklist state, date, metadata, notes —
  // as one Markdown doc the musician can paste into a distributor checklist,
  // a collaborator message, or release notes.
  const copyPlan = () =>
    copyMarkdown(
      buildReleasePlan(release, release.mb_projects?.title ?? null),
      `${release.title} — release plan.md`,
      () => {
        setCopiedPlanId(release.id)
        setTimeout(() => setCopiedPlanId(prev => (prev === release.id ? null : prev)), 2000)
      },
    )

  return (
    <div className="rounded-2xl overflow-hidden" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}>
      {/* Header */}
      <div
        className="flex items-center gap-4 p-4 cursor-pointer hover:bg-[var(--surface-2)] transition-colors"
        onClick={() => setExpandedId(isExpanded ? null : release.id)}
      >
        {/* Artwork / icon */}
        <div className="relative w-12 h-12 rounded-xl overflow-hidden bg-[var(--surface-2)] flex-shrink-0">
          {displayArtworkUrl(release.mb_projects ?? {}) ? (
            <Image src={displayArtworkUrl(release.mb_projects ?? {})!} alt={release.title} fill className="object-cover" />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-[var(--text-muted)] text-lg">♪</div>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-[var(--text)] truncate">{release.title}</span>
            {release.mb_projects && (
              release.project_id
                ? <Link href={`/projects/${release.project_id}`} onClick={e => e.stopPropagation()} className="text-xs text-[var(--text-muted)] hover:text-[var(--accent)] truncate transition-colors">← {release.mb_projects.title}</Link>
                : <span className="text-xs text-[var(--text-muted)] truncate">← {release.mb_projects.title}</span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs text-[var(--text-muted)]">
            {release.release_date && (
              <span>{formatReleaseDate(release.release_date)}</span>
            )}
            {release.label && <span>{release.label}</span>}
            {release.genre && <span>{release.genre}</span>}
          </div>
        </div>

        <div className="flex items-center gap-3 flex-shrink-0">
          {/* Waterfall membership — which drop of the run this release is */}
          {release.waterfall_group_id && release.waterfall_position && (
            <span className="text-xs px-2 py-0.5 rounded-full font-medium flex items-center gap-1 text-sky-400 bg-sky-400/10">
              <Droplets size={10} />
              Drop {release.waterfall_position}/{wfTotal}
            </span>
          )}

          {/* Readiness status — only rendered when there's something to flag */}
          {status && (
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_TONE[status.key]}`}>
              {status.label}
            </span>
          )}

          {/* Countdown */}
          {countdown && (
            <span className={`text-xs px-2 py-0.5 rounded-full ${
              countdown === 'Today' ? 'text-[var(--accent)] bg-[var(--accent-dim)]' :
              countdown === 'Released' ? 'text-emerald-400 bg-emerald-400/10' :
              'text-[var(--text-muted)] bg-[var(--surface-2)]'
            }`}>
              {countdown}
            </span>
          )}

          {/* Health score */}
          <div className="flex items-center gap-1.5">
            <div className="w-16 h-1.5 bg-[var(--surface-2)] rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${pct}%`,
                  backgroundColor: pct === 100 ? '#34d399' : pct >= 50 ? '#2dd4bf' : '#555'
                }}
              />
            </div>
            <span className="text-xs text-[var(--text-muted)]">{pct}%</span>
          </div>

          {isExpanded ? <ChevronUp size={14} className="text-[var(--text-muted)]" /> : <ChevronDown size={14} className="text-[var(--text-muted)]" />}
        </div>
      </div>

      {/* Expanded */}
      {isExpanded && (
        <div className="px-4 pb-5 pt-2 space-y-5" style={{ borderTop: '1px solid var(--border)' }}>
          {/* Release date — editable inline so undated releases can be scheduled later */}
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <label className="text-xs text-[var(--text-muted)] uppercase tracking-wider">Release Date</label>
              <input
                type="date"
                value={release.release_date ?? ''}
                onChange={e => updateReleaseDate(release.id, e.target.value)}
                className="rounded-xl px-3 py-1.5 text-sm text-[var(--text)] focus:outline-none [color-scheme:dark]"
                style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)' }}
              />
              {!release.release_date && (
                <span className="text-xs text-[var(--text-muted)]">Set a date to organize this release</span>
              )}
            </div>
            {/* Quick-pick Friday release dates — drops conventionally land on a
                Friday and DSP playlist pitching wants a few weeks' lead. Each
                writes through the same hardened updateReleaseDate() (snapshot →
                PATCH → revert + toast on failure). */}
            <div className="flex flex-wrap items-center gap-1.5">
              {releaseDatePresets(todayStr).map(p => {
                const active = release.release_date === p.date
                return (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => updateReleaseDate(release.id, p.date)}
                    title={p.friendly}
                    className={`rounded-full px-2.5 py-1 text-xs transition-colors ${active ? 'text-[#2dd4bf] bg-[#2dd4bf]/10' : 'text-[var(--text-muted)] hover:text-[var(--text)]'}`}
                    style={{ border: '1px solid var(--border)' }}
                  >
                    {p.label}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-6">
            {/* Pre-Launch checklist */}
            <div>
              <p className="text-xs text-[var(--text-muted)] mb-3 uppercase tracking-wider">Pre-Launch</p>
              <div className="space-y-2">
                {PRE_LAUNCH_ITEMS.map(item => (
                  <label key={item.key} className="flex items-center gap-2.5 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={!!release[item.key as keyof Release]}
                      onChange={() => toggleCheck(release.id, item.key, !!release[item.key as keyof Release])}
                      className="accent-[#2dd4bf] w-3.5 h-3.5 flex-shrink-0"
                    />
                    <span className={`text-sm transition-colors ${release[item.key as keyof Release] ? 'text-[var(--text-muted)] line-through' : 'text-[var(--text-secondary)] group-hover:text-[var(--text)]'}`}>
                      {item.label}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            {/* Post-Launch campaign */}
            <div>
              <p className="text-xs text-[var(--text-muted)] mb-3 uppercase tracking-wider">Launch Campaign</p>
              <div className="space-y-2">
                {LAUNCH_CAMPAIGN_ITEMS.map(item => (
                  <label key={item.key} className="flex items-center gap-2.5 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={!!release[item.key as keyof Release]}
                      onChange={() => toggleCheck(release.id, item.key, !!release[item.key as keyof Release])}
                      className="accent-[#2dd4bf] w-3.5 h-3.5 flex-shrink-0"
                    />
                    <span className="flex flex-col min-w-0">
                      <span className={`text-sm transition-colors ${release[item.key as keyof Release] ? 'text-[var(--text-muted)] line-through' : 'text-[var(--text-secondary)] group-hover:text-[var(--text)]'}`}>
                        {item.label}
                      </span>
                      <span className="text-[10px] text-[var(--text-muted)] opacity-50 leading-tight">{item.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </div>

          {/* Release details — every field DistroKid's upload form asks for,
              editable inline (saved on blur). This is the data the prep
              panel below validates and exports. */}
          <div>
            <p className="text-xs text-[var(--text-muted)] mb-3 uppercase tracking-wider">Release Details</p>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <MetaInput onSave={updateField} release={release} field="artist_name" label="Artist name" placeholder="As on your Spotify profile" />
              <MetaInput onSave={updateField} release={release} field="featured_artists" label="Featured artists" placeholder="feat. …" />
              <MetaInput onSave={updateField} release={release} field="songwriters" label="Songwriters (legal names)" placeholder="Jane Doe, John Smith" />
              <MetaInput onSave={updateField} release={release} field="producers" label="Producers" placeholder="Optional" />
              <MetaInput onSave={updateField} release={release} field="genre" label="Primary genre" placeholder="e.g. Afrobeats" />
              <MetaInput onSave={updateField} release={release} field="secondary_genre" label="Secondary genre" placeholder="Optional" />
              <MetaInput onSave={updateField} release={release} field="language" label="Language" placeholder="English" />
              <MetaInput onSave={updateField} release={release} field="version_info" label="Version" placeholder="Radio Edit, Remix…" />
              <MetaInput onSave={updateField} release={release} field="label" label="Record label" placeholder="e.g. Independent" />
              <MetaInput onSave={updateField} release={release} field="isrc" label="ISRC (this track)" placeholder="Paste after DistroKid assigns it" />
              <MetaInput onSave={updateField} release={release} field="upc" label="UPC" placeholder="Blank = DistroKid assigns" />
              <div>
                <label className="block text-[10px] text-[var(--text-muted)] uppercase tracking-wider mb-1">Release type</label>
                <select
                  value={release.release_type}
                  onChange={e => updateField(release.id, 'release_type', e.target.value)}
                  className="w-full rounded-lg px-2.5 py-1.5 text-sm text-[var(--text)] focus:outline-none appearance-none"
                  style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)' }}
                >
                  <option value="single" style={{ backgroundColor: 'var(--surface)' }}>Single</option>
                  <option value="ep" style={{ backgroundColor: 'var(--surface)' }}>EP</option>
                  <option value="album" style={{ backgroundColor: 'var(--surface)' }}>Album</option>
                </select>
              </div>
            </div>
            <div className="flex gap-5 mt-3">
              <label className="flex items-center gap-2 cursor-pointer text-sm text-[var(--text-secondary)]">
                <input type="checkbox" checked={release.explicit} onChange={() => updateField(release.id, 'explicit', !release.explicit)} className="accent-[#2dd4bf] w-3.5 h-3.5" />
                Explicit lyrics
              </label>
              <label className="flex items-center gap-2 cursor-pointer text-sm text-[var(--text-secondary)]">
                <input type="checkbox" checked={release.instrumental} onChange={() => updateField(release.id, 'instrumental', !release.instrumental)} className="accent-[#2dd4bf] w-3.5 h-3.5" />
                Instrumental
              </label>
            </div>
          </div>

          {/* DistroKid prep — readiness issues, this drop's tracklist, and
              every form answer as a click-to-copy chip in upload order. */}
          <div className="rounded-xl p-4 space-y-4" style={{ backgroundColor: 'var(--surface-2)' }}>
            <div className="flex items-center justify-between flex-wrap gap-2">
              <p className="text-xs text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-1.5">
                <Droplets size={12} />
                DistroKid Prep
              </p>
              <div className="flex items-center gap-4 flex-wrap">
                <button onClick={copySheet} className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text)] transition-colors">
                  {copiedSheet ? <Check size={12} /> : <ClipboardList size={12} />}
                  {copiedSheet ? 'Copied!' : 'Copy sheet'}
                </button>
                {finalVersion && (
                  <a
                    href={audioProxyUrl(finalVersion.audio_url)}
                    download={finalVersion.audio_filename ?? true}
                    className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
                  >
                    <Download size={12} />
                    Final mix
                  </a>
                )}
                {artworkUrl && (
                  <a href={artworkUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text)] transition-colors">
                    <ExternalLink size={12} />
                    Artwork
                  </a>
                )}
                <a
                  href="https://distrokid.com/new/"
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 text-xs font-semibold text-[#2dd4bf] hover:text-[#14b8a6] transition-colors"
                >
                  <ExternalLink size={12} />
                  Open DistroKid
                </a>
              </div>
            </div>

            {/* Readiness — errors block a clean submission, warnings are conventions */}
            {issues.length > 0 ? (
              <div className="space-y-1.5">
                {issues.map((iss, i) => (
                  <div key={i} className={`flex items-start gap-2 text-xs ${iss.level === 'error' ? 'text-red-400' : 'text-amber-400'}`}>
                    {iss.level === 'error' ? <AlertCircle size={12} className="mt-0.5 flex-shrink-0" /> : <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />}
                    <span>{iss.message}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-emerald-400 flex items-center gap-1.5">
                <Check size={12} />
                Everything DistroKid needs is ready — copy the sheet and submit.
              </p>
            )}

            {/* Waterfall tracklist for this drop */}
            {tracklist.length > 1 && (
              <div>
                <p className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider mb-1.5">Tracklist for this drop</p>
                <div className="space-y-1">
                  {tracklist.map(t => (
                    <div key={t.releaseId} className="flex items-center gap-2 text-xs">
                      <span className="text-[var(--text-muted)] w-4 text-right">{t.trackNumber}.</span>
                      <span className="text-[var(--text)] truncate">{t.title}{t.versionInfo ? ` (${t.versionInfo})` : ''}</span>
                      {t.isNew ? (
                        <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium text-[#2dd4bf] bg-[#2dd4bf]/10 flex-shrink-0">NEW</span>
                      ) : (
                        <span className={`px-1.5 py-0.5 rounded-full text-[10px] flex-shrink-0 ${t.isrc ? 'text-[var(--text-muted)] bg-[var(--surface)]' : 'text-red-400 bg-red-400/10'}`}>
                          {t.isrc ? `reuse ISRC ${t.isrc}` : 'ISRC missing'}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Click-to-copy form answers, in DistroKid's upload order */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5">
              {dkFields.map(f => {
                const key = `${release.id}:${f.label}`
                const copied = copiedField === key
                return (
                  <button
                    key={f.label}
                    type="button"
                    onClick={() => f.value && copyFieldValue(key, f.value)}
                    disabled={!f.value}
                    title={f.value ? 'Click to copy' : 'Not set yet'}
                    className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors disabled:opacity-40 hover:bg-[var(--surface)]"
                    style={{ border: '1px solid var(--border)' }}
                  >
                    <span className="min-w-0 flex items-baseline gap-1.5">
                      <span className="text-[var(--text-muted)] flex-shrink-0">{f.label}</span>
                      <span className="text-[var(--text)] truncate">{f.value || '—'}</span>
                    </span>
                    {copied ? <Check size={11} className="text-[#2dd4bf] flex-shrink-0" /> : <Copy size={11} className="text-[var(--text-muted)] flex-shrink-0" />}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Notes */}
          {release.notes && (
            <div className="rounded-xl p-3" style={{ backgroundColor: 'var(--surface-2)' }}>
              <p className="text-xs text-[var(--text-muted)] mb-1">Notes</p>
              <p className="text-sm text-[var(--text-secondary)]">{release.notes}</p>
            </div>
          )}

          <div className="flex justify-end gap-4">
            <button
              onClick={copyPlan}
              className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
            >
              {copiedPlan ? <Check size={12} /> : <ClipboardList size={12} />}
              {copiedPlan ? 'Copied!' : 'Copy plan'}
            </button>
            <button
              onClick={() => deleteRelease(release.id)}
              className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-red-400 transition-colors"
            >
              <Trash2 size={12} />
              Delete release
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function PipelineClient({ initialReleases, projects, versions, profile }: Props) {
  const [releases, setReleases] = useState(initialReleases)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ title: '', release_date: '', project_id: '', final_version_id: '', genre: '', label: '', isrc: '', notes: '' })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  // Which release just had its plan copied — drives the per-card "Copied!" flash.
  // Held here rather than in ReleaseCard so the flash survives collapsing or
  // re-sorting the board mid-flash.
  const [copiedPlanId, setCopiedPlanId] = useState<string | null>(null)
  // Transient error toast for failed mutations (date edit, delete) so they
  // don't fail silently and leave the UI out of sync with the DB.
  const [actionError, setActionError] = useState<string | null>(null)
  function flashError(msg: string) {
    setActionError(msg)
    setTimeout(() => setActionError(null), 4000)
  }

  function setField(field: string, value: string) {
    setForm(prev => {
      const next = { ...prev, [field]: value }
      // Clear the picked version whenever the project changes.
      if (field === 'project_id') next.final_version_id = ''
      return next
    })
  }

  // Only show the versions belonging to the currently-selected project.
  const projectVersions = form.project_id
    ? versions.filter(v => v.project_id === form.project_id)
    : []

  async function handleCreate(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setSaveError(null)
    try {
      const res = await fetch('/api/releases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: form.title,
          release_date: form.release_date || null,
          project_id: form.project_id || null,
          final_version_id: form.final_version_id || null,
          genre: form.genre || null,
          label: form.label || null,
          isrc: form.isrc || null,
          notes: form.notes || null,
        }),
      })
      const data = await res.json()
      if (res.ok) {
        setReleases(prev => [{ ...data, mb_projects: projects.find(p => p.id === data.project_id) ? { title: projects.find(p => p.id === data.project_id)!.title, artwork_url: null, finalized_artwork_url: null } : null }, ...prev])
        setShowForm(false)
        setForm({ title: '', release_date: '', project_id: '', final_version_id: '', genre: '', label: '', isrc: '', notes: '' })
      } else {
        setSaveError(data.error ?? 'Failed to create release')
      }
    } catch {
      setSaveError('Network error — please try again')
    }
    setSaving(false)
  }

  async function toggleCheck(releaseId: string, field: string, current: boolean) {
    const res = await fetch(`/api/releases/${releaseId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: !current }),
    })
    if (res.ok) {
      setReleases(prev => prev.map(r => r.id === releaseId ? { ...r, [field]: !current } : r))
    }
  }

  async function updateReleaseDate(releaseId: string, value: string) {
    const next = value || null
    // Snapshot the current date so we can roll back if the PATCH fails.
    const prevDate = releases.find(r => r.id === releaseId)?.release_date ?? null
    setReleases(prev => prev.map(r => r.id === releaseId ? { ...r, release_date: next } : r))
    try {
      const res = await fetch(`/api/releases/${releaseId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ release_date: next }),
      })
      if (!res.ok) throw new Error('update failed')
    } catch {
      setReleases(prev => prev.map(r => r.id === releaseId ? { ...r, release_date: prevDate } : r))
      flashError('Could not update the release date — reverted.')
    }
  }

  // Save metadata fields (details editor, catalog backfill). Merges the
  // server's canonical row back into state — the PATCH response has every
  // column but not the mb_projects join, so the spread keeps the joined
  // artwork/title intact. Returns whether the save landed.
  async function updateFields(releaseId: string, patch: Record<string, string | boolean | null>): Promise<boolean> {
    try {
      const res = await fetch(`/api/releases/${releaseId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!res.ok) throw new Error('update failed')
      const data = await res.json()
      setReleases(prev => prev.map(r => r.id === releaseId ? { ...r, ...data } : r))
      return true
    } catch {
      flashError('Could not save — please try again.')
      return false
    }
  }
  function updateField(releaseId: string, field: string, value: string | boolean | null) {
    return updateFields(releaseId, { [field]: value })
  }

  // Which DistroKid field chip was just copied — keyed "releaseId:label" and
  // held here for the same board-survival reason as copiedPlanId.
  const [copiedField, setCopiedField] = useState<string | null>(null)
  async function copyFieldValue(key: string, value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedField(key)
      setTimeout(() => setCopiedField(prev => (prev === key ? null : prev)), 1500)
    } catch {
      flashError('Clipboard unavailable — copy the full sheet instead.')
    }
  }

  async function deleteRelease(id: string) {
    if (!confirm('Delete this release?')) return
    // Only drop the release from the UI once the server confirms the delete,
    // so a failed request doesn't make it look deleted when it still exists.
    try {
      const res = await fetch(`/api/releases/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('delete failed')
      setReleases(prev => prev.filter(r => r.id !== id))
    } catch {
      flashError('Could not delete the release — please try again.')
    }
  }

  // Separate upcoming vs past, then order each group chronologically.
  // Upcoming: nearest first, undated releases at the end.
  // Past: most recent first, so the latest release sits at the top.
  const now = new Date()
  const todayMs = now.setHours(0, 0, 0, 0)
  // Local calendar date as YYYY-MM-DD, fed to the pure getReleaseStatus() so the
  // "At risk / Due soon / Ready" judgment matches the user's own notion of today.
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const upcoming = releases
    .filter(r => !r.release_date || new Date(r.release_date).getTime() >= todayMs)
    .sort((a, b) => {
      if (!a.release_date && !b.release_date) return 0
      if (!a.release_date) return 1
      if (!b.release_date) return -1
      return new Date(a.release_date).getTime() - new Date(b.release_date).getTime()
    })
  const past = releases
    .filter(r => r.release_date && new Date(r.release_date).getTime() < todayMs)
    .sort((a, b) => new Date(b.release_date!).getTime() - new Date(a.release_date!).getTime())

  // Everything the module-scope ReleaseCard needs from this board, bundled so
  // the two call sites below stay in lockstep.
  const cardProps = {
    releases, versions, todayStr,
    expandedId, setExpandedId, copiedPlanId, setCopiedPlanId, copiedField, setCopiedField,
    copyFieldValue, updateField, updateReleaseDate, toggleCheck, deleteRelease,
  }

  // ── Waterfall planner ──────────────────────────────────────────────────────
  // Plans a whole run at once: ordered tracks + start Friday + cadence →
  // POST /api/releases/waterfall creates one linked, dated release per track.
  type WfTrack = { title: string; project_id: string; final_version_id: string }
  const emptyWfTrack: WfTrack = { title: '', project_id: '', final_version_id: '' }
  const [showWaterfall, setShowWaterfall] = useState(false)

  // Prefill the run's shared fields from the profile and, failing that, the
  // most recently created release that has each field — artist, label, and
  // songwriters rarely change between runs, so a new waterfall starts filled.
  const recentFirst = [...initialReleases].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
  const lastWith = (pick: (r: Release) => string | null) =>
    recentFirst.map(pick).find(v => v && v.trim())?.trim() ?? ''
  const [wfShared, setWfShared] = useState(() => ({
    artist_name: profile?.artist_name?.trim() || lastWith(r => r.artist_name),
    genre: lastWith(r => r.genre),
    label: lastWith(r => r.label),
    songwriters: lastWith(r => r.songwriters),
    start_date: '',
    cadence_days: 28,
  }))
  const [wfTracks, setWfTracks] = useState<WfTrack[]>([{ ...emptyWfTrack }, { ...emptyWfTrack }])
  const [wfSaving, setWfSaving] = useState(false)
  const [wfError, setWfError] = useState<string | null>(null)

  // Live schedule preview so the dates are visible before anything is created.
  const wfPreviewDates = wfShared.start_date ? waterfallDates(wfShared.start_date, wfTracks.length, wfShared.cadence_days) : []

  function setWfTrack(index: number, patch: Partial<WfTrack>) {
    setWfTracks(prev => prev.map((t, i) => {
      if (i !== index) return t
      const next = { ...t, ...patch }
      // Picking a project auto-fills an empty title and clears a stale version.
      if (patch.project_id !== undefined && patch.project_id !== t.project_id) {
        next.final_version_id = ''
        if (!t.title.trim()) next.title = projects.find(p => p.id === patch.project_id)?.title ?? t.title
      }
      return next
    }))
  }

  function moveWfTrack(index: number, dir: -1 | 1) {
    setWfTracks(prev => {
      const j = index + dir
      if (j < 0 || j >= prev.length) return prev
      const next = [...prev]
      ;[next[index], next[j]] = [next[j], next[index]]
      return next
    })
  }

  async function handleCreateWaterfall(e: FormEvent) {
    e.preventDefault()
    setWfSaving(true)
    setWfError(null)
    try {
      const res = await fetch('/api/releases/waterfall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tracks: wfTracks.map(t => ({
            title: t.title,
            project_id: t.project_id || null,
            final_version_id: t.final_version_id || null,
          })),
          start_date: wfShared.start_date,
          cadence_days: wfShared.cadence_days,
          artist_name: wfShared.artist_name,
          genre: wfShared.genre,
          label: wfShared.label,
          songwriters: wfShared.songwriters,
        }),
      })
      const data = await res.json()
      if (res.ok) {
        // Attach the joined-project shape the board expects, same as handleCreate.
        const created = (data as Release[]).map(r => ({
          ...r,
          mb_projects: r.project_id && projects.find(p => p.id === r.project_id)
            ? { title: projects.find(p => p.id === r.project_id)!.title, artwork_url: null, finalized_artwork_url: null }
            : null,
        }))
        setReleases(prev => [...created, ...prev])
        setShowWaterfall(false)
        setWfShared({ artist_name: '', genre: '', label: '', songwriters: '', start_date: '', cadence_days: 28 })
        setWfTracks([{ ...emptyWfTrack }, { ...emptyWfTrack }])
      } else {
        setWfError(data.error ?? 'Failed to plan the waterfall')
      }
    } catch {
      setWfError('Network error — please try again')
    }
    setWfSaving(false)
  }

  // ── Catalog import (Spotify / Deezer) ─────────────────────────────────────
  // Pulls the artist's released discography — dates, UPCs, per-track ISRCs —
  // so past releases can be imported and waterfall re-releases reuse the
  // right ISRCs. Public catalog data via /api/catalog; no account linking.
  const [showImport, setShowImport] = useState(false)
  const [importQuery, setImportQuery] = useState(
    () => profile?.spotify_url?.trim() || profile?.artist_name?.trim() || lastWith(r => r.artist_name),
  )
  const [importLoading, setImportLoading] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [catalog, setCatalog] = useState<ArtistCatalog | null>(null)
  const [importingTitle, setImportingTitle] = useState<string | null>(null)

  async function fetchCatalog() {
    setImportLoading(true)
    setImportError(null)
    try {
      const res = await fetch(`/api/catalog?artist=${encodeURIComponent(importQuery.trim())}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Catalog lookup failed')
      setCatalog(data)
    } catch (e) {
      setCatalog(null)
      setImportError(e instanceof Error ? e.message : 'Catalog lookup failed — please try again')
    }
    setImportLoading(false)
  }

  // A catalog release already on the board, matched by title (case-insensitive).
  function matchExisting(title: string): ReleaseWithProject | undefined {
    const t = title.trim().toLowerCase()
    return releases.find(r => r.title.trim().toLowerCase() === t)
  }

  // Import a released drop as a pipeline row: metadata filled from the source
  // and every pre-launch box ticked (it's already out — the value is having
  // its ISRC/UPC on file for the next waterfall run).
  async function importCatalogRelease(rel: CatalogRelease) {
    setImportingTitle(rel.title)
    try {
      const firstIsrc = rel.tracks[0]?.isrc ?? null
      const trackNotes = rel.tracks.length > 1
        ? 'Imported track ISRCs:\n' + rel.tracks.map(t => `${t.trackNumber}. ${t.title} — ${t.isrc ?? '—'}`).join('\n')
        : null
      const res = await fetch('/api/releases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: rel.title,
          // The DB column is a date — sources sometimes report year-only precision.
          release_date: rel.releaseDate && /^\d{4}-\d{2}-\d{2}$/.test(rel.releaseDate) ? rel.releaseDate : null,
          artist_name: catalog?.artistName ?? null,
          isrc: firstIsrc,
          upc: rel.upc,
          release_type: rel.releaseType,
          notes: trackNotes,
        }),
      })
      const created = await res.json()
      if (!res.ok) throw new Error(created.error ?? 'Import failed')
      const res2 = await fetch(`/api/releases/${created.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mixing_done: true, mastering_done: true, artwork_ready: true, dsp_submitted: true }),
      })
      const finalRow = res2.ok ? await res2.json() : created
      setReleases(prev => [{ ...finalRow, mb_projects: null }, ...prev])
    } catch (e) {
      flashError(e instanceof Error ? e.message : 'Could not import that release.')
    }
    setImportingTitle(null)
  }

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
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text)]">Release Pipeline</h1>
          <p className="text-[var(--text-muted)] text-sm mt-0.5">Track every step — from mix to campaign</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <button
            onClick={() => { setShowImport(!showImport); setShowWaterfall(false); setShowForm(false) }}
            className="flex items-center gap-2 text-sm font-semibold px-4 py-2.5 rounded-xl transition-colors text-violet-400 bg-violet-400/10 hover:bg-violet-400/20"
          >
            <ListMusic size={16} />
            Import Catalog
          </button>
          <button
            onClick={() => { setShowWaterfall(!showWaterfall); setShowForm(false); setShowImport(false) }}
            className="flex items-center gap-2 text-sm font-semibold px-4 py-2.5 rounded-xl transition-colors text-sky-400 bg-sky-400/10 hover:bg-sky-400/20"
          >
            <Droplets size={16} />
            Plan Waterfall
          </button>
          <button
            onClick={() => { setShowForm(!showForm); setShowWaterfall(false); setShowImport(false) }}
            className="flex items-center gap-2 bg-[#2dd4bf] hover:bg-[#14b8a6] text-[#0a0a0a] text-sm font-semibold px-4 py-2.5 rounded-xl transition-colors"
          >
            <Plus size={16} />
            Add Release
          </button>
        </div>
      </div>

      {/* Catalog import — the artist's released discography with ISRCs/UPCs,
          importable as pipeline rows. The key waterfall enabler: re-releases
          must reuse the original ISRCs, and this is where they come from. */}
      {showImport && (
        <div className="rounded-2xl p-6 mb-6" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}>
          <h2 className="text-sm font-semibold text-[var(--text)] mb-1 flex items-center gap-2"><ListMusic size={14} className="text-violet-400" /> Import Released Catalog</h2>
          <p className="text-xs text-[var(--text-muted)] mb-4">
            Pulls your released songs with their ISRCs, UPCs, and dates from Spotify or Deezer (public catalog data — no login needed).
            Import past drops so the next waterfall release reuses the right ISRCs.
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={importQuery}
              onChange={e => setImportQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && importQuery.trim() && !importLoading) fetchCatalog() }}
              placeholder="Artist name or Spotify artist link"
              className="flex-1 rounded-xl px-3 py-2 text-sm text-[var(--text)] focus:outline-none"
              style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)' }}
            />
            <button
              onClick={fetchCatalog}
              disabled={importLoading || !importQuery.trim()}
              className="bg-[#2dd4bf] hover:bg-[#14b8a6] disabled:opacity-40 disabled:cursor-not-allowed text-[#0a0a0a] text-sm font-semibold px-5 rounded-xl transition-colors"
            >
              {importLoading ? 'Fetching…' : 'Fetch'}
            </button>
          </div>

          {importError && (
            <p className="text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded-xl px-3 py-2 mt-3">{importError}</p>
          )}

          {catalog && (
            <div className="mt-4 space-y-3">
              <p className="text-xs text-[var(--text-muted)]">
                {catalog.releases.length} release{catalog.releases.length === 1 ? '' : 's'} for{' '}
                <span className="text-[var(--text)] font-medium">{catalog.artistName}</span>
                {' '}via {catalog.source === 'spotify' ? 'Spotify' : 'Deezer'}
                {catalog.artistUrl && (
                  <a href={catalog.artistUrl} target="_blank" rel="noreferrer" className="ml-2 text-[var(--text-muted)] hover:text-[var(--accent)] underline underline-offset-2">view profile</a>
                )}
              </p>
              {catalog.releases.map(rel => {
                const existing = matchExisting(rel.title)
                const firstIsrc = rel.tracks[0]?.isrc ?? null
                const canBackfill = existing && !existing.isrc && !!firstIsrc
                return (
                  <div key={rel.url ?? `${rel.title}-${rel.releaseDate}`} className="rounded-xl p-3" style={{ backgroundColor: 'var(--surface-2)' }}>
                    <div className="flex items-center gap-3 flex-wrap">
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium text-[var(--text)] truncate">{rel.title}</span>
                        <div className="flex items-center gap-2.5 mt-0.5 text-xs text-[var(--text-muted)]">
                          {rel.releaseDate && <span>{rel.releaseDate}</span>}
                          <span className="uppercase text-[10px] tracking-wider">{rel.releaseType}</span>
                          {rel.upc && (
                            <button
                              type="button"
                              onClick={() => copyFieldValue(`cat:${rel.title}:upc`, rel.upc!)}
                              title="Copy UPC"
                              className="flex items-center gap-1 hover:text-[var(--text)] transition-colors"
                            >
                              UPC {rel.upc}
                              {copiedField === `cat:${rel.title}:upc` ? <Check size={10} className="text-[#2dd4bf]" /> : <Copy size={10} />}
                            </button>
                          )}
                        </div>
                      </div>
                      {existing && !canBackfill ? (
                        <span className="text-xs text-emerald-400 flex items-center gap-1 flex-shrink-0"><Check size={12} /> In pipeline</span>
                      ) : canBackfill ? (
                        <button
                          onClick={() => updateFields(existing!.id, { isrc: firstIsrc, upc: rel.upc })}
                          className="text-xs font-semibold text-amber-400 bg-amber-400/10 hover:bg-amber-400/20 px-3 py-1.5 rounded-lg transition-colors flex-shrink-0"
                        >
                          Fill ISRC on “{existing!.title}”
                        </button>
                      ) : (
                        <button
                          onClick={() => importCatalogRelease(rel)}
                          disabled={importingTitle === rel.title}
                          className="text-xs font-semibold text-[#2dd4bf] bg-[#2dd4bf]/10 hover:bg-[#2dd4bf]/20 disabled:opacity-40 px-3 py-1.5 rounded-lg transition-colors flex-shrink-0"
                        >
                          {importingTitle === rel.title ? 'Importing…' : 'Add to pipeline'}
                        </button>
                      )}
                    </div>
                    <div className="mt-2 space-y-1">
                      {rel.tracks.map(t => (
                        <div key={t.trackNumber} className="flex items-center gap-2 text-xs">
                          <span className="text-[var(--text-muted)] w-4 text-right flex-shrink-0">{t.trackNumber}.</span>
                          <span className="text-[var(--text-secondary)] truncate">{t.title}</span>
                          {t.isrc ? (
                            <button
                              type="button"
                              onClick={() => copyFieldValue(`cat:${rel.title}:${t.trackNumber}`, t.isrc!)}
                              title="Copy ISRC"
                              className="flex items-center gap-1 text-[var(--text-muted)] hover:text-[var(--text)] transition-colors flex-shrink-0"
                            >
                              {t.isrc}
                              {copiedField === `cat:${rel.title}:${t.trackNumber}` ? <Check size={10} className="text-[#2dd4bf]" /> : <Copy size={10} />}
                            </button>
                          ) : (
                            <span className="text-[var(--text-muted)] opacity-50 flex-shrink-0">no ISRC</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Waterfall planner — ordered tracks + start Friday + cadence in, one
          linked release per drop out. Each later drop's DistroKid prep panel
          automatically carries the earlier tracks with reuse-ISRC flags. */}
      {showWaterfall && (
        <div className="rounded-2xl p-6 mb-6" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}>
          <h2 className="text-sm font-semibold text-[var(--text)] mb-1 flex items-center gap-2"><Droplets size={14} className="text-sky-400" /> Plan a Waterfall Run</h2>
          <p className="text-xs text-[var(--text-muted)] mb-4">One single at a time — each new drop re-releases the earlier tracks so their streams and playlist placements carry over. Drop dates snap to Fridays.</p>
          <form onSubmit={handleCreateWaterfall} className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <label className="block text-xs text-[var(--text-muted)] mb-1.5">Artist name</label>
                <input
                  type="text"
                  value={wfShared.artist_name}
                  onChange={e => setWfShared(p => ({ ...p, artist_name: e.target.value }))}
                  placeholder="As on your Spotify profile"
                  className="w-full rounded-xl px-3 py-2 text-sm text-[var(--text)] focus:outline-none"
                  style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)' }}
                />
              </div>
              <div>
                <label className="block text-xs text-[var(--text-muted)] mb-1.5">Primary genre</label>
                <input
                  type="text"
                  value={wfShared.genre}
                  onChange={e => setWfShared(p => ({ ...p, genre: e.target.value }))}
                  placeholder="e.g. Afrobeats"
                  className="w-full rounded-xl px-3 py-2 text-sm text-[var(--text)] focus:outline-none"
                  style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)' }}
                />
              </div>
              <div>
                <label className="block text-xs text-[var(--text-muted)] mb-1.5">Record label</label>
                <input
                  type="text"
                  value={wfShared.label}
                  onChange={e => setWfShared(p => ({ ...p, label: e.target.value }))}
                  placeholder="e.g. Independent"
                  className="w-full rounded-xl px-3 py-2 text-sm text-[var(--text)] focus:outline-none"
                  style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)' }}
                />
              </div>
              <div>
                <label className="block text-xs text-[var(--text-muted)] mb-1.5">Songwriters (legal names)</label>
                <input
                  type="text"
                  value={wfShared.songwriters}
                  onChange={e => setWfShared(p => ({ ...p, songwriters: e.target.value }))}
                  placeholder="Jane Doe, John Smith"
                  className="w-full rounded-xl px-3 py-2 text-sm text-[var(--text)] focus:outline-none"
                  style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)' }}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-[var(--text-muted)] mb-1.5">First drop <span className="text-[#2dd4bf]">*</span></label>
                <input
                  type="date"
                  value={wfShared.start_date}
                  onChange={e => setWfShared(p => ({ ...p, start_date: e.target.value }))}
                  className="w-full rounded-xl px-3 py-2 text-sm text-[var(--text)] focus:outline-none [color-scheme:dark]"
                  style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)' }}
                />
                <div className="flex flex-wrap items-center gap-1.5 mt-2">
                  {releaseDatePresets(todayStr).map(p => (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => setWfShared(prev => ({ ...prev, start_date: p.date }))}
                      title={p.friendly}
                      className={`rounded-full px-2.5 py-1 text-xs transition-colors ${wfShared.start_date === p.date ? 'text-[#2dd4bf] bg-[#2dd4bf]/10' : 'text-[var(--text-muted)] hover:text-[var(--text)]'}`}
                      style={{ border: '1px solid var(--border)' }}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs text-[var(--text-muted)] mb-1.5">Cadence</label>
                <select
                  value={wfShared.cadence_days}
                  onChange={e => setWfShared(p => ({ ...p, cadence_days: Number(e.target.value) }))}
                  className="w-full rounded-xl px-3 py-2 text-sm text-[var(--text)] focus:outline-none appearance-none"
                  style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)' }}
                >
                  <option value={14} style={{ backgroundColor: 'var(--surface)' }}>Every 2 weeks</option>
                  <option value={21} style={{ backgroundColor: 'var(--surface)' }}>Every 3 weeks</option>
                  <option value={28} style={{ backgroundColor: 'var(--surface)' }}>Every 4 weeks</option>
                  <option value={42} style={{ backgroundColor: 'var(--surface)' }}>Every 6 weeks</option>
                  <option value={56} style={{ backgroundColor: 'var(--surface)' }}>Every 8 weeks</option>
                </select>
              </div>
            </div>

            {/* Ordered tracks — drop order, top first */}
            <div>
              <label className="block text-xs text-[var(--text-muted)] mb-1.5">Tracks in drop order</label>
              <div className="space-y-2">
                {wfTracks.map((t, i) => {
                  const trackVersions = t.project_id ? versions.filter(v => v.project_id === t.project_id) : []
                  return (
                    <div key={i} className="flex items-center gap-2">
                      <span className="text-xs text-[var(--text-muted)] w-10 flex-shrink-0">
                        {wfPreviewDates[i]
                          ? formatReleaseDate(wfPreviewDates[i], { month: 'short', day: 'numeric' })
                          : `#${i + 1}`}
                      </span>
                      <input
                        type="text"
                        value={t.title}
                        onChange={e => setWfTrack(i, { title: e.target.value })}
                        placeholder={`Track ${i + 1} title`}
                        className="flex-1 min-w-0 rounded-xl px-3 py-2 text-sm text-[var(--text)] focus:outline-none"
                        style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)' }}
                      />
                      <select
                        value={t.project_id}
                        onChange={e => setWfTrack(i, { project_id: e.target.value })}
                        className="w-36 rounded-xl px-2 py-2 text-sm text-[var(--text)] focus:outline-none appearance-none"
                        style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)' }}
                      >
                        <option value="" style={{ backgroundColor: 'var(--surface)' }}>Project…</option>
                        {projects.map(p => (
                          <option key={p.id} value={p.id} style={{ backgroundColor: 'var(--surface)' }}>{p.title}</option>
                        ))}
                      </select>
                      <select
                        value={t.final_version_id}
                        onChange={e => setWfTrack(i, { final_version_id: e.target.value })}
                        disabled={!t.project_id || trackVersions.length === 0}
                        className="w-36 rounded-xl px-2 py-2 text-sm text-[var(--text)] focus:outline-none appearance-none disabled:opacity-40"
                        style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)' }}
                      >
                        <option value="" style={{ backgroundColor: 'var(--surface)' }}>Latest / none</option>
                        {trackVersions.map(v => (
                          <option key={v.id} value={v.id} style={{ backgroundColor: 'var(--surface)' }}>
                            {v.label ? v.label : `Version ${v.version_number}`} — {v.status}
                          </option>
                        ))}
                      </select>
                      <div className="flex items-center gap-0.5 flex-shrink-0">
                        <button type="button" onClick={() => moveWfTrack(i, -1)} disabled={i === 0} className="p-1 text-[var(--text-muted)] hover:text-[var(--text)] disabled:opacity-30 transition-colors" aria-label="Move up">
                          <ArrowUp size={14} />
                        </button>
                        <button type="button" onClick={() => moveWfTrack(i, 1)} disabled={i === wfTracks.length - 1} className="p-1 text-[var(--text-muted)] hover:text-[var(--text)] disabled:opacity-30 transition-colors" aria-label="Move down">
                          <ArrowDown size={14} />
                        </button>
                        <button type="button" onClick={() => setWfTracks(prev => prev.filter((_, j) => j !== i))} disabled={wfTracks.length <= 2} className="p-1 text-[var(--text-muted)] hover:text-red-400 disabled:opacity-30 transition-colors" aria-label="Remove track">
                          <X size={14} />
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
              {wfTracks.length < 12 && (
                <button
                  type="button"
                  onClick={() => setWfTracks(prev => [...prev, { ...emptyWfTrack }])}
                  className="flex items-center gap-1.5 mt-2 text-xs text-[#2dd4bf] hover:text-[#14b8a6] transition-colors"
                >
                  <Plus size={12} />
                  Add track
                </button>
              )}
            </div>

            {wfError && (
              <p className="text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded-xl px-3 py-2">{wfError}</p>
            )}
            <div className="flex gap-3">
              <button
                type="submit"
                disabled={wfSaving || !wfShared.start_date || wfTracks.some(t => !t.title.trim())}
                className="flex-1 bg-[#2dd4bf] hover:bg-[#14b8a6] disabled:opacity-40 disabled:cursor-not-allowed text-[#0a0a0a] text-sm font-semibold rounded-xl py-2.5 transition-colors"
              >
                {wfSaving ? 'Planning...' : `Create ${wfTracks.length} Linked Releases`}
              </button>
              <button
                type="button"
                onClick={() => { setShowWaterfall(false); setWfError(null) }}
                className="px-5 py-2.5 text-sm text-[var(--text-muted)] hover:text-[var(--text)] rounded-xl transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Create form */}
      {showForm && (
        <div className="rounded-2xl p-6 mb-6" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}>
          <h2 className="text-sm font-semibold text-[var(--text)] mb-4">New Release</h2>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-[var(--text-muted)] mb-1.5">Title <span className="text-[#2dd4bf]">*</span></label>
                <input
                  type="text"
                  value={form.title}
                  onChange={e => setField('title', e.target.value)}
                  placeholder="e.g. After Dark"
                  autoFocus
                  className="w-full rounded-xl px-3 py-2 text-sm text-[var(--text)] focus:outline-none"
                  style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)' }}
                />
              </div>
              <div>
                <label className="block text-xs text-[var(--text-muted)] mb-1.5">Release Date</label>
                <input
                  type="date"
                  value={form.release_date}
                  onChange={e => setField('release_date', e.target.value)}
                  className="w-full rounded-xl px-3 py-2 text-sm text-[var(--text)] focus:outline-none [color-scheme:dark]"
                  style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)' }}
                />
              </div>
            </div>

            {/* Project + Version pickers */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-[var(--text-muted)] mb-1.5">Linked Project</label>
                <select
                  value={form.project_id}
                  onChange={e => setField('project_id', e.target.value)}
                  className="w-full rounded-xl px-3 py-2 text-sm text-[var(--text)] focus:outline-none appearance-none"
                  style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)' }}
                >
                  <option value="" style={{ backgroundColor: 'var(--surface)' }}>None</option>
                  {projects.map(p => (
                    <option key={p.id} value={p.id} style={{ backgroundColor: 'var(--surface)' }}>{p.title}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-[var(--text-muted)] mb-1.5">
                  Final Track Version
                  {!form.project_id && <span className="text-[var(--text-muted)] ml-1">(pick project first)</span>}
                </label>
                <select
                  value={form.final_version_id}
                  onChange={e => setField('final_version_id', e.target.value)}
                  disabled={!form.project_id || projectVersions.length === 0}
                  className="w-full rounded-xl px-3 py-2 text-sm text-[var(--text)] focus:outline-none appearance-none disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)' }}
                >
                  <option value="" style={{ backgroundColor: 'var(--surface)' }}>
                    {form.project_id && projectVersions.length === 0 ? 'No versions yet' : 'Latest / none'}
                  </option>
                  {projectVersions.map(v => (
                    <option key={v.id} value={v.id} style={{ backgroundColor: 'var(--surface)' }}>
                      {v.label ? v.label : `Version ${v.version_number}`} — {v.status}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-[var(--text-muted)] mb-1.5">Genre</label>
                <input
                  type="text"
                  value={form.genre}
                  onChange={e => setField('genre', e.target.value)}
                  placeholder="e.g. Afrobeats"
                  className="w-full rounded-xl px-3 py-2 text-sm text-[var(--text)] focus:outline-none"
                  style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)' }}
                />
              </div>
              <div>
                <label className="block text-xs text-[var(--text-muted)] mb-1.5">Label</label>
                <input
                  type="text"
                  value={form.label}
                  onChange={e => setField('label', e.target.value)}
                  placeholder="e.g. Independent"
                  className="w-full rounded-xl px-3 py-2 text-sm text-[var(--text)] focus:outline-none"
                  style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)' }}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-[var(--text-muted)] mb-1.5">ISRC</label>
                <input
                  type="text"
                  value={form.isrc}
                  onChange={e => setField('isrc', e.target.value)}
                  placeholder="e.g. USABC1234567"
                  className="w-full rounded-xl px-3 py-2 text-sm text-[var(--text)] focus:outline-none"
                  style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)' }}
                />
              </div>
              <div>
                <label className="block text-xs text-[var(--text-muted)] mb-1.5">Notes</label>
                <input
                  type="text"
                  value={form.notes}
                  onChange={e => setField('notes', e.target.value)}
                  placeholder="Any notes..."
                  className="w-full rounded-xl px-3 py-2 text-sm text-[var(--text)] focus:outline-none"
                  style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)' }}
                />
              </div>
            </div>

            {saveError && (
              <p className="text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded-xl px-3 py-2">{saveError}</p>
            )}
            <div className="flex gap-3">
              <button
                type="submit"
                disabled={saving || !form.title.trim()}
                className="flex-1 bg-[#2dd4bf] hover:bg-[#14b8a6] disabled:opacity-40 disabled:cursor-not-allowed text-[#0a0a0a] text-sm font-semibold rounded-xl py-2.5 transition-colors"
              >
                {saving ? 'Creating...' : 'Create Release'}
              </button>
              <button
                type="button"
                onClick={() => { setShowForm(false); setSaveError(null) }}
                className="px-5 py-2.5 text-sm text-[var(--text-muted)] hover:text-[var(--text)] rounded-xl transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Upcoming releases */}
      {upcoming.length === 0 && past.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}>
            <CalendarRange size={24} className="text-[var(--text-muted)]" />
          </div>
          <p className="text-[var(--text-muted)] mb-4">No releases planned yet</p>
          <button
            onClick={() => setShowForm(true)}
            className="flex items-center gap-2 text-[#2dd4bf] text-sm hover:text-[#14b8a6] transition-colors"
          >
            <Plus size={14} />
            Add your first release
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          {upcoming.length > 0 && (
            <div>
              <h2 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3">Upcoming</h2>
              <div className="space-y-3">
                {upcoming.map(r => <ReleaseCard key={r.id} release={r} {...cardProps} />)}
              </div>
            </div>
          )}
          {past.length > 0 && (
            <div>
              <h2 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3">Past</h2>
              <div className="space-y-3 opacity-60">
                {past.map(r => <ReleaseCard key={r.id} release={r} {...cardProps} />)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
