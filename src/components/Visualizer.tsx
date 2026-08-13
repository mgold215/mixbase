'use client'

import { useState } from 'react'
import Image from 'next/image'
import { Check, Film, MonitorPlay } from 'lucide-react'
import { saveMedia } from '@/lib/download'
import { useVizRecipe } from './visualizer/useVizRecipe'
import { type Format, type LibraryItem, type VizSlot } from './visualizer/shared'
import PinSlots from './visualizer/PinSlots'
import FreeStudio from './visualizer/FreeStudio'
import AiGeneratorCard from './visualizer/AiGeneratorCard'

type Props = {
  projectTitle: string
  artworkUrl: string | null
  onSwitchToArtwork: () => void
  // When set, generated videos are persisted to the Media library against this
  // project. Omitted in contexts with no backing project (none currently).
  projectId?: string
  // The project's pinned visualizers. visualizer_url is the VERTICAL pin —
  // loops in the player while this track plays (Spotify-Canvas style) and
  // feeds the Finalize Short render. visualizer_wide_url is the HORIZONTAL
  // pin that feeds the Finalize Full-Length render. Wired on the project
  // page; the Media modal omits them.
  visualizerUrl?: string | null
  onVisualizerUpdated?: (url: string | null) => void
  wideVisualizerUrl?: string | null
  onWideVisualizerUpdated?: (url: string | null) => void
  // Project-level context for the FX studio, wired on the project page:
  // detected tempo prefills the BPM field; the current mix's proxied audio URL
  // + version id feed audio-reactive rendering (next phase). All optional —
  // the Media modal omits them and the studio falls back to synthetic beats.
  projectBpm?: number | null
  audioUrl?: string | null
  audioVersionId?: string | null
}

