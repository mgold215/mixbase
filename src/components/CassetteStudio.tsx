'use client'

import { useCallback, useEffect, useState, type ChangeEvent } from 'react'
import { Camera, PenLine, Shuffle, Image as ImageIcon, X, RefreshCw, Film, ExternalLink } from 'lucide-react'
import { TEXT_COLORS } from '@/lib/text-colors'
import { CASSETTE_SCENES, MAX_CUSTOM_SETTING } from '@/lib/cassette-scenes'

// Cassette Studio — the artist's REAL cassette photo, dropped into a new
// scene, lettered in their own handwriting. One click per cover once the
// cassette and the handwriting are in. See src/lib/cassette-studio.ts for how
// the composite is built and why the cassette's pixels are never generated.

type StudioFile = { path: string; url: string; createdAt: string | null }
type Position = 'bottom-left' | 'bottom-center' | 'bottom-right' | 'top-left' | 'top-center' | 'top-right'
type Size = 'small' | 'medium' | 'large'
type SceneChoice = 'random' | 'custom' | 'photo' | string

// Moving cover formats — the ids and sizes of FREE_FORMATS in
// src/lib/free-render.ts (POST /api/cassette-studio/motion validates them).
type MotionFormat = 'canvas' | 'square' | 'youtube' | 'story'
const MOTION_FORMATS: { value: MotionFormat; label: string }[] = [
  { value: 'canvas', label: 'Canvas 9:16' },
  { value: 'square', label: 'Square' },
  { value: 'youtube', label: 'YouTube 16:9' },
  { value: 'story', label: 'Story' },
]

const POSITIONS: { value: Position; label: string }[] = [
  { value: 'top-left', label: '↖' }, { value: 'top-center', label: '↑' }, { value: 'top-right', label: '↗' },
  { value: 'bottom-left', label: '↙' }, { value: 'bottom-center', label: '↓' }, { value: 'bottom-right', label: '↘' },
]

