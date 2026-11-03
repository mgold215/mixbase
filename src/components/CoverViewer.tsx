'use client'

// The full cover art, opened by tapping the album art (the dashboard list,
// the project header). Everyone can look at it and save it; the platform
// owner can also change the handwritten title (colour, spot, size — the cover
// re-lettered from its kept layers through /api/cassette-studio/render with
// scene = keep, no new scene, no AI) and the look (Finish the look, the same
// editor Cassette Studio uses), without opening the Studio.

import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, PenLine, X } from 'lucide-react'
import { saveMedia } from '@/lib/download'
import { TEXT_COLORS } from '@/lib/text-colors'
import CassetteLook, {
  isOriginalLook, readLookPrefs, saveLook, writeLookPrefs, type FilterSettings, type LookPrefs, type SavedLook,
} from '@/components/CassetteLook'

type Position = 'bottom-left' | 'bottom-center' | 'bottom-right' | 'top-left' | 'top-center' | 'top-right'
type Size = 'small' | 'medium' | 'large'
const POSITIONS: { value: Position; label: string }[] = [
  { value: 'top-left', label: '↖' }, { value: 'top-center', label: '↑' }, { value: 'top-right', label: '↗' },
  { value: 'bottom-left', label: '↙' }, { value: 'bottom-center', label: '↓' }, { value: 'bottom-right', label: '↘' },
]
const SIZES: Size[] = ['small', 'medium', 'large']

const chip = (on: boolean) => `px-2 h-6 rounded-md text-[10px] ${on ? 'bg-[#2dd4bf]/20 text-[#2dd4bf]' : 'bg-[#1a1a1a] text-[#777] hover:text-white'}`

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try { return (await res.json()) as Record<string, unknown> } catch { return null }
}

type Props = {
  projectId: string
  projectTitle: string
  /** The cover to show: the finished (lettered, graded) one when there is one. */
  coverUrl: string
  /** Platform owner: the title and look editors are shown. */
  ownerTools: boolean
  /** The cover changed here (a re-lettering, a look): mirror it on the page. */
  onRendered: (artworkUrl: string, finalizedUrl: string | null) => void
  onClose: () => void
}