// Container for the Visualizer tab: pin slots + library picker state, the
// download/share plumbing shared by both generator cards, and the recipe that
// drives the free FX studio. The heavy UI lives in components/visualizer/.
// Note: audioUrl/audioVersionId are accepted (the project page already passes
// them) but not destructured — the studio starts consuming them in the
// audio-reactivity phase.
export default function Visualizer({
  projectTitle, artworkUrl, onSwitchToArtwork, projectId,
  visualizerUrl, onVisualizerUpdated, wideVisualizerUrl, onWideVisualizerUpdated,
  projectBpm,
}: Props) {
  const { recipe, dispatch } = useVizRecipe(projectId, projectBpm)
  const [downloadErr, setDownloadErr] = useState<string | null>(null)
  // iOS second-tap share: holds the re-share closure for already-fetched bytes.
  const [finishSave, setFinishSave] = useState<(() => Promise<void>) | null>(null)
  const [projectViz, setProjectViz] = useState(visualizerUrl ?? null)
  const [projectVizWide, setProjectVizWide] = useState(wideVisualizerUrl ?? null)
  const [settingViz, setSettingViz] = useState(false)
  const [vizError, setVizError] = useState('')
  // "Choose from Media" picker — pin any previously generated loop, from any
  // project, into whichever slot (vertical/horizontal) opened the picker.
  const [pickerSlot, setPickerSlot] = useState<VizSlot | null>(null)
  const [library, setLibrary] = useState<LibraryItem[]>([])
  const [libraryLoading, setLibraryLoading] = useState(false)
  const [libraryError, setLibraryError] = useState('')

  // Open the library picker for a pin slot and load every saved loop the user
  // owns. Loading flag resets in finally so a network reject can't strand the
  // spinner.
  async function openPicker(slot: VizSlot) {
    setPickerSlot(slot)
    setLibraryError('')
    setLibraryLoading(true)
    try {
      const res = await fetch('/api/visualizer')
      const data = await res.json().catch(() => null)
      if (!res.ok || !Array.isArray(data)) throw new Error()
      setLibrary(data)
    } catch {
      setLibraryError('Could not load your visualizers. Try again.')
    } finally {
      setLibraryLoading(false)
    }
  }

  async function pickFromLibrary(item: LibraryItem) {
    await setProjectVisualizer(pickerSlot ?? 'canvas', item.video_url)
    setPickerSlot(null)
  }

  // Pin (or clear) one of the project's visualizer slots — vertical loops in
  // the player and feeds the Short; horizontal feeds the Full-Length video.
  // Persists via the project PATCH so it survives reloads.
  async function setProjectVisualizer(slot: VizSlot, url: string | null) {
    if (!projectId || settingViz) return
    setSettingViz(true)
    setVizError('')
    // One PATCH attempt — resolves to null on success, an error message on
    // failure. Kept as a closure so the retry below is a genuine re-request.
    const attempt = async (): Promise<string | null> => {
      try {
        const res = await fetch(`/api/projects/${projectId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(slot === 'wide' ? { visualizer_wide_url: url } : { visualizer_url: url }),
        })
        if (res.ok) return null
        const data = await res.json().catch(() => null) as { error?: string } | null
        return data?.error || `Request failed (${res.status})`
      } catch {
        return 'Network error'
      }
    }
    try {
      let err = await attempt()
      if (err) {
        // Every merge redeploys prod, and pinning right after generating is
        // exactly when a restart blip can land — one spaced retry absorbs it.
        await new Promise(r => setTimeout(r, 1500))
        err = await attempt()
      }
      if (err) {
        setVizError(`Could not update the project visualizer (${err}). Try again.`)
        return
      }
      if (slot === 'wide') {
        setProjectVizWide(url)
        onWideVisualizerUpdated?.(url)
      } else {
        setProjectViz(url)
        onVisualizerUpdated?.(url)
      }
    } finally {
      setSettingViz(false)
    }
  }

  // saveMedia handles the platform differences: share sheet on phones (so the
  // clip can go straight to Photos), forced attachment download on desktop. A
  // bare cross-origin <a download> would just open the video inline.
  // A swallowed rejection here is indistinguishable from "nothing happened" —
  // the exact failure that hid the blocked blob: download. Surface it.
  function download(url: string, suffix: string, ext: 'webm' | 'mp4') {
    setDownloadErr(null)
    setFinishSave(null)
    void saveMedia(url, `${projectTitle}-${recipe.format}-${suffix}`, ext, {
      // iOS: the fetch outlived Safari's tap window, so the share sheet needs
      // one more tap — surface a button that re-shares the fetched bytes.
      onNeedsFinishTap: finish => setFinishSave(() => finish),
    }).catch(() => {
      setDownloadErr("Couldn't save the file. Try again, or use Save to Media.")
    })
  }

  function finishSaveTap() {
    const finish = finishSave
    if (!finish) return
    setFinishSave(null)
    void finish().catch(() => {
      setDownloadErr("Couldn't save the file. Try the Download button again.")
    })
  }

  // Pin affordance for a persisted mf-video URL — only where the project page
  // wired the callback, and only once the video is saved. The slot follows the
  // render's orientation: 16:9 loops pin as the horizontal (Full-Length)
  // visualizer, everything else as the vertical (player + Short) one.
  const pinButton = (url: string | null, slot: VizSlot) => {
    if (!projectId || !onVisualizerUpdated || !url) return null
    const label = slot === 'wide' ? 'Horizontal Visualizer' : 'Vertical Visualizer'
    if ((slot === 'wide' ? projectVizWide : projectViz) === url) return (
      <span className="flex items-center gap-1 text-sm font-medium flex-shrink-0" style={{ color: 'var(--accent)' }}>
        <Check size={13} strokeWidth={3} /> {label}
      </span>
    )
    return (
      <button
        onClick={() => setProjectVisualizer(slot, url)}
        disabled={settingViz}
        className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 flex-shrink-0"
        style={{ backgroundColor: 'var(--surface-2)', color: 'var(--text)' }}
      >
        <MonitorPlay size={14} />
        {settingViz ? 'Setting…' : `Set as ${label}`}
      </button>
    )
  }

  // Project Visualizers section — shown on the project page (where
  // onVisualizerUpdated is wired); rendered even before any artwork exists so
  // a previously set visualizer never disappears.
  const projectVizSection = projectId && onVisualizerUpdated ? (
    <PinSlots
      projectViz={projectViz}
      projectVizWide={projectVizWide}
      settingViz={settingViz}
      vizError={vizError}
      pickerSlot={pickerSlot}
      library={library}
      libraryLoading={libraryLoading}
      libraryError={libraryError}
      onOpenPicker={openPicker}
      onClosePicker={() => setPickerSlot(null)}
      onPick={pickFromLibrary}
      onRemove={slot => setProjectVisualizer(slot, null)}
    />
  ) : null

  if (!artworkUrl) {
    return (
      <div className="max-w-4xl space-y-6">
        {projectVizSection}
        <div className="flex flex-col items-center justify-center py-24 text-center gap-4">
          <Film size={40} style={{ color: 'var(--surface-3)' }} />
          <p style={{ color: 'var(--text-muted)' }}>No artwork yet. Generate artwork first.</p>
          <button
            onClick={onSwitchToArtwork}
            className="text-sm px-4 py-2 rounded-xl transition-colors"
            style={{ backgroundColor: 'var(--accent)', color: 'var(--bg-page)' }}
          >
            Go to Artwork tab
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-4xl space-y-6">
      {projectVizSection}

      {/* Artwork preview */}
      <div className="flex items-center gap-4">
        <div className="relative w-20 h-20 rounded-xl overflow-hidden flex-shrink-0" style={{ backgroundColor: 'var(--surface)' }}>
          <Image src={artworkUrl} alt="Artwork" fill className="object-cover" unoptimized />
        </div>
        <div>
          <p className="font-semibold" style={{ color: 'var(--text)' }}>{projectTitle}</p>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Animate this artwork into a video loop</p>
        </div>
      </div>

      {/* key: a format switch remounts the studio, cancelling any in-flight
          render and clearing transient results (the old resetFormat semantics).
          The recipe itself lives up here, so tweaks survive the remount. */}
      <FreeStudio
        key={recipe.format}
        projectId={projectId}
        artworkUrl={artworkUrl}
        recipe={recipe}
        dispatch={dispatch}
        onSelectFormat={(f: Format) => dispatch({ type: 'format', format: f })}
        pinButton={pinButton}
        download={download}
        downloadErr={downloadErr}
        finishSave={finishSave}
        onFinishSaveTap={finishSaveTap}
      />

      <AiGeneratorCard
        artworkUrl={artworkUrl}
        projectId={projectId}
        pinButton={pinButton}
        download={download}
        downloadErr={downloadErr}
        finishSave={finishSave}
        onFinishSaveTap={finishSaveTap}
      />
    </div>
  )
}
