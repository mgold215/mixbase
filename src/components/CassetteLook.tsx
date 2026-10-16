'use client'

import { useEffect, useRef, useState } from 'react'
import { Check, RotateCcw } from 'lucide-react'

// Cassette Studio, "Finish the look": film looks and sliders over the finished
// cover. All pixel work happens server-side (POST /api/cassette-studio/filter)
// on the UNFILTERED cover, so the preview is exactly what gets saved and a new
// look never stacks on an old one. The server owns the presets; this file only
// edits the numbers and shows the result.

export type LookTone = 'color' | 'bw' | 'sepia'
export type FilterSettings = {
  preset: string
  brightness: number
  contrast: number
  saturation: number
  warmth: number
  fade: number
  grain: number
  vignette: number
  tone: LookTone
}
type AdjustmentId = 'brightness' | 'contrast' | 'saturation' | 'warmth' | 'fade' | 'grain' | 'vignette'
type Adjustment = { id: AdjustmentId; label: string; min: number; max: number }
type Preset = { id: string; label: string; settings: FilterSettings }

// The API contract's ranges. Also the slider list if the server sends none.
const ADJUSTMENTS: Adjustment[] = [
  { id: 'brightness', label: 'Brightness', min: -100, max: 100 },
  { id: 'contrast', label: 'Contrast', min: -100, max: 100 },
  { id: 'saturation', label: 'Saturation', min: -100, max: 100 },
  { id: 'warmth', label: 'Warmth', min: -100, max: 100 },
  { id: 'fade', label: 'Fade', min: 0, max: 100 },
  { id: 'grain', label: 'Grain', min: 0, max: 100 },
  { id: 'vignette', label: 'Vignette', min: 0, max: 100 },
]
const PRESET_IDS = ['original', 'film', 'faded', 'warm', 'cool', 'noir', 'mono', 'sepia', 'punch', 'dusk', 'custom']
const TONES: { value: LookTone; label: string }[] = [
  { value: 'color', label: 'Color' },
  { value: 'bw', label: 'B&W' },
  { value: 'sepia', label: 'Sepia' },
]

export const ORIGINAL_LOOK: FilterSettings = {
  preset: 'original', brightness: 0, contrast: 0, saturation: 0, warmth: 0, fade: 0, grain: 0, vignette: 0, tone: 'color',
}

/** Same pixels: the numbers and the tone match (the preset id is only a label). */
export function sameLook(a: FilterSettings, b: FilterSettings): boolean {
  return a.tone === b.tone && ADJUSTMENTS.every(({ id }) => a[id] === b[id])
}

export const isOriginalLook = (s: FilterSettings) => sameLook(s, ORIGINAL_LOOK)

/** FilterSettings from untrusted JSON (the server, localStorage): whole numbers clamped to range, or null. */
export function normalizeLook(x: unknown): FilterSettings | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null
  const o = x as Record<string, unknown>
  if (o.tone !== 'color' && o.tone !== 'bw' && o.tone !== 'sepia') return null
  const preset = typeof o.preset === 'string' && PRESET_IDS.includes(o.preset) ? o.preset : 'custom'
  const out: FilterSettings = { ...ORIGINAL_LOOK, preset, tone: o.tone }
  for (const { id, min, max } of ADJUSTMENTS) {
    const v = o[id]
    if (typeof v !== 'number' || !Number.isFinite(v)) return null
    out[id] = Math.min(max, Math.max(min, Math.round(v)))
  }
  return out
}

const lookKey = (s: FilterSettings) => [s.preset, s.tone, ...ADJUSTMENTS.map(({ id }) => s[id])].join(',')

// "Keep this look for new covers": the toggle and the last saved look, per
// browser. Wrapped because storage throws in private mode or when blocked.
export type LookPrefs = { keep: boolean; look: FilterSettings | null }
const PREFS_KEY = 'mixbase:cassette-look:v1'

export function readLookPrefs(): LookPrefs {
  const fallback: LookPrefs = { keep: true, look: null }
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(PREFS_KEY)
    if (!raw) return fallback
    const o = JSON.parse(raw) as { keep?: unknown; look?: unknown } | null
    return { keep: o?.keep !== false, look: normalizeLook(o?.look) }
  } catch {
    return fallback
  }
}

export function writeLookPrefs(prefs: LookPrefs) {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // storage unavailable: the toggle just resets next visit
  }
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  return res.json().catch(() => null)
}

const errorText = (data: Record<string, unknown> | null, fallback: string) =>
  typeof data?.error === 'string' && data.error ? data.error : fallback

export type SavedLook = { artworkUrl: string | null; finalizedUrl: string | null; filter: FilterSettings | null }

/** Bakes a look into the project's cover. Original resets it. Throws an Error with friendly copy. */
export async function saveLook(projectId: string, settings: FilterSettings): Promise<SavedLook> {
  const res = await fetch('/api/cassette-studio/filter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, settings, mode: 'save' }),
  }).catch(() => null)
  if (!res) throw new Error('Network error. Try again.')
  const data = await readJson(res)
  if (!res.ok || !data) throw new Error(errorText(data, 'Could not save the look. Please try again.'))
  return {
    artworkUrl: typeof data.artwork_url === 'string' ? data.artwork_url : null,
    finalizedUrl: typeof data.finalized_artwork_url === 'string' ? data.finalized_artwork_url : null,
    filter: normalizeLook(data.filter) ?? (isOriginalLook(settings) ? null : settings),
  }
}