export default function CoverViewer({ projectId, projectTitle, coverUrl, ownerTools, onRendered, onClose }: Props) {
  const [shown, setShown] = useState(coverUrl)
  useEffect(() => { setShown(coverUrl) }, [coverUrl])
  // Rendered through a portal on <body>, so a transformed or overflow-hidden
  // ancestor (the dashboard rows) can't clip the full-screen layer.
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])
  // Escape closes; the page behind holds still while the cover is up.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev }
  }, [onClose])

  // Save to the device: the share sheet on a phone (Photos), a download on a
  // computer — src/lib/download.ts, with its "one more tap" case on iOS.
  const [saveError, setSaveError] = useState('')
  const [finishSave, setFinishSave] = useState<(() => Promise<void>) | null>(null)
  function save() {
    setSaveError('')
    setFinishSave(null)
    void saveMedia(shown, `${projectTitle} cover`, 'jpg', { onNeedsFinishTap: finish => setFinishSave(() => finish) })
      .catch(() => setSaveError("Couldn't save the cover. Please try again."))
  }
  function finishSaveTap() {
    const finish = finishSave
    if (!finish) return
    setFinishSave(null)
    void finish().catch(() => setSaveError("Couldn't save the cover. Tap Save again."))
  }

  // ── Owner: the title ────────────────────────────────────────────────────
  // The song's newest lettering (what scene = keep re-applies). undefined =
  // still loading, null = this song has no handwriting yet.
  const [letteringPath, setLetteringPath] = useState<string | null | undefined>(undefined)
  const [color, setColor] = useState('auto')
  const [position, setPosition] = useState<Position | 'auto'>('auto')
  const [size, setSize] = useState<Size>('medium')
  const [titleBusy, setTitleBusy] = useState(false)
  const [titleNote, setTitleNote] = useState('')
  const [titleError, setTitleError] = useState('')
  useEffect(() => {
    if (!ownerTools) return
    const ctrl = new AbortController()
    fetch(`/api/cassette-studio?project_id=${projectId}`, { signal: ctrl.signal })
      .then(r => (r.ok ? readJson(r) : null))
      .then(d => {
        if (ctrl.signal.aborted) return
        const lettering = (d?.lettering as { path: string }[] | undefined) ?? []
        setLetteringPath(lettering[0]?.path ?? null)
      })
      .catch(() => { if (!ctrl.signal.aborted) setLetteringPath(null) })
    return () => ctrl.abort()
  }, [projectId, ownerTools])

  // ── Owner: the look ─────────────────────────────────────────────────────
  const [lookPrefs, setLookPrefs] = useState<LookPrefs>(readLookPrefs)
  useEffect(() => { writeLookPrefs(lookPrefs) }, [lookPrefs])
  const [lookRefresh, setLookRefresh] = useState(0)
  const [lookSaving, setLookSaving] = useState(false)

  const landed = useCallback((artworkUrl: string, finalizedUrl: string | null) => {
    onRendered(artworkUrl, finalizedUrl)
    setShown(finalizedUrl ?? artworkUrl)
  }, [onRendered])

  async function saveLookNow(settings: FilterSettings): Promise<SavedLook> {
    setLookSaving(true)
    try {
      const saved = await saveLook(projectId, settings)
      if (saved.artworkUrl) landed(saved.artworkUrl, saved.finalizedUrl)
      setLookPrefs(prev => ({ ...prev, look: saved.filter }))
      return saved
    } finally {
      setLookSaving(false)
    }
  }

  async function updateTitle() {
    if (!letteringPath) return
    setTitleBusy(true)
    setTitleError('')
    setTitleNote('')
    try {
      const form = new FormData()
      form.append('project_id', projectId)
      form.append('scene', 'keep')
      form.append('lettering', letteringPath)
      form.append('color', color)
      form.append('position', position)
      form.append('size', size)
      const res = await fetch('/api/cassette-studio/render', { method: 'POST', body: form })
      const data = await readJson(res)
      if (!res.ok || typeof data?.artwork_url !== 'string') throw new Error((data?.error as string) ?? 'Could not update the title.')
      landed(data.artwork_url, (data.finalized_artwork_url as string | null) ?? null)
      // A re-lettered cover comes back plain; the remembered look goes straight
      // back on, as it does after a Studio render.
      const keep = lookPrefs.keep && lookPrefs.look && !isOriginalLook(lookPrefs.look) ? lookPrefs.look : null
      if (keep) {
        try { await saveLookNow(keep) } catch { setTitleNote('Your look could not be added again, so the cover is plain. Add it below.') }
      }
      setLookRefresh(n => n + 1)
    } catch (err) {
      setTitleError(err instanceof Error ? err.message : 'Could not update the title.')
    } finally {
      setTitleBusy(false)
    }
  }

  if (!mounted) return null
  const busy = titleBusy || lookSaving

  return createPortal(
    <div className="fixed inset-0 z-[100] overflow-y-auto bg-black/95" role="dialog" aria-modal="true" aria-label={`${projectTitle} cover`}>
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 bg-black/80 px-4 py-3 backdrop-blur">
        <p className="truncate text-sm font-semibold text-white">{projectTitle}</p>
        <div className="flex items-center gap-2">
          <button onClick={save} className="flex items-center gap-1 rounded-lg bg-[#2dd4bf]/20 px-3 py-1.5 text-xs text-[#2dd4bf] hover:bg-[#2dd4bf]/30">
            <Download size={12} />Save
          </button>
          <button onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-[#999] hover:bg-white/10 hover:text-white">
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="mx-auto max-w-3xl space-y-4 px-4 pb-10 pt-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={shown} alt={`${projectTitle} cover`} className="mx-auto max-h-[70vh] w-auto max-w-full rounded-xl bg-black object-contain" />
        {finishSave && (
          <button onClick={finishSaveTap} className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#2dd4bf] py-2.5 text-xs font-semibold text-[#0f0f0f]">
            <Download size={13} />Ready — tap to save to Photos
          </button>
        )}
        {saveError && <p className="text-center text-xs text-red-400">{saveError}</p>}

        {ownerTools && (
          <section className="space-y-2 rounded-xl border border-[#222] bg-[#0f0f0f] p-3">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-white"><PenLine size={12} className="text-[#2dd4bf]" />The title</p>
            {letteringPath === undefined ? (
              <p className="text-[10px] text-[#666]">Loading…</p>
            ) : letteringPath === null ? (
              <p className="text-[10px] text-[#666]">No handwriting on this song yet. Add it in Cassette Studio and the title can be changed here.</p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex gap-1">
                    <button onClick={() => setColor('auto')} className={chip(color === 'auto')}>Auto</button>
                    {TEXT_COLORS.map(c => (
                      <button key={c.value} onClick={() => setColor(c.value)} title={c.label} aria-label={c.label}
                        className={`h-6 w-6 rounded-md border ${color === c.value ? 'border-[#2dd4bf]' : 'border-[#333]'}`} style={{ backgroundColor: c.value }} />
                    ))}
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => setPosition('auto')} className={chip(position === 'auto')}>Auto</button>
                    <div className="grid grid-cols-3 gap-0.5">
                      {POSITIONS.map(p => (
                        <button key={p.value} onClick={() => setPosition(p.value)} aria-label={p.value}
                          className={`h-5 w-6 rounded text-[10px] ${position === p.value ? 'bg-[#2dd4bf]/20 text-[#2dd4bf]' : 'bg-[#1a1a1a] text-[#666]'}`}>{p.label}</button>
                      ))}
                    </div>
                  </div>
                  <div className="flex gap-0.5">
                    {SIZES.map(s => (
                      <button key={s} onClick={() => setSize(s)}
                        className={`h-6 w-6 rounded text-[10px] ${size === s ? 'bg-[#2dd4bf]/20 text-[#2dd4bf]' : 'bg-[#1a1a1a] text-[#666]'}`}>{s[0].toUpperCase()}</button>
                    ))}
                  </div>
                  <button onClick={() => void updateTitle()} disabled={busy}
                    className="flex items-center gap-1 rounded-md bg-[#2dd4bf]/20 px-2 py-1 text-[10px] text-[#2dd4bf] hover:bg-[#2dd4bf]/30 disabled:opacity-50">
                    {titleBusy ? <span className="h-3 w-3 animate-spin rounded-full border border-white/30 border-t-white" /> : <PenLine size={10} />}
                    {titleBusy ? 'Updating…' : 'Update the title'}
                  </button>
                </div>
                <p className="text-[10px] text-[#666]">Re-letters this cover from its kept layers, no new scene. A clip filmed before keeps its title.</p>
                {titleNote && <p className="text-[10px] text-[#2dd4bf]">{titleNote}</p>}
                {titleError && <p className="text-xs text-red-400">{titleError}</p>}
              </>
            )}
          </section>
        )}

        {ownerTools && (
          <section className="rounded-xl border border-[#222] bg-[#0f0f0f] p-3">
            <CassetteLook
              projectId={projectId}
              refreshKey={lookRefresh}
              disabled={busy}
              saving={lookSaving}
              prefs={lookPrefs}
              onPrefsChange={setLookPrefs}
              onSave={saveLookNow}
              heading="The look"
            />
          </section>
        )}
      </div>
    </div>,
    document.body,
  )
}
