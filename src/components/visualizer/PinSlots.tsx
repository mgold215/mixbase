'use client'

import { Check, Film, MonitorPlay, X } from 'lucide-react'
import { visualizerKindLabel } from '@/lib/visualizer-kinds'
import type { LibraryItem, VizSlot } from './shared'

type Props = {
  projectViz: string | null
  projectVizWide: string | null
  settingViz: boolean
  vizError: string
  pickerSlot: VizSlot | null
  library: LibraryItem[]
  libraryLoading: boolean
  libraryError: string
  onOpenPicker: (slot: VizSlot) => void
  onClosePicker: () => void
  onPick: (item: LibraryItem) => void
  onRemove: (slot: VizSlot) => void
}

// The videos pinned to this project: the vertical slot loops in the player and
// feeds Finalize Short; the horizontal slot feeds Finalize Full-Length. Also
// hosts the "Choose from Media" library picker modal.
export default function PinSlots({
  projectViz, projectVizWide, settingViz, vizError,
  pickerSlot, library, libraryLoading, libraryError,
  onOpenPicker, onClosePicker, onPick, onRemove,
}: Props) {
  const vizSlotCard = (slot: VizSlot, url: string | null, title: string, blurb: string) => (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>{title}</p>
        <button
          onClick={() => onOpenPicker(slot)}
          disabled={settingViz}
          className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 flex-shrink-0"
          style={{ backgroundColor: 'var(--surface-2)', color: 'var(--text)' }}
        >
          <Film size={14} />
          Choose from Media
        </button>
      </div>
      {url ? (
        <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--surface-2)' }}>
          <video src={url} controls loop autoPlay muted playsInline className="w-full max-h-80 object-contain bg-black" />
          <div className="p-3 flex flex-wrap justify-between items-center gap-2" style={{ backgroundColor: 'var(--bg-page)' }}>
            <span className="text-sm" style={{ color: 'var(--text-muted)' }}>{blurb}</span>
            <button
              onClick={() => onRemove(slot)}
              disabled={settingViz}
              className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 flex-shrink-0"
              style={{ backgroundColor: 'var(--surface-2)', color: '#f87171' }}
            >
              <X size={14} />
              Remove
            </button>
          </div>
        </div>
      ) : (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>None set. {blurb}</p>
      )}
    </div>
  )

  return (
    <div className="rounded-2xl p-5 space-y-5" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--surface-2)' }}>
      <div className="flex items-center gap-2">
        <MonitorPlay size={16} style={{ color: 'var(--text-muted)' }} />
        <p className="text-sm font-semibold" style={{ color: 'var(--text)' }}>Project Visualizers</p>
      </div>
      {vizSlotCard('canvas', projectViz, 'Vertical · player + Short',
        'Loops in the player while this track plays (like a Spotify Canvas) and is the source for Finalize Short.')}
      {vizSlotCard('wide', projectVizWide, 'Horizontal · full-length video',
        'The 16:9 loop behind the full-length YouTube render (Video tab → Finalize Full-Length).')}
      {vizError && <p className="text-sm" style={{ color: '#f87171' }}>{vizError}</p>}

      {/* Library picker — every saved loop the user owns, any project */}
      {pickerSlot && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0,0,0,0.75)' }}
          onClick={e => { if (e.target === e.currentTarget) onClosePicker() }}
        >
          <div className="w-full max-w-2xl rounded-2xl overflow-hidden flex flex-col" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)', maxHeight: '85dvh' }}>
            <div className="flex items-center justify-between px-5 py-4 border-b flex-shrink-0" style={{ borderColor: 'var(--border)' }}>
              <h3 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
                {pickerSlot === 'wide' ? 'Choose the horizontal visualizer' : 'Choose the vertical visualizer'}
              </h3>
              <button onClick={onClosePicker} aria-label="Close" className="transition-colors" style={{ color: 'var(--text-muted)' }}>
                <X size={16} />
              </button>
            </div>
            <div className="p-4 overflow-y-auto overscroll-contain">
              {libraryLoading ? (
                <p className="text-sm text-center py-10" style={{ color: 'var(--text-muted)' }}>Loading…</p>
              ) : libraryError ? (
                <p className="text-sm text-center py-10" style={{ color: '#f87171' }}>{libraryError}</p>
              ) : library.length === 0 ? (
                <p className="text-sm text-center py-10" style={{ color: 'var(--text-muted)' }}>
                  No saved visualizers yet — generate one below and it will appear here.
                </p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {library.map(item => {
                    const isCurrent = (pickerSlot === 'wide' ? projectVizWide : projectViz) === item.video_url
                    return (
                      <button
                        key={item.id}
                        onClick={() => onPick(item)}
                        disabled={settingViz}
                        className="text-left rounded-xl overflow-hidden transition-all disabled:opacity-50"
                        style={{
                          border: isCurrent ? '2px solid var(--accent)' : '1px solid var(--surface-2)',
                          backgroundColor: 'var(--bg-page)',
                        }}
                      >
                        <video
                          src={item.video_url}
                          poster={item.source_image_url ?? undefined}
                          muted
                          playsInline
                          loop
                          autoPlay
                          preload="metadata"
                          className="w-full aspect-square object-cover bg-black"
                        />
                        <div className="px-2.5 py-2">
                          <p className="text-xs font-medium truncate" style={{ color: 'var(--text)' }}>
                            {item.title ?? 'Visualizer'}
                          </p>
                          <p className="text-[10px] flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
                            {isCurrent ? (
                              <span className="flex items-center gap-1" style={{ color: 'var(--accent)' }}>
                                <Check size={10} strokeWidth={3} /> Current
                              </span>
                            ) : (
                              `${visualizerKindLabel(item.kind)} · ${new Date(item.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
                            )}
                          </p>
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
