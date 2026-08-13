// Shared bits of the Visualizer tab: export formats, pin-slot vocabulary, and
// the library row shape. Split out of the old monolithic Visualizer.tsx so the
// container, FreeStudio, the AI card, and the pin section agree on one source.

import type { VizFormat } from '@/lib/fx/types'

export type Format = VizFormat

// Which project pin a video goes into: 'canvas' = vertical (player + Finalize
// Short), 'wide' = horizontal (Finalize Full-Length).
export type VizSlot = 'canvas' | 'wide'

export const FORMAT_CONFIG: Record<Format, { label: string; width: number; height: number; duration: number; description: string }> = {
  canvas:  { label: 'Spotify Canvas', width: 1080, height: 1920, duration: 6,  description: '9:16 · 6s loop' },
  youtube: { label: 'YouTube',        width: 1920, height: 1080, duration: 30, description: '16:9 · 30s loop' },
  square:  { label: 'Square',         width: 1080, height: 1080, duration: 6,  description: '1:1 · 6s loop' },
  story:   { label: 'Story',          width: 1080, height: 1920, duration: 6,  description: '9:16 · 6s loop' },
}

// A saved video from the user's library (mb_visualizers) — any project, any
// kind: canvas loops, Runway AI, and finished YouTube/Shorts renders.
export type LibraryItem = {
  id: string
  video_url: string
  title: string | null
  kind: string
  project_id: string | null
  source_image_url: string | null
  created_at: string
}

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

// Shared pill button style helper
export const pill = (active: boolean) => active
  ? { backgroundColor: 'var(--accent)', color: 'var(--bg-page)' }
  : { backgroundColor: 'var(--surface)', color: 'var(--text-muted)', border: '1px solid var(--surface-2)' }

export function clampBpm(raw: string, fallback: number): number {
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(200, Math.max(60, n))
}