// Photos are resized IN THE BROWSER before upload: phone photos are 3–12 MB
// and Railway's proxy truncates request bodies at 10 MB. Drawing through a
// canvas also turns an iPhone HEIC into a JPEG the server can read.
async function downscale(file: File, maxEdge: number): Promise<Blob> {
  const url = URL.createObjectURL(file)
  try {
    const img = new window.Image()
    img.src = url
    await img.decode()
    const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight))
    const w = Math.max(1, Math.round(img.naturalWidth * scale))
    const h = Math.max(1, Math.round(img.naturalHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not read that image.')
    ctx.drawImage(img, 0, 0, w, h)
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not read that image.'))), 'image/jpeg', 0.92))
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  return res.json().catch(() => null)
}

// Checkerboard so a cut-out's transparency (and clear plastic) is visible.
const CHECKER = {
  backgroundColor: '#1a1a1a',
  backgroundImage: 'linear-gradient(45deg,#262626 25%,transparent 25%,transparent 75%,#262626 75%),linear-gradient(45deg,#262626 25%,transparent 25%,transparent 75%,#262626 75%)',
  backgroundSize: '12px 12px',
  backgroundPosition: '0 0,6px 6px',
}

type Props = {
  projectId: string
  onRendered: (artworkUrl: string, finalizedUrl: string | null) => void
  onClose: () => void
}

export default function CassetteStudio({ projectId, onRendered, onClose }: Props) {
  const [subjects, setSubjects] = useState<StudioFile[]>([])
  const [lettering, setLettering] = useState<StudioFile[]>([])
  const [subject, setSubject] = useState<string | null>(null)
  const [letterPath, setLetterPath] = useState<string | null>(null)
  const [useLettering, setUseLettering] = useState(true)
  const [color, setColor] = useState<string>('auto')
  const [position, setPosition] = useState<Position>('bottom-left')
  const [size, setSize] = useState<Size>('medium')
  const [scene, setScene] = useState<SceneChoice>('random')
  const [setting, setSetting] = useState('')
  const [bgFile, setBgFile] = useState<Blob | null>(null)
  const [bgPreview, setBgPreview] = useState<string | null>(null)
  const [glossy, setGlossy] = useState(false)
  const [busy, setBusy] = useState<null | 'load' | 'subject' | 'lettering' | 'render' | 'reletter'>('load')
  const [error, setError] = useState('')
  const [lastScene, setLastScene] = useState<string | null>(null)
  const [hasRendered, setHasRendered] = useState(false)
  // Moving cover (no AI): the cover just made, animated — reels turning,
  // camera drift, live grain. Reset whenever a new cover replaces it.
  const [motionFormat, setMotionFormat] = useState<MotionFormat>('canvas')
  const [motionBusy, setMotionBusy] = useState(false)
  const [motionError, setMotionError] = useState('')
  const [motionVideo, setMotionVideo] = useState<{ url: string; format: MotionFormat } | null>(null)
  // The project's CURRENT cover can already move (a studio cover with its
  // layers saved) — offers the row on open, not only after a new render.
  const [canMove, setCanMove] = useState(false)

  const load = useCallback(async () => {
    // Best-effort: a failed check only hides the row until the next render.
    fetch(`/api/cassette-studio/motion?project_id=${projectId}`)
      .then(r => (r.ok ? readJson(r) : null))
      .then(d => setCanMove(d?.available === true))
      .catch(() => {})
    try {
      const res = await fetch(`/api/cassette-studio?project_id=${projectId}`)
      const data = await readJson(res)
      if (!res.ok || !data) throw new Error((data?.error as string) ?? 'Could not load your studio.')
      const subs = (data.subjects as StudioFile[]) ?? []
      const lets = (data.lettering as StudioFile[]) ?? []
      setSubjects(subs)
      setLettering(lets)
      setSubject(prev => prev ?? subs[0]?.path ?? null)
      setLetterPath(prev => prev ?? lets[0]?.path ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your studio.')
    } finally {
      setBusy(null)
    }
  }, [projectId])

  useEffect(() => { void load() }, [load])
  useEffect(() => () => { if (bgPreview) URL.revokeObjectURL(bgPreview) }, [bgPreview])

  async function addSubject(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setBusy('subject')
    setError('')
    try {
      const form = new FormData()
      form.append('photo', await downscale(file, 2400), 'cassette.jpg')
      const res = await fetch('/api/cassette-studio/subject', { method: 'POST', body: form })
      const data = await readJson(res)
      if (!res.ok || !data?.subject) throw new Error((data?.error as string) ?? 'Could not cut out the cassette.')
      const s = data.subject as StudioFile
      setSubjects(prev => [s, ...prev])
      setSubject(s.path)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not cut out the cassette.')
    } finally {
      setBusy(null)
    }
  }

  async function addLettering(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setBusy('lettering')
    setError('')
    try {
      const form = new FormData()
      form.append('project_id', projectId)
      form.append('photo', await downscale(file, 2400), 'lettering.jpg')
      const res = await fetch('/api/cassette-studio/lettering', { method: 'POST', body: form })
      const data = await readJson(res)
      if (!res.ok || !data?.lettering) throw new Error((data?.error as string) ?? 'Could not read your handwriting.')
      const l = data.lettering as StudioFile
      setLettering(prev => [l, ...prev])
      setLetterPath(l.path)
      setUseLettering(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read your handwriting.')
    } finally {
      setBusy(null)
    }
  }

  async function removeFile(path: string, kind: 'subject' | 'lettering') {
    setError('')
    const res = await fetch(`/api/cassette-studio?path=${encodeURIComponent(path)}`, { method: 'DELETE' }).catch(() => null)
    if (!res?.ok) { setError('Could not remove that.'); return }
    if (kind === 'subject') {
      setSubjects(prev => prev.filter(s => s.path !== path))
      setSubject(prev => (prev === path ? subjects.find(s => s.path !== path)?.path ?? null : prev))
    } else {
      setLettering(prev => prev.filter(l => l.path !== path))
      setLetterPath(prev => (prev === path ? lettering.find(l => l.path !== path)?.path ?? null : prev))
    }
  }

  async function chooseBackground(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError('')
    try {
      const blob = await downscale(file, 3000)
      setBgFile(blob)
      setBgPreview(URL.createObjectURL(blob))
      setScene('photo')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that image.')
    }
  }

  async function render(mode: 'scene' | 'reletter') {
    setBusy(mode === 'scene' ? 'render' : 'reletter')
    setError('')
    try {
      const form = new FormData()
      form.append('project_id', projectId)
      form.append('scene', mode === 'reletter' ? 'keep' : scene)
      if (subject) form.append('subject', subject)
      if (scene === 'custom') form.append('setting', setting)
      if (mode === 'scene' && scene === 'photo' && bgFile) form.append('background', bgFile, 'background.jpg')
      if (useLettering && letterPath) form.append('lettering', letterPath)
      form.append('color', color)
      form.append('position', position)
      form.append('size', size)
      if (glossy) form.append('reflection', '1')
      const res = await fetch('/api/cassette-studio/render', { method: 'POST', body: form })
      const data = await readJson(res)
      if (!res.ok || !data?.artwork_url) throw new Error((data?.error as string) ?? 'Could not make the cover.')
      onRendered(data.artwork_url as string, (data.finalized_artwork_url as string | null) ?? null)
      if (mode === 'scene') setLastScene((data.scene_label as string | null) ?? null)
      setHasRendered(true)
      setMotionVideo(null)
      setMotionError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error. Try again.')
    } finally {
      setBusy(null)
    }
  }

  async function makeItMove() {
    setMotionBusy(true)
    setMotionError('')
    try {
      const format = motionFormat
      const res = await fetch('/api/cassette-studio/motion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, format }),
      })
      const data = await readJson(res)
      if (!res.ok || typeof data?.video_url !== 'string') throw new Error((data?.error as string) ?? 'Could not render the moving cover.')
      setMotionVideo({ url: data.video_url, format })
    } catch (err) {
      setMotionError(err instanceof Error ? err.message : 'Network error. Try again.')
    } finally {
      setMotionBusy(false)
    }
  }

  // A moving-cover render reads the CURRENT cover's layers server-side, so a
  // new cover must not replace it mid-render.
  const working = busy !== null || motionBusy
  const canRender = !!subject && !working && (scene !== 'custom' || setting.trim().length > 0) && (scene !== 'photo' || !!bgFile)
  const currentLettering = lettering.find(l => l.path === letterPath) ?? null

  return (
    <div className="space-y-4 rounded-xl border border-[#222] bg-[#0f0f0f] p-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-white">Cassette Studio</p>
        <button onClick={onClose} className="text-[#555] hover:text-white" aria-label="Close Cassette Studio"><X size={14} /></button>
      </div>

      {/* 1 — Cassette */}
      <section className="space-y-2">
        <p className="text-[11px] font-medium text-[#999]">1 · Your cassette</p>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {subjects.map(s => (
            <div key={s.path} className="relative shrink-0">
              <button
                onClick={() => setSubject(s.path)}
                className={`block w-20 h-14 rounded-lg overflow-hidden border-2 ${subject === s.path ? 'border-[#2dd4bf]' : 'border-transparent'}`}
                style={CHECKER}
                aria-label="Use this cassette"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={s.url} alt="" className="w-full h-full object-contain" />
              </button>
              <button onClick={() => removeFile(s.path, 'subject')} className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-[#222] text-[#888] hover:text-white flex items-center justify-center" aria-label="Remove cassette"><X size={9} /></button>
            </div>
          ))}
          <label className={`shrink-0 w-20 h-14 rounded-lg border border-dashed border-[#333] flex flex-col items-center justify-center gap-0.5 text-[9px] text-[#777] ${working ? 'opacity-50' : 'cursor-pointer hover:text-white hover:border-[#555]'}`}>
            {busy === 'subject'
              ? <><span className="w-3 h-3 border border-white/30 border-t-white rounded-full animate-spin" />Cutting out…</>
              : <><Camera size={13} />Add photo</>}
            <input type="file" accept="image/*" onChange={addSubject} disabled={working} className="hidden" />
          </label>
        </div>
        {subjects.length === 0 && busy !== 'load' && (
          <p className="text-[10px] text-[#666] leading-snug">
            Snap your cassette straight on, at its own height, standing on a table. A plain wall or card behind it gives the cleanest result. We cut it out once and reuse it for every cover. The cassette is never AI-generated.
          </p>
        )}
      </section>

      {/* 2 — Handwriting */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-medium text-[#999]">2 · Your handwriting</p>
          {currentLettering && (
            <button onClick={() => setUseLettering(v => !v)} className="flex items-center gap-1.5 text-[10px] text-[#888] hover:text-white">
              <span className={`w-7 h-3.5 rounded-full relative transition-colors ${useLettering ? 'bg-[#2dd4bf]' : 'bg-[#2a2a2a]'}`}>
                <span className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white transition-all ${useLettering ? 'left-4' : 'left-0.5'}`} />
              </span>
              On cover
            </button>
          )}
        </div>
        <div className="flex gap-2 items-stretch">
          {currentLettering && (
            <div className="relative flex-1 h-16 rounded-lg bg-[#2a3340] flex items-center justify-center overflow-hidden">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={currentLettering.url} alt="Your handwriting" className="max-h-full max-w-full object-contain p-1.5" />
              <button onClick={() => removeFile(currentLettering.path, 'lettering')} className="absolute top-1 right-1 w-4 h-4 rounded-full bg-black/50 text-[#aaa] hover:text-white flex items-center justify-center" aria-label="Remove handwriting"><X size={9} /></button>
            </div>
          )}
          <label className={`${currentLettering ? 'w-20' : 'flex-1'} h-16 rounded-lg border border-dashed border-[#333] flex flex-col items-center justify-center gap-0.5 text-[9px] text-[#777] text-center px-1 ${working ? 'opacity-50' : 'cursor-pointer hover:text-white hover:border-[#555]'}`}>
            {busy === 'lettering'
              ? <><span className="w-3 h-3 border border-white/30 border-t-white rounded-full animate-spin" />Reading…</>
              : <><PenLine size={13} />{currentLettering ? 'Replace' : 'Add a photo of your handwriting'}</>}
            <input type="file" accept="image/*" onChange={addLettering} disabled={working} className="hidden" />
          </label>
        </div>
        {!currentLettering && busy !== 'load' && (
          <p className="text-[10px] text-[#666] leading-snug">Write the artist name and song title with a marker on plain paper and photograph it flat. Your exact strokes are lifted off the paper, with no font and no AI.</p>
        )}
        {currentLettering && useLettering && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-1">
              <button onClick={() => setColor('auto')} className={`px-2 h-6 rounded-md text-[10px] ${color === 'auto' ? 'bg-[#2dd4bf]/20 text-[#2dd4bf]' : 'bg-[#1a1a1a] text-[#777]'}`}>Auto</button>
              {TEXT_COLORS.map(c => (
                <button key={c.value} onClick={() => setColor(c.value)} title={c.label} aria-label={c.label}
                  className={`w-6 h-6 rounded-md border ${color === c.value ? 'border-[#2dd4bf]' : 'border-[#333]'}`} style={{ backgroundColor: c.value }} />
              ))}
            </div>
            <div className="grid grid-cols-3 gap-0.5">
              {POSITIONS.map(p => (
                <button key={p.value} onClick={() => setPosition(p.value)} aria-label={p.value}
                  className={`w-6 h-5 rounded text-[10px] ${position === p.value ? 'bg-[#2dd4bf]/20 text-[#2dd4bf]' : 'bg-[#1a1a1a] text-[#666]'}`}>{p.label}</button>
              ))}
            </div>
            <div className="flex gap-0.5">
              {(['small', 'medium', 'large'] as Size[]).map(s => (
                <button key={s} onClick={() => setSize(s)}
                  className={`w-6 h-6 rounded text-[10px] ${size === s ? 'bg-[#2dd4bf]/20 text-[#2dd4bf]' : 'bg-[#1a1a1a] text-[#666]'}`}>{s[0].toUpperCase()}</button>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* 3 — Scene */}
      <section className="space-y-2">
        <p className="text-[11px] font-medium text-[#999]">3 · Scene</p>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setScene('random')} className={`flex items-center gap-1 px-2 py-1 rounded-md text-[10px] ${scene === 'random' ? 'bg-[#2dd4bf]/20 text-[#2dd4bf]' : 'bg-[#1a1a1a] text-[#888] hover:text-white'}`}>
            <Shuffle size={10} />Surprise me
          </button>
          {CASSETTE_SCENES.map(s => (
            <button key={s.id} onClick={() => setScene(s.id)} className={`px-2 py-1 rounded-md text-[10px] ${scene === s.id ? 'bg-[#2dd4bf]/20 text-[#2dd4bf]' : 'bg-[#1a1a1a] text-[#888] hover:text-white'}`}>
              {s.label}
            </button>
          ))}
          <button onClick={() => setScene('custom')} className={`px-2 py-1 rounded-md text-[10px] ${scene === 'custom' ? 'bg-[#2dd4bf]/20 text-[#2dd4bf]' : 'bg-[#1a1a1a] text-[#888] hover:text-white'}`}>
            Describe my own…
          </button>
          <label className={`flex items-center gap-1 px-2 py-1 rounded-md text-[10px] cursor-pointer ${scene === 'photo' ? 'bg-[#2dd4bf]/20 text-[#2dd4bf]' : 'bg-[#1a1a1a] text-[#888] hover:text-white'}`}>
            <ImageIcon size={10} />My own photo (no AI)
            <input type="file" accept="image/*" onChange={chooseBackground} className="hidden" />
          </label>
        </div>
        {scene === 'custom' && (
          <input
            value={setting}
            onChange={e => setSetting(e.target.value.slice(0, MAX_CUSTOM_SETTING))}
            placeholder="What it stands on and what's behind it, e.g. 'a hotel bar counter, city lights through the window at night'"
            className="w-full bg-[#0a0a0a] border border-[#222] rounded-lg px-2.5 py-1.5 text-[11px] text-white placeholder-[#444] focus:outline-none focus:border-[#2dd4bf]/40"
          />
        )}
        {scene === 'photo' && bgPreview && (
          <div className="flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={bgPreview} alt="Your background" className="w-14 h-14 rounded-md object-cover" />
            <div className="space-y-1">
              <p className="text-[10px] text-[#666] leading-snug">Your photo is the background, with no AI. Shoot a ledge, table or counter at table height, with room in the middle for the cassette.</p>
              <button onClick={() => setGlossy(v => !v)} className="flex items-center gap-1.5 text-[10px] text-[#888] hover:text-white">
                <span className={`w-7 h-3.5 rounded-full relative transition-colors ${glossy ? 'bg-[#2dd4bf]' : 'bg-[#2a2a2a]'}`}>
                  <span className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white transition-all ${glossy ? 'left-4' : 'left-0.5'}`} />
                </span>
                Glossy surface (adds a reflection)
              </button>
            </div>
          </div>
        )}
      </section>

      {error && <p className="text-red-400 text-xs">{error}</p>}
      {lastScene && !working && <p className="text-[10px] text-[#666]">Last scene: {lastScene}</p>}

      <div className="flex gap-2">
        <button
          onClick={() => render('scene')}
          disabled={!canRender}
          className="flex-1 flex items-center justify-center gap-2 py-2.5 text-xs font-semibold bg-[#2dd4bf] text-[#0a0a0a] rounded-xl hover:bg-[#14b8a6] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {busy === 'render'
            ? <><span className="w-3 h-3 border border-black/30 border-t-black rounded-full animate-spin" />{scene === 'photo' ? 'Compositing…' : 'Building the scene (~30s)…'}</>
            : <>{hasRendered ? <RefreshCw size={13} /> : <Camera size={13} />}{hasRendered ? 'Make another' : 'Make cover'}</>}
        </button>
        {hasRendered && currentLettering && useLettering && (
          <button
            onClick={() => render('reletter')}
            disabled={working}
            title="Apply the handwriting colour/position/size to the current cover without a new scene"
            className="px-3 py-2.5 text-xs font-medium bg-[#1e1e1e] border border-[#333] text-white rounded-xl hover:bg-[#2a2a2a] disabled:opacity-40 transition-colors"
          >
            {busy === 'reletter' ? 'Updating…' : 'Update text only'}
          </button>
        )}
      </div>
      {!subject && busy !== 'load' && <p className="text-[10px] text-[#666]">Add a cassette photo to start.</p>}

      {/* 4 — Make it move: the cover just made as a looping clip, no AI. */}
      {(hasRendered || canMove) && (
        <section className="space-y-2 border-t border-[#1e1e1e] pt-3">
          <p className="text-[11px] font-medium text-[#999]">Make it move</p>
          <div className="flex flex-wrap items-center gap-1">
            {MOTION_FORMATS.map(f => (
              <button
                key={f.value}
                onClick={() => setMotionFormat(f.value)}
                disabled={motionBusy}
                className={`px-2 py-1 rounded-md text-[10px] ${motionFormat === f.value ? 'bg-[#2dd4bf]/20 text-[#2dd4bf]' : 'bg-[#1a1a1a] text-[#888] hover:text-white'} disabled:opacity-50`}
              >
                {f.label}
              </button>
            ))}
            <button
              onClick={makeItMove}
              disabled={working}
              className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium bg-[#1e1e1e] border border-[#333] text-white rounded-lg hover:bg-[#2a2a2a] disabled:opacity-40 transition-colors"
            >
              {motionBusy
                ? <><span className="w-3 h-3 border border-white/30 border-t-white rounded-full animate-spin" />{motionFormat === 'youtube' ? 'Rendering (~1 min)…' : 'Rendering…'}</>
                : <><Film size={12} />Make it move</>}
            </button>
          </div>
          <p className="text-[10px] text-[#666] leading-snug">The reels turn, the camera drifts and the film grain moves. Built from this cover itself, with no AI. Saved to your visualizers.</p>
          {motionError && <p className="text-red-400 text-xs">{motionError}</p>}
          {motionVideo && (
            <div className="space-y-1.5">
              <video
                key={motionVideo.url}
                src={motionVideo.url}
                muted
                loop
                autoPlay
                playsInline
                className={`rounded-lg bg-black ${motionVideo.format === 'youtube' ? 'w-full aspect-video' : motionVideo.format === 'square' ? 'w-48 aspect-square' : 'w-32 aspect-[9/16]'}`}
              />
              <a href={motionVideo.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[10px] text-[#2dd4bf] hover:underline">
                <ExternalLink size={10} />Open the clip
              </a>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
