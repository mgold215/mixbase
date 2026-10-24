'use client'

import { useCallback, useEffect, useState, type ChangeEvent } from 'react'
import { Camera, PenLine, Shuffle, Image as ImageIcon, Images, X, RefreshCw, Film, ExternalLink, Keyboard, GraduationCap, Pin, Palette, Sparkles } from 'lucide-react'
import { TEXT_COLORS } from '@/lib/text-colors'
import { CASSETTE_SCENES, MAX_CUSTOM_SETTING } from '@/lib/cassette-scenes'
import CassetteLook, {
  isOriginalLook, readLookPrefs, saveLook, writeLookPrefs, type FilterSettings, type LookPrefs, type SavedLook,
} from '@/components/CassetteLook'

// Cassette Studio — the artist's REAL cassette photo, dropped into a new
// scene, lettered in their own handwriting. One click per cover once the
// cassette and the handwriting are in. See src/lib/cassette-studio.ts for how
// the composite is built and why the cassette's pixels are never generated.

type StudioFile = { path: string; url: string; createdAt: string | null }
// An image already in one of the owner's songs (GET /api/cassette-studio/photos).
type MixbasePhoto = { path: string; url: string; thumb_url: string; project_id: string; project_title: string; created_at: string | null }
type Position = 'bottom-left' | 'bottom-center' | 'bottom-right' | 'top-left' | 'top-center' | 'top-right'
type Size = 'small' | 'medium' | 'large'
type SceneChoice = 'random' | 'custom' | 'photo' | string
// A moving cover just rendered (POST /api/cassette-studio/motion).
type Clip = { id: string; video_url: string; format: MotionFormat; wide: boolean; has_title: boolean }
// The owner's theme — the recipe every release is rendered in (GET /api/cassette-studio/theme).
type ThemeLettering = 'title' | 'artist-title' | 'existing' | 'none'
type Theme = {
  subject: string
  place_x: number | null; place_y: number | null; place_scale: number | null
  lettering: ThemeLettering; align: 'left' | 'center' | 'right'
  color: string; position: Position; size: Size
  filter: unknown | null
  formats: MotionFormat[]; clip_title: boolean
  saved_at: string
}
const THEME_LETTERINGS: { value: ThemeLettering; label: string; hint: string }[] = [
  { value: 'title', label: 'Song title, typed', hint: "each song's title set from your taught letters" },
  { value: 'artist-title', label: 'Artist + title, typed', hint: 'your artist name over the title, from your taught letters' },
  { value: 'existing', label: "The song's own handwriting", hint: 'whatever handwriting photo that song already has' },
  { value: 'none', label: 'No handwriting', hint: 'the cassette and the scene only' },
]

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