type Info = { base: string; presets: Preset[]; adjustments: Adjustment[]; current: FilterSettings | null }

// GET /api/cassette-studio/filter → Info, or null when there is no cover to edit.
function parseInfo(d: Record<string, unknown>): Info | null {
  if (typeof d.base_url !== 'string' || !d.base_url) return null
  const presets: Preset[] = []
  for (const p of Array.isArray(d.presets) ? d.presets as Record<string, unknown>[] : []) {
    const settings = normalizeLook(p?.settings)
    if (!settings || typeof p.id !== 'string' || !PRESET_IDS.includes(p.id) || typeof p.label !== 'string') continue
    presets.push({ id: p.id, label: p.label, settings: { ...settings, preset: p.id } })
  }
  const adjustments: Adjustment[] = []
  for (const a of Array.isArray(d.adjustments) ? d.adjustments as Record<string, unknown>[] : []) {
    const known = ADJUSTMENTS.find(k => k.id === a?.id)
    if (!known) continue
    adjustments.push({
      ...known,
      label: typeof a.label === 'string' && a.label ? a.label : known.label,
      min: typeof a.min === 'number' ? Math.max(known.min, a.min) : known.min,
      max: typeof a.max === 'number' ? Math.min(known.max, a.max) : known.max,
    })
  }
  return {
    base: d.base_url,
    presets,
    adjustments: adjustments.length ? adjustments : ADJUSTMENTS,
    current: normalizeLook(d.current),
  }
}

type Shown = { base: string; key: string }

type Props = {
  projectId: string
  /** Bumped by the studio after every new cover so the editor re-reads it. */
  refreshKey: number
  /** Another studio job (render, cut-out, moving cover, a save) is running. */
  disabled: boolean
  saving: boolean
  prefs: LookPrefs
  onPrefsChange: (prefs: LookPrefs) => void
  /** Saves the look as the cover; the studio updates the Artwork tab. Rejects with friendly copy. */
  onSave: (settings: FilterSettings) => Promise<SavedLook>
}