// Where the cassette goes (place_x / place_y / place_scale on /render — see
// placeSubject in src/lib/cassette-studio.ts): a 3×3 grid of centre × surface
// line, and a width. 'auto' leaves the field to the server's own framing.
const CASSETTE_SPOTS: { x: number; y: number; label: string }[] = [
  { x: 0.3, y: 0.5, label: '↖' }, { x: 0.5, y: 0.5, label: '↑' }, { x: 0.7, y: 0.5, label: '↗' },
  { x: 0.3, y: 0.7, label: '←' }, { x: 0.5, y: 0.7, label: '·' }, { x: 0.7, y: 0.7, label: '→' },
  { x: 0.3, y: 0.88, label: '↙' }, { x: 0.5, y: 0.88, label: '↓' }, { x: 0.7, y: 0.88, label: '↘' },
]
const CASSETTE_SIZES: { value: number; label: string }[] = [
  { value: 0.3, label: 'S' }, { value: 0.4, label: 'M' }, { value: 0.52, label: 'L' }, { value: 0.66, label: 'XL' },
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

const chip = (on: boolean) => `px-2 py-1 rounded-md text-[10px] ${on ? 'bg-[#2dd4bf]/20 text-[#2dd4bf]' : 'bg-[#1a1a1a] text-[#888] hover:text-white'}`
const SPINNER = <span className="w-3 h-3 border border-white/30 border-t-white rounded-full animate-spin" />

type Props = {
  projectId: string
  onRendered: (artworkUrl: string, finalizedUrl: string | null) => void
  /** A clip was pinned on THIS song (url, into the wide slot?) — mirror it on the page. */
  onVisualizerPinned?: (url: string, wide: boolean) => void
  onClose: () => void
}

export default function CassetteStudio({ projectId, onRendered, onVisualizerPinned, onClose }: Props) {
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
  // Cassette placement: 'auto' or one of CASSETTE_SPOTS (as "x,y"); width 'auto' or a fraction.
  const [spot, setSpot] = useState<'auto' | string>('auto')
  const [cassetteSize, setCassetteSize] = useState<'auto' | number>('auto')
  const [busy, setBusy] = useState<null | 'load' | 'subject' | 'lettering' | 'typing' | 'teaching' | 'render' | 'reletter' | 'apply-look' | 'save-look'>('load')
  const [error, setError] = useState('')
  const [lastScene, setLastScene] = useState<string | null>(null)
  const [hasRendered, setHasRendered] = useState(false)
  // Type in my handwriting: the title to set from the glyph bank.
  const [typedText, setTypedText] = useState('')
  const [typedAlign, setTypedAlign] = useState<'left' | 'center' | 'right'>('center')
  const [typeNote, setTypeNote] = useState('')
  // Teach my handwriting: a photo (or the current lettering) + what it says,
  // and which letters the bank already knows (GET /api/cassette-studio/glyphs).
  const [teachOpen, setTeachOpen] = useState(false)
  const [teachText, setTeachText] = useState('')
  const [teachFile, setTeachFile] = useState<Blob | null>(null)
  const [teachNote, setTeachNote] = useState('')
  const [teachError, setTeachError] = useState('')
  const [glyphCounts, setGlyphCounts] = useState<Record<string, number> | null>(null)
  const [glyphChars, setGlyphChars] = useState('')
  // Moving cover (no AI): the cover just made, animated — reels turning,
  // camera drift, live grain. Reset whenever a new cover replaces it.
  const [motionFormat, setMotionFormat] = useState<MotionFormat>('canvas')
  const [motionTitle, setMotionTitle] = useState(true)
  const [motionBusy, setMotionBusy] = useState(false)
  const [motionError, setMotionError] = useState('')
  const [motionVideo, setMotionVideo] = useState<Clip | null>(null)
  // The project's CURRENT cover can already move (a studio cover with its
  // layers saved) — offers the row on open, not only after a new render.
  const [canMove, setCanMove] = useState(false)
  const [pinBusy, setPinBusy] = useState(false)
  const [pinNote, setPinNote] = useState('')
  // My theme: the recipe every release is rendered in. undefined = not loaded yet.
  const [theme, setTheme] = useState<Theme | null | undefined>(undefined)
  const [themeLettering, setThemeLettering] = useState<ThemeLettering>('title')
  const [themeFormats, setThemeFormats] = useState<MotionFormat[]>(['canvas', 'youtube'])
  const [themeBusy, setThemeBusy] = useState<null | 'save' | 'apply' | 'forget'>(null)
  const [themeStep, setThemeStep] = useState('')
  const [themeError, setThemeError] = useState('')
  const [themeNote, setThemeNote] = useState('')
  // "From mixBase": the owner's images already in his songs, loaded on first open.
  const [photosOpen, setPhotosOpen] = useState(false)
  const [photos, setPhotos] = useState<MixbasePhoto[] | null>(null)
  const [photosError, setPhotosError] = useState('')
  // Finish the look: the "keep this look" toggle + last saved look (this
  // browser), and a counter that makes the editor re-read the cover.
  const [lookPrefs, setLookPrefs] = useState<LookPrefs>(readLookPrefs)
  const [lookRefresh, setLookRefresh] = useState(0)
  const [lookNote, setLookNote] = useState('')

  const loadMotion = useCallback(async () => {
    // Best-effort: a failed check only hides the row until the next render.
    try {
      const res = await fetch(`/api/cassette-studio/motion?project_id=${projectId}`)
      const d = res.ok ? await readJson(res) : null
      setCanMove(d?.available === true)
    } catch { /* leave the row as it was */ }
  }, [projectId])

  const loadTheme = useCallback(async () => {
    try {
      const res = await fetch('/api/cassette-studio/theme')
      const d = res.ok ? await readJson(res) : null
      const t = d && d.theme && typeof d.theme === 'object' ? (d.theme as Theme) : null
      setTheme(t)
      if (t) { setThemeLettering(t.lettering); setThemeFormats(t.formats) }
    } catch {
      setTheme(null)
    }
  }, [])

  const load = useCallback(async () => {
    void loadMotion()
    void loadTheme()
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
  }, [projectId, loadMotion, loadTheme])

  useEffect(() => { void load() }, [load])
  useEffect(() => () => { if (bgPreview) URL.revokeObjectURL(bgPreview) }, [bgPreview])
  useEffect(() => { writeLookPrefs(lookPrefs) }, [lookPrefs])

  // One cut-out pipeline, two sources: a new photo (multipart) or an image
  // already in mixBase (JSON source_path). Same response either way.
  async function cutOutSubject(request: () => Promise<RequestInit>) {
    setBusy('subject')
    setError('')
    try {
      const res = await fetch('/api/cassette-studio/subject', { method: 'POST', ...(await request()) })
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

  async function addSubject(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    await cutOutSubject(async () => {
      const form = new FormData()
      form.append('photo', await downscale(file, 2400), 'cassette.jpg')
      return { body: form }
    })
  }

  async function togglePhotos() {
    if (photosOpen) { setPhotosOpen(false); return }
    setPhotosOpen(true)
    if (photos) return
    setPhotosError('')
    try {
      const res = await fetch('/api/cassette-studio/photos')
      const data = await readJson(res)
      if (!res.ok || !Array.isArray(data?.photos)) throw new Error((data?.error as string) ?? 'Could not load your photos.')
      setPhotos(data.photos as MixbasePhoto[])
    } catch (err) {
      setPhotosError(err instanceof Error ? err.message : 'Could not load your photos.')
    }
  }

  function pickPhoto(photo: MixbasePhoto) {
    setPhotosOpen(false)
    void cutOutSubject(async () => ({
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_path: photo.path }),
    }))
  }

  function acceptLettering(l: StudioFile) {
    setLettering(prev => [l, ...prev])
    setLetterPath(l.path)
    setUseLettering(true)
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
      acceptLettering(data.lettering as StudioFile)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read your handwriting.')
    } finally {
      setBusy(null)
    }
  }

  // "Type it": the title set from the letters the bank has learned — the
  // server lays the artist's own samples out (no font, no AI) and saves the
  // result as this song's lettering, like a photographed one.
  async function typeLettering() {
    if (!typedText.trim()) return
    setBusy('typing')
    setError('')
    setTypeNote('')
    try {
      const res = await fetch('/api/cassette-studio/lettering', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, text: typedText, align: typedAlign }),
      })
      const data = await readJson(res)
      if (!res.ok || !data?.lettering) {
        const missing = Array.isArray(data?.missing) ? (data.missing as string[]) : []
        if (missing.length) { setTeachOpen(true); void loadGlyphs() }
        throw new Error((data?.error as string) ?? 'Could not set your title.')
      }
      acceptLettering(data.lettering as StudioFile)
      setTypeNote('Set in your handwriting. Not quite right? Type it again for another take, or teach more samples of a letter.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set your title.')
    } finally {
      setBusy(null)
    }
  }

  const loadGlyphs = useCallback(async () => {
    try {
      const res = await fetch('/api/cassette-studio/glyphs')
      const data = await readJson(res)
      if (!res.ok || !data) throw new Error((data?.error as string) ?? 'Could not load your handwriting.')
      setGlyphCounts((data.counts as Record<string, number>) ?? {})
      setGlyphChars(typeof data.chars === 'string' ? data.chars : '')
    } catch (err) {
      setTeachError(err instanceof Error ? err.message : 'Could not load your handwriting.')
    }
  }, [])

  function toggleTeach() {
    const open = !teachOpen
    setTeachOpen(open)
    if (open && !glyphCounts) void loadGlyphs()
  }

  async function chooseTeachPhoto(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setTeachError('')
    try {
      setTeachFile(await downscale(file, 2400))
    } catch (err) {
      setTeachError(err instanceof Error ? err.message : 'Could not read that image.')
    }
  }

  // Teach: a photo of separated letters (or the handwriting already lifted
  // for this song) and what it says — one sample per letter joins the bank.
  async function teach(from: 'photo' | 'lettering') {
    if (!teachText.trim()) { setTeachError('Type what the writing says, line by line.'); return }
    setBusy('teaching')
    setTeachError('')
    setTeachNote('')
    try {
      let init: RequestInit
      if (from === 'photo') {
        if (!teachFile) { setTeachError('Add a photo of your letters first.'); return }
        const form = new FormData()
        form.append('photo', teachFile, 'letters.jpg')
        form.append('text', teachText)
        init = { method: 'POST', body: form }
      } else {
        if (!letterPath) return
        init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lettering: letterPath, text: teachText }) }
      }
      const res = await fetch('/api/cassette-studio/glyphs', init)
      const data = await readJson(res)
      if (!res.ok || !data) throw new Error((data?.error as string) ?? 'Could not learn from that.')
      const added = Array.isArray(data.added) ? data.added.length : 0
      setGlyphCounts((data.counts as Record<string, number>) ?? null)
      setTeachNote(`Learned ${added} letter${added === 1 ? '' : 's'}. Teach the same letters again from another photo for more variety.`)
      setTeachFile(null)
      setTeachText('')
    } catch (err) {
      setTeachError(err instanceof Error ? err.message : 'Could not learn from that.')
    } finally {
      setBusy(null)
    }
  }

  async function forgetLetter(c: string) {
    setTeachError('')
    const res = await fetch(`/api/cassette-studio/glyphs?char=${encodeURIComponent(c)}`, { method: 'DELETE' }).catch(() => null)
    if (!res?.ok) { setTeachError('Could not remove that letter.'); return }
    setGlyphCounts(prev => (prev ? { ...prev, [c]: 0 } : prev))
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
    setLookNote('')
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
      if (spot !== 'auto') {
        const [x, y] = spot.split(',')
        form.append('place_x', x)
        form.append('place_y', y)
      }
      if (cassetteSize !== 'auto') form.append('place_scale', String(cassetteSize))
      const res = await fetch('/api/cassette-studio/render', { method: 'POST', body: form })
      const data = await readJson(res)
      if (!res.ok || !data?.artwork_url) throw new Error((data?.error as string) ?? 'Could not make the cover.')
      onRendered(data.artwork_url as string, (data.finalized_artwork_url as string | null) ?? null)
      if (mode === 'scene') setLastScene((data.scene_label as string | null) ?? null)
      setHasRendered(true)
      setMotionVideo(null)
      setMotionError('')
      // Keep this look for new covers: every new cover comes back unfiltered,
      // so the remembered look goes straight back on. A failure keeps the
      // plain cover.
      const keep = lookPrefs.keep && lookPrefs.look && !isOriginalLook(lookPrefs.look) ? lookPrefs.look : null
      if (keep) {
        setBusy('apply-look')
        try {
          const saved = await saveLook(projectId, keep)
          if (saved.artworkUrl) onRendered(saved.artworkUrl, saved.finalizedUrl)
        } catch {
          setLookNote('Your look could not be added this time. The cover is saved without it.')
        }
      }
      setLookRefresh(n => n + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error. Try again.')
    } finally {
      setBusy(null)
    }
  }

  // "Save look" in Finish the look: bakes the look into the cover and updates
  // the Artwork tab exactly like a render. Rejections reach the editor, which
  // shows the message.
  async function saveLookNow(settings: FilterSettings): Promise<SavedLook> {
    setBusy('save-look')
    setLookNote('')
    try {
      const saved = await saveLook(projectId, settings)
      if (saved.artworkUrl) onRendered(saved.artworkUrl, saved.finalizedUrl)
      setLookPrefs(prev => ({ ...prev, look: saved.filter }))
      // A clip made before this no longer matches the still.
      setMotionVideo(null)
      setMotionError('')
      return saved
    } finally {
      setBusy(null)
    }
  }

  async function makeItMove() {
    setMotionBusy(true)
    setMotionError('')
    setPinNote('')
    try {
      const format = motionFormat
      const res = await fetch('/api/cassette-studio/motion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, format, title: motionTitle }),
      })
      const data = await readJson(res)
      if (!res.ok || typeof data?.video_url !== 'string' || typeof data?.id !== 'string') throw new Error((data?.error as string) ?? 'Could not render the moving cover.')
      setMotionVideo({ id: data.id, video_url: data.video_url, format, wide: format === 'youtube', has_title: data.has_title !== false })
    } catch (err) {
      setMotionError(err instanceof Error ? err.message : 'Network error. Try again.')
    } finally {
      setMotionBusy(false)
    }
  }

  // Pin a clip as this song's visualizer — landscape into the wide slot,
  // everything else into the vertical one (PATCH /api/projects/[id], the
  // same route every other pin goes through).
  async function pinHere(url: string, wide: boolean): Promise<void> {
    const res = await fetch(`/api/projects/${projectId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [wide ? 'visualizer_wide_url' : 'visualizer_url']: url }),
    })
    const data = await readJson(res)
    if (!res.ok) throw new Error((data?.error as string) ?? 'Could not pin the clip.')
    onVisualizerPinned?.(url, wide)
  }

  async function pinClip(clip: Clip) {
    setPinBusy(true)
    setPinNote('')
    setMotionError('')
    try {
      await pinHere(clip.video_url, clip.wide)
      setPinNote(`Pinned as this song's ${clip.wide ? 'wide' : 'vertical'} visualizer.`)
    } catch (err) {
      setMotionError(err instanceof Error ? err.message : 'Could not pin the clip.')
    } finally {
      setPinBusy(false)
    }
  }

  // ── My theme ──────────────────────────────────────────────────────────────
  // Save what is set up on this screen right now as THE recipe: this cassette,
  // its placement, how the handwriting is lettered, the ink colour/position/
  // size, this song's current look, and which clips to make. The scene is
  // the one thing a theme leaves open.
  async function saveTheme() {
    if (!subject) { setThemeError('Pick the cassette your theme uses first.'); return }
    setThemeBusy('save')
    setThemeError('')
    setThemeNote('')
    try {
      const body: Record<string, unknown> = {
        subject, lettering: themeLettering, align: typedAlign, color, position, size,
        formats: themeFormats, clip_title: motionTitle, project_id: projectId,
      }
      if (spot !== 'auto') { const [x, y] = spot.split(','); body.place_x = Number(x); body.place_y = Number(y) }
      if (cassetteSize !== 'auto') body.place_scale = cassetteSize
      const res = await fetch('/api/cassette-studio/theme', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const data = await readJson(res)
      if (!res.ok || !data?.theme) throw new Error((data?.error as string) ?? 'Could not save your theme.')
      setTheme(data.theme as Theme)
      setThemeNote('Theme saved. Every song you make in it will share this cassette, framing, handwriting treatment and look, in a scene of its own.')
    } catch (err) {
      setThemeError(err instanceof Error ? err.message : 'Could not save your theme.')
    } finally {
      setThemeBusy(null)
    }
  }

  async function forgetTheme() {
    if (!window.confirm('Forget your theme? Songs already made in it are untouched.')) return
    setThemeBusy('forget')
    setThemeError('')
    try {
      const res = await fetch('/api/cassette-studio/theme', { method: 'DELETE' })
      if (!res.ok) throw new Error('Could not remove your theme.')
      setTheme(null)
      setThemeNote('')
    } catch (err) {
      setThemeError(err instanceof Error ? err.message : 'Could not remove your theme.')
    } finally {
      setThemeBusy(null)
    }
  }

  // One tap: this song in the theme. The server letters the title, builds the
  // cover in a scene and adds the look; the theme's clips are then rendered
  // through the same route "Make it move" uses, and pinned.
  async function applyTheme() {
    if (!theme) return
    setThemeBusy('apply')
    setThemeError('')
    setThemeNote('')
    setLookNote('')
    try {
      setThemeStep(scene === 'random' || scene === 'custom' || scene === 'photo' ? 'Lettering the title and building a scene (~40s)…' : 'Lettering the title and building the scene (~40s)…')
      const chosen = scene === 'custom' || scene === 'photo' ? 'random' : scene
      const res = await fetch('/api/cassette-studio/theme/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, scene: chosen }),
      })
      const data = await readJson(res)
      if (!res.ok || typeof data?.artwork_url !== 'string') {
        if (Array.isArray(data?.missing) && data.missing.length) { setTeachOpen(true); void loadGlyphs() }
        throw new Error((data?.error as string) ?? 'Could not make the cover.')
      }
      onRendered(data.artwork_url, (data.finalized_artwork_url as string | null) ?? null)
      if (data.lettering && typeof data.lettering === 'object') acceptLettering(data.lettering as StudioFile)
      setLastScene((data.scene_label as string | null) ?? null)
      setHasRendered(true)
      setCanMove(true)
      setMotionVideo(null)
      setMotionError('')
      setLookRefresh(n => n + 1)
      if (typeof data.look_error === 'string' && data.look_error) setLookNote(data.look_error)
      const formats = Array.isArray(data.formats) ? (data.formats as MotionFormat[]) : []
      const withTitle = data.clip_title !== false
      const made: string[] = []
      for (const format of formats) {
        const label = MOTION_FORMATS.find(f => f.value === format)?.label ?? format
        setThemeStep(`Rendering the ${label} clip${format === 'youtube' ? ' (~1 min)' : ''}…`)
        const r = await fetch('/api/cassette-studio/motion', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_id: projectId, format, title: withTitle }),
        })
        const d = await readJson(r)
        if (!r.ok || typeof d?.video_url !== 'string' || typeof d?.id !== 'string') throw new Error((d?.error as string) ?? `Could not render the ${label} clip.`)
        const clip: Clip = { id: d.id, video_url: d.video_url, format, wide: format === 'youtube', has_title: withTitle }
        setMotionVideo(clip)
        setThemeStep(`Pinning the ${label} clip…`)
        await pinHere(clip.video_url, clip.wide)
        made.push(label)
      }
      setThemeNote(made.length
        ? `Done: cover${data.look_applied ? ' with your look' : ''} in “${data.scene_label ?? 'a new scene'}”, and ${made.join(' + ')} pinned as this song's visualizer${made.length > 1 ? 's' : ''}.`
        : `Done: cover${data.look_applied ? ' with your look' : ''} in “${data.scene_label ?? 'a new scene'}”.`)
    } catch (err) {
      setThemeError(err instanceof Error ? err.message : 'Could not make this song in your theme.')
    } finally {
      setThemeBusy(null)
      setThemeStep('')
    }
  }

  // A moving-cover render reads the CURRENT cover's layers server-side, so a
  // new cover must not replace it mid-render.
  const working = busy !== null || motionBusy || themeBusy !== null
  const canRender = !!subject && !working && (scene !== 'custom' || setting.trim().length > 0) && (scene !== 'photo' || !!bgFile)
  const currentLettering = lettering.find(l => l.path === letterPath) ?? null
  const knownLetters = glyphCounts ? Object.values(glyphCounts).filter(n => n > 0).length : 0
  const themeSummary = (t: Theme) => {
    const l = THEME_LETTERINGS.find(x => x.value === t.lettering)?.label ?? t.lettering
    const clips = t.formats.map(f => MOTION_FORMATS.find(m => m.value === f)?.label ?? f).join(' + ')
    return `${l} · ${t.color === 'auto' ? 'auto ink' : t.color} · ${t.position.replace('-', ' ')} ${t.size}${t.filter ? ' · with look' : ''}${clips ? ` · clips: ${clips}${t.clip_title ? '' : ' (no title)'}` : ' · no clips'}`
  }

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
              ? <>{SPINNER}Cutting out…</>
              : <><Camera size={13} />Add photo</>}
            <input type="file" accept="image/*" onChange={addSubject} disabled={working} className="hidden" />
          </label>
          <button
            onClick={togglePhotos}
            disabled={working}
            className={`shrink-0 w-20 h-14 rounded-lg border border-dashed flex flex-col items-center justify-center gap-0.5 text-[9px] ${photosOpen ? 'border-[#2dd4bf]/60 text-[#2dd4bf]' : 'border-[#333] text-[#777]'} ${working ? 'opacity-50' : 'hover:text-white hover:border-[#555]'}`}
          >
            <Images size={13} />From mixBase
          </button>
        </div>
        {photosOpen && (
          <div className="space-y-1.5 rounded-lg border border-[#222] bg-[#0a0a0a] p-2">
            <div className="flex items-center justify-between">
              <p className="text-[10px] text-[#888]">Pick a cassette photo from your songs</p>
              <button onClick={() => setPhotosOpen(false)} className="text-[#555] hover:text-white" aria-label="Close photos"><X size={12} /></button>
            </div>
            {photosError
              ? <p className="text-red-400 text-[10px]">{photosError}</p>
              : !photos
                ? <p className="flex items-center gap-1.5 text-[10px] text-[#666]">{SPINNER}Loading your photos…</p>
                : photos.length === 0
                  ? <p className="text-[10px] text-[#666]">No images in your songs yet.</p>
                  : (
                    <div className="grid grid-cols-4 gap-1.5 max-h-72 overflow-y-auto">
                      {photos.map(p => (
                        <button key={p.path} onClick={() => pickPhoto(p)} disabled={working} title={p.project_title} className="group min-w-0 text-left disabled:opacity-50">
                          <span className="block aspect-square rounded-md overflow-hidden bg-[#1a1a1a] border border-transparent group-hover:border-[#2dd4bf]/60">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={p.thumb_url || p.url} alt="" loading="lazy" className="w-full h-full object-cover" />
                          </span>
                          <span className="block mt-0.5 truncate text-[9px] text-[#777]">{p.project_title}</span>
                        </button>
                      ))}
                    </div>
                  )}
          </div>
        )}
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
              ? <>{SPINNER}Reading…</>
              : <><PenLine size={13} />{currentLettering ? 'Replace' : 'Add a photo of your handwriting'}</>}
            <input type="file" accept="image/*" onChange={addLettering} disabled={working} className="hidden" />
          </label>
        </div>
        {!currentLettering && busy !== 'load' && (
          <p className="text-[10px] text-[#666] leading-snug">Write the artist name and song title with a marker on plain paper and photograph it flat. Your exact strokes are lifted off the paper, with no font and no AI. Holes and breaks in a stroke are mended; the letters stay yours.</p>
        )}

        {/* Type it: set a title from the letters the bank has learned. */}
        <div className="space-y-1.5 rounded-lg border border-[#222] bg-[#0a0a0a] p-2">
          <div className="flex items-center justify-between">
            <p className="flex items-center gap-1 text-[10px] text-[#888]"><Keyboard size={11} />Or type it in your handwriting</p>
            <button onClick={toggleTeach} className={`flex items-center gap-1 text-[10px] ${teachOpen ? 'text-[#2dd4bf]' : 'text-[#888] hover:text-white'}`}>
              <GraduationCap size={11} />{teachOpen ? 'Close teaching' : 'Teach it my letters'}
            </button>
          </div>
          <div className="flex gap-1.5 items-start">
            <textarea
              value={typedText}
              onChange={e => setTypedText(e.target.value.slice(0, 80))}
              rows={2}
              placeholder={'artist name\nsong title'}
              className="flex-1 bg-[#0f0f0f] border border-[#222] rounded-lg px-2.5 py-1.5 text-[11px] text-white placeholder-[#444] focus:outline-none focus:border-[#2dd4bf]/40 resize-none"
            />
            <div className="flex flex-col gap-1">
              <div className="flex gap-0.5">
                {(['left', 'center', 'right'] as const).map(a => (
                  <button key={a} onClick={() => setTypedAlign(a)} aria-label={`Align ${a}`} className={`w-6 h-5 rounded text-[10px] ${typedAlign === a ? 'bg-[#2dd4bf]/20 text-[#2dd4bf]' : 'bg-[#1a1a1a] text-[#666]'}`}>
                    {a === 'left' ? '⇤' : a === 'center' ? '↔' : '⇥'}
                  </button>
                ))}
              </div>
              <button
                onClick={typeLettering}
                disabled={working || !typedText.trim()}
                className="flex items-center justify-center gap-1 px-2 py-1.5 text-[10px] font-medium bg-[#1e1e1e] border border-[#333] text-white rounded-lg hover:bg-[#2a2a2a] disabled:opacity-40"
              >
                {busy === 'typing' ? <>{SPINNER}Setting…</> : 'Set it'}
              </button>
            </div>
          </div>
          {typeNote && <p className="text-[10px] text-[#888]">{typeNote}</p>}
          {teachOpen && (
            <div className="space-y-2 border-t border-[#1e1e1e] pt-2">
              <p className="text-[10px] text-[#666] leading-snug">
                Write letters on plain paper with clear space between every letter — no joined-up writing, dots close to their i and j — in a few lines (for example your alphabet in capitals, then lower case, then digits). Photograph it flat, then type exactly what each line says. Every letter becomes a sample; teach a letter several times and your typed titles will vary the way your writing does.
              </p>
              <div className="flex gap-1.5 items-start">
                <label className={`shrink-0 w-20 h-14 rounded-lg border border-dashed border-[#333] flex flex-col items-center justify-center gap-0.5 text-[9px] text-[#777] text-center px-1 ${working ? 'opacity-50' : 'cursor-pointer hover:text-white hover:border-[#555]'}`}>
                  <Camera size={13} />{teachFile ? 'Photo ready' : 'Photo of letters'}
                  <input type="file" accept="image/*" onChange={chooseTeachPhoto} disabled={working} className="hidden" />
                </label>
                <textarea
                  value={teachText}
                  onChange={e => setTeachText(e.target.value.slice(0, 160))}
                  rows={3}
                  placeholder={'What the photo says, one line per line of writing, e.g.\nABCDEFGHIJKLM\nNOPQRSTUVWXYZ'}
                  className="flex-1 bg-[#0f0f0f] border border-[#222] rounded-lg px-2.5 py-1.5 text-[11px] text-white placeholder-[#444] focus:outline-none focus:border-[#2dd4bf]/40 resize-none"
                />
              </div>
              <div className="flex flex-wrap gap-1.5">
                <button
                  onClick={() => teach('photo')}
                  disabled={working || !teachFile || !teachText.trim()}
                  className="flex items-center gap-1 px-2 py-1.5 text-[10px] font-medium bg-[#1e1e1e] border border-[#333] text-white rounded-lg hover:bg-[#2a2a2a] disabled:opacity-40"
                >
                  {busy === 'teaching' ? <>{SPINNER}Learning…</> : <><GraduationCap size={11} />Learn from the photo</>}
                </button>
                {currentLettering && (
                  <button
                    onClick={() => teach('lettering')}
                    disabled={working || !teachText.trim()}
                    title="Teach from the handwriting shown above: type what it says"
                    className="px-2 py-1.5 text-[10px] font-medium bg-[#1e1e1e] border border-[#333] text-[#ccc] rounded-lg hover:bg-[#2a2a2a] disabled:opacity-40"
                  >
                    Learn from the handwriting above
                  </button>
                )}
              </div>
              {teachError && <p className="text-red-400 text-[10px]">{teachError}</p>}
              {teachNote && <p className="text-[10px] text-[#888]">{teachNote}</p>}
              {glyphCounts && (
                <div className="space-y-1">
                  <p className="text-[10px] text-[#666]">
                    {knownLetters === 0 ? 'No letters learned yet.' : `${knownLetters} letters learned — click one to forget its samples.`}
                  </p>
                  <div className="flex flex-wrap gap-0.5">
                    {[...glyphChars].map(c => {
                      const n = glyphCounts[c] ?? 0
                      return (
                        <button
                          key={c}
                          onClick={() => n > 0 && forgetLetter(c)}
                          disabled={n === 0 || working}
                          title={n > 0 ? `${n} sample${n === 1 ? '' : 's'} — click to forget` : 'Not learned yet'}
                          className={`w-5 h-5 rounded text-[10px] font-mono ${n > 0 ? 'bg-[#2dd4bf]/20 text-[#2dd4bf]' : 'bg-[#161616] text-[#444]'}`}
                        >
                          {c}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

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
          <button onClick={() => setScene('random')} className={`flex items-center gap-1 ${chip(scene === 'random')}`}>
            <Shuffle size={10} />Surprise me
          </button>
          {CASSETTE_SCENES.map(s => (
            <button key={s.id} onClick={() => setScene(s.id)} className={chip(scene === s.id)}>
              {s.label}
            </button>
          ))}
          <button onClick={() => setScene('custom')} className={chip(scene === 'custom')}>
            Describe my own…
          </button>
          <label className={`flex items-center gap-1 cursor-pointer ${chip(scene === 'photo')}`}>
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

        {/* Where the cassette goes. */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="space-y-1">
            <p className="text-[10px] text-[#666]">Cassette position</p>
            <div className="flex items-center gap-1.5">
              <button onClick={() => setSpot('auto')} className={`px-2 h-6 rounded-md text-[10px] ${spot === 'auto' ? 'bg-[#2dd4bf]/20 text-[#2dd4bf]' : 'bg-[#1a1a1a] text-[#777]'}`}>Auto</button>
              <div className="grid grid-cols-3 gap-0.5">
                {CASSETTE_SPOTS.map(s => {
                  const v = `${s.x},${s.y}`
                  return (
                    <button key={v} onClick={() => setSpot(v)} aria-label={`Cassette ${s.label}`}
                      className={`w-6 h-5 rounded text-[10px] ${spot === v ? 'bg-[#2dd4bf]/20 text-[#2dd4bf]' : 'bg-[#1a1a1a] text-[#666]'}`}>{s.label}</button>
                  )
                })}
              </div>
            </div>
          </div>
          <div className="space-y-1">
            <p className="text-[10px] text-[#666]">Cassette size</p>
            <div className="flex gap-0.5">
              <button onClick={() => setCassetteSize('auto')} className={`px-2 h-6 rounded-md text-[10px] ${cassetteSize === 'auto' ? 'bg-[#2dd4bf]/20 text-[#2dd4bf]' : 'bg-[#1a1a1a] text-[#777]'}`}>Auto</button>
              {CASSETTE_SIZES.map(s => (
                <button key={s.value} onClick={() => setCassetteSize(s.value)}
                  className={`min-w-6 px-1 h-6 rounded text-[10px] ${cassetteSize === s.value ? 'bg-[#2dd4bf]/20 text-[#2dd4bf]' : 'bg-[#1a1a1a] text-[#666]'}`}>{s.label}</button>
              ))}
            </div>
          </div>
        </div>
      </section>

      {error && <p className="text-red-400 text-xs">{error}</p>}
      {lookNote && <p className="text-[10px] text-[#888]">{lookNote}</p>}
      {busy === 'apply-look' && (
        <p className="flex items-center gap-1.5 text-[10px] text-[#888]">{SPINNER}Adding your look…</p>
      )}
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

      {/* 4 — Finish the look: film looks + sliders over the current cover.
          Renders nothing until the project has a cover to edit. */}
      <CassetteLook
        projectId={projectId}
        refreshKey={lookRefresh}
        disabled={working}
        saving={busy === 'save-look'}
        prefs={lookPrefs}
        onPrefsChange={setLookPrefs}
        onSave={saveLookNow}
      />

      {/* Make it move: the cover just made as a looping clip, no AI. */}
      {(hasRendered || canMove) && (
        <section className="space-y-2 border-t border-[#1e1e1e] pt-3">
          <p className="text-[11px] font-medium text-[#999]">Make it move</p>
          {(hasRendered || canMove) && (
            <>
              <div className="flex flex-wrap items-center gap-1">
                {MOTION_FORMATS.map(f => (
                  <button key={f.value} onClick={() => setMotionFormat(f.value)} disabled={motionBusy} className={`${chip(motionFormat === f.value)} disabled:opacity-50`}>
                    {f.label}
                  </button>
                ))}
                <button
                  onClick={makeItMove}
                  disabled={working}
                  className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium bg-[#1e1e1e] border border-[#333] text-white rounded-lg hover:bg-[#2a2a2a] disabled:opacity-40 transition-colors"
                >
                  {motionBusy
                    ? <>{SPINNER}{motionFormat === 'youtube' ? 'Rendering (~1 min)…' : 'Rendering…'}</>
                    : <><Film size={12} />Make it move</>}
                </button>
              </div>
              <button onClick={() => setMotionTitle(v => !v)} disabled={motionBusy} className="flex items-center gap-1.5 text-[10px] text-[#888] hover:text-white">
                <span className={`w-7 h-3.5 rounded-full relative transition-colors ${!motionTitle ? 'bg-[#2dd4bf]' : 'bg-[#2a2a2a]'}`}>
                  <span className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white transition-all ${!motionTitle ? 'left-4' : 'left-0.5'}`} />
                </span>
                Without the title (the cassette and the scene only)
              </button>
              <p className="text-[10px] text-[#666] leading-snug">The reels turn, the camera drifts and the film grain moves. Built from this cover itself, with no AI. Saved to your visualizers.</p>
            </>
          )}
          {motionError && <p className="text-red-400 text-xs">{motionError}</p>}
          {pinNote && <p className="text-[10px] text-[#2dd4bf]">{pinNote}</p>}
          {motionVideo && (
            <div className="space-y-1.5">
              <video
                key={motionVideo.video_url}
                src={motionVideo.video_url}
                muted
                loop
                autoPlay
                playsInline
                className={`rounded-lg bg-black ${motionVideo.format === 'youtube' ? 'w-full aspect-video' : motionVideo.format === 'square' ? 'w-48 aspect-square' : 'w-32 aspect-[9/16]'}`}
              />
              <div className="flex flex-wrap items-center gap-1.5">
                <button onClick={() => pinClip(motionVideo)} disabled={pinBusy} className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] bg-[#2dd4bf]/20 text-[#2dd4bf] hover:bg-[#2dd4bf]/30 disabled:opacity-50">
                  <Pin size={10} />{pinBusy ? 'Pinning…' : 'Use as this song\'s visualizer'}
                </button>
                <a href={motionVideo.video_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[10px] text-[#2dd4bf] hover:underline">
                  <ExternalLink size={10} />Open the clip
                </a>
              </div>
            </div>
          )}
        </section>
      )}

      {/* My theme: one recipe every release is rendered in — same cassette,
          framing, handwriting treatment, look and clips; a new scene each time. */}
      <section className="space-y-2 border-t border-[#1e1e1e] pt-3">
        <p className="flex items-center gap-1 text-[11px] font-medium text-[#999]"><Palette size={11} />My theme</p>
        {theme === undefined ? (
          <p className="flex items-center gap-1.5 text-[10px] text-[#666]">{SPINNER}Loading your theme…</p>
        ) : theme ? (
          <>
            <p className="text-[10px] text-[#888] leading-snug">{themeSummary(theme)}</p>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                onClick={applyTheme}
                disabled={working}
                className="flex items-center gap-1.5 px-3 py-2 text-[11px] font-semibold bg-[#2dd4bf] text-[#0a0a0a] rounded-lg hover:bg-[#14b8a6] disabled:opacity-40 transition-colors"
              >
                {themeBusy === 'apply' ? <><span className="w-3 h-3 border border-black/30 border-t-black rounded-full animate-spin" />Making…</> : <><Sparkles size={12} />Make this song in my theme</>}
              </button>
              <span className="text-[10px] text-[#666]">Scene: {scene === 'random' || scene === 'custom' || scene === 'photo' ? 'a surprise (pick one in section 3 to choose)' : (CASSETTE_SCENES.find(s => s.id === scene)?.label ?? scene)}</span>
            </div>
            {themeStep && <p className="flex items-center gap-1.5 text-[10px] text-[#888]">{SPINNER}{themeStep}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={saveTheme} disabled={working} className="text-[10px] text-[#888] hover:text-white disabled:opacity-50">
                {themeBusy === 'save' ? 'Saving…' : 'Update the theme from the settings above'}
              </button>
              <button onClick={forgetTheme} disabled={working} className="text-[10px] text-[#666] hover:text-red-400 disabled:opacity-50">
                {themeBusy === 'forget' ? 'Removing…' : 'Forget theme'}
              </button>
            </div>
          </>
        ) : (
          <p className="text-[10px] text-[#666] leading-snug">
            Set up a cover you like above (cassette, placement, handwriting colour/position/size, look), then save it as your theme. From then on any song is one tap: same cassette and treatment, a scene of its own.
          </p>
        )}
        <div className="flex flex-wrap items-start gap-3">
          <div className="space-y-1">
            <p className="text-[10px] text-[#666]">Handwriting in the theme</p>
            <div className="flex flex-wrap gap-1">
              {THEME_LETTERINGS.map(o => (
                <button key={o.value} onClick={() => setThemeLettering(o.value)} title={o.hint} className={chip(themeLettering === o.value)}>{o.label}</button>
              ))}
            </div>
          </div>
          <div className="space-y-1">
            <p className="text-[10px] text-[#666]">Clips to make</p>
            <div className="flex flex-wrap gap-1">
              {MOTION_FORMATS.map(f => (
                <button
                  key={f.value}
                  onClick={() => setThemeFormats(prev => (prev.includes(f.value) ? prev.filter(v => v !== f.value) : [...prev, f.value]))}
                  className={chip(themeFormats.includes(f.value))}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        {!theme && theme !== undefined && (
          <button
            onClick={saveTheme}
            disabled={working || !subject}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium bg-[#1e1e1e] border border-[#333] text-white rounded-lg hover:bg-[#2a2a2a] disabled:opacity-40 transition-colors"
          >
            {themeBusy === 'save' ? <>{SPINNER}Saving…</> : <><Palette size={12} />Save this setup as my theme</>}
          </button>
        )}
        <p className="text-[10px] text-[#666] leading-snug">The theme takes the cassette, placement, ink colour/position/size and clip-title setting from the controls above, the look from this song&rsquo;s current cover, and the handwriting and clip choices here.</p>
        {themeError && <p className="text-red-400 text-xs">{themeError}</p>}
        {themeNote && <p className="text-[10px] text-[#2dd4bf]">{themeNote}</p>}
      </section>
    </div>
  )
}