export default function CassetteLook({ projectId, refreshKey, disabled, saving, prefs, onPrefsChange, onSave }: Props) {
  const [info, setInfo] = useState<Info | null>(null)
  const [look, setLook] = useState<FilterSettings>(ORIGINAL_LOOK)
  const [preview, setPreview] = useState<(Shown & { url: string }) | null>(null)
  const [previewFailed, setPreviewFailed] = useState<(Shown & { message: string }) | null>(null)
  const [saveError, setSaveError] = useState('')
  const [justSaved, setJustSaved] = useState(false)
  // The preview request in flight; a newer one cancels it when it starts.
  const inflight = useRef<AbortController | null>(null)

  // What can be edited, and the look already on the cover. On open and after
  // every new cover. Best-effort: a failed read just hides the section.
  useEffect(() => {
    const ctrl = new AbortController()
    fetch(`/api/cassette-studio/filter?project_id=${projectId}`, { signal: ctrl.signal })
      .then(r => (r.ok ? readJson(r) : null))
      .then(d => {
        if (ctrl.signal.aborted) return
        const next = d ? parseInfo(d) : null
        setInfo(next)
        setLook(next?.current ?? ORIGINAL_LOOK)
        setJustSaved(false)
        setSaveError('')
      })
      .catch(() => { if (!ctrl.signal.aborted) setInfo(null) })
    return () => ctrl.abort()
  }, [projectId, refreshKey])

  const base = info?.base ?? null

  // Live preview, ~250 ms after the last change. Original needs no request:
  // it is the unfiltered cover itself.
  useEffect(() => {
    if (!base || isOriginalLook(look)) return
    const shown: Shown = { base, key: lookKey(look) }
    const timer = setTimeout(() => {
      // Cancelled only once a newer preview starts, so a slow drag still shows
      // the in-between results.
      inflight.current?.abort()
      const ctrl = new AbortController()
      inflight.current = ctrl
      setPreviewFailed(null)
      fetch('/api/cassette-studio/filter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, settings: look, mode: 'preview' }),
        signal: ctrl.signal,
      })
        .then(async res => {
          if (!res.ok || !res.headers.get('content-type')?.startsWith('image/')) {
            throw new Error(errorText(await readJson(res), 'Preview unavailable. Try again.'))
          }
          return res.blob()
        })
        .then(blob => {
          if (!ctrl.signal.aborted) setPreview({ ...shown, url: URL.createObjectURL(blob) })
        })
        .catch(err => {
          if (ctrl.signal.aborted) return
          // A TypeError is the network or a cut-off body, not the server's copy.
          const message = err instanceof Error && !(err instanceof TypeError) ? err.message : 'Preview unavailable. Try again.'
          setPreviewFailed({ ...shown, message })
        })
    }, 250)
    return () => clearTimeout(timer)
  }, [base, look, projectId])

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url) }, [preview])
  useEffect(() => {
    const pending = inflight
    return () => pending.current?.abort()
  }, [])

  if (!info || !base) return null

  const original = isOriginalLook(look)
  const key = lookKey(look)
  const matches = (s: Shown | null) => !!s && s.base === base && s.key === key
  const src = !original && preview?.base === base ? preview.url : base
  const failMessage = !original && !matches(preview) && matches(previewFailed) ? previewFailed!.message : ''
  const waiting = !original && !matches(preview) && !failMessage
  const dirty = !sameLook(look, info.current ?? ORIGINAL_LOOK)

  function choose(settings: FilterSettings) {
    setLook(settings)
    setSaveError('')
  }

  function adjust(id: AdjustmentId, value: number) {
    setLook(prev => {
      const next: FilterSettings = { ...prev, preset: 'custom' }
      next[id] = value
      return next
    })
    setSaveError('')
  }

  async function save() {
    setSaveError('')
    setJustSaved(false)
    try {
      const saved = await onSave(look)
      setInfo(prev => (prev ? { ...prev, current: saved.filter } : prev))
      setJustSaved(true)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save the look. Please try again.')
    }
  }

  return (
    <section className="space-y-2.5 border-t border-[#1e1e1e] pt-3">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-medium text-[#999]">4 · Finish the look</p>
        <button
          onClick={() => choose(ORIGINAL_LOOK)}
          disabled={original && look.preset === 'original'}
          className="flex items-center gap-1 text-[10px] text-[#888] hover:text-white disabled:opacity-40 disabled:hover:text-[#888]"
        >
          <RotateCcw size={10} />Reset
        </button>
      </div>

      <div className="relative mx-auto w-full max-w-xs aspect-square rounded-lg overflow-hidden bg-black">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt="Your cover with this look" className="w-full h-full object-contain" />
        {waiting && (
          <span className="absolute top-2 right-2 w-6 h-6 rounded-full bg-black/60 flex items-center justify-center" aria-label="Updating preview">
            <span className="w-3 h-3 border border-white/30 border-t-white rounded-full animate-spin" />
          </span>
        )}
      </div>
      {failMessage && <p className="text-[10px] text-[#888] text-center">{failMessage}</p>}

      {info.presets.length > 0 && (
        <div className="flex gap-1 overflow-x-auto pb-1">
          {info.presets.map(p => (
            <button
              key={p.id}
              onClick={() => choose(p.settings)}
              className={`shrink-0 px-2.5 py-1 rounded-md text-[10px] ${look.preset === p.id ? 'bg-[#2dd4bf]/20 text-[#2dd4bf]' : 'bg-[#1a1a1a] text-[#888] hover:text-white'}`}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-3 gap-0.5 p-0.5 rounded-lg bg-[#1a1a1a]">
        {TONES.map(t => (
          <button
            key={t.value}
            onClick={() => { if (look.tone !== t.value) choose({ ...look, preset: 'custom', tone: t.value }) }}
            className={`py-1 rounded-md text-[10px] ${look.tone === t.value ? 'bg-[#2dd4bf]/20 text-[#2dd4bf]' : 'text-[#888] hover:text-white'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5">
        {info.adjustments.map(a => (
          <label key={a.id} className="block">
            <span className="flex items-center justify-between text-[10px] text-[#888]">
              <span>{a.label}</span>
              <span className="tabular-nums text-[#666]">{look[a.id]}</span>
            </span>
            <input
              type="range"
              min={a.min}
              max={a.max}
              step={1}
              value={look[a.id]}
              onChange={e => adjust(a.id, Math.round(Number(e.target.value)))}
              className="w-full accent-[#2dd4bf]"
            />
          </label>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => onPrefsChange({ ...prefs, keep: !prefs.keep })} className="flex items-center gap-1.5 text-[10px] text-[#888] hover:text-white">
          <span className={`w-7 h-3.5 rounded-full relative transition-colors ${prefs.keep ? 'bg-[#2dd4bf]' : 'bg-[#2a2a2a]'}`}>
            <span className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white transition-all ${prefs.keep ? 'left-4' : 'left-0.5'}`} />
          </span>
          Keep this look for new covers
        </button>
        <div className="ml-auto flex items-center gap-2">
          {justSaved && !dirty && !saving && (
            <span className="flex items-center gap-1 text-[10px] text-[#2dd4bf]"><Check size={11} />Saved</span>
          )}
          <button
            onClick={save}
            disabled={disabled || !dirty}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold bg-[#2dd4bf] text-[#0a0a0a] rounded-lg hover:bg-[#14b8a6] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {saving
              ? <><span className="w-3 h-3 border border-black/30 border-t-black rounded-full animate-spin" />Saving…</>
              : 'Save look'}
          </button>
        </div>
      </div>
      {saveError && <p className="text-red-400 text-xs">{saveError}</p>}
    </section>
  )
}
