// Cassette Studio — ONE CLICK. The artist names a song (and, if they like,
// an idea); this makes the whole release look from it, in the background,
// while the screen polls:
//
//   1. concept   the title (and the idea) become ONE picture idea in which the
//                cassette plays a part, plus how that picture moves
//                (cover-concept.ts — Claude, or a template from their words)
//   2. lettering the artist's handwritten name (signature) over the song
//                title written in their own hand (glyph bank), as one lockup;
//                if a title letter was never taught, this song's own
//                photographed handwriting is used instead, never a guess
//   3. cover     several takes drawn by the art engine from a photo of the
//                real cassette (cassette-art.ts), looked at next to the real
//                one and the best chosen (cover-concept.ts judgeTakes; one
//                corrected redraw if the cassette came out wrong), lettered,
//                and applied to the project as soon as it lands. The other
//                takes stay in the studio folder: /render with scene=take
//                makes any of them the cover. If no art model is available
//                the classic engine (the real cassette photo in a scene
//                painted around it) makes the cover instead.
//   4. clips     the cover extended to 9:16 and 16:9 (FLUX Fill outpainting
//                around the untouched cover) and filmed (Runway), made a
//                seamless silent loop, saved and pinned: Canvas → the vertical
//                visualizer, YouTube → the wide one. If a shot cannot be
//                filmed, that format is the extended still set gently in
//                motion (still-loop.ts; a classic cover gets its turning
//                reels) so the release is never left without one.
//
// In-process and in-memory by design, like /api/finalize-video's jobs: a
// deploy mid-run loses the job and the screen says so. Owner-only — the
// route checks isAdminIdentity before a job can start.

import { randomUUID } from 'crypto'
import { supabaseAdmin } from '@/lib/supabase'
import { checkAndIncrementUsage, refundUsage } from '@/lib/tier'
import { ARTWORK_BUCKET, storagePathFromUrl } from '@/lib/project-assets'
import { ensureProjectVisualizerColumn, isMissingVisualizerColumn } from '@/lib/schema-heal'
import {
  downloadStudio, fillScene, generateTakes, isOwnStudioKey, listStudio, loadGlyphBank, loadSignature, removeStudio, studioPrefix,
  studioPublicUrl, uploadStudio, type StudioFile,
} from '@/lib/cassette-server'
import { buildOutpaintRequest, finishOutpaint, type FrameShape, type LetteringPosition, type LetteringSize } from '@/lib/cassette-studio'
import {
  artPrompt, buildReference, DEFAULT_TAKES, MAX_TAKES, parseTakeKey, storeTake, takeKey, type ArtModelId,
} from '@/lib/cassette-art'
import { scenePrompt } from '@/lib/cassette-scenes'
import { composeHandwriting } from '@/lib/handwriting-glyphs'
import { stackLockup, titleForHandwriting, type TitleMetrics } from '@/lib/handwriting-sheet'
import { judgeTakes, promptConcept, writeCoverConcept, type CoverConcept } from '@/lib/cover-concept'
import { filmStill, VideoUnavailable } from '@/lib/runway-video'
import { seamlessLoop } from '@/lib/video-loop'
import { fitStill, stillLoop } from '@/lib/still-loop'
import { storeVisualizer } from '@/lib/visualizer-store'
import {
  CoverError, loadCoverProject, makeMovingCover, makeStudioCover, type CoverProject, type CoverResult,
} from '@/lib/cassette-pipeline'

export type QuickStep = 'brief' | 'cover' | 'canvas' | 'youtube'
/** 'skipped' = a clip the request did not ask for (an API-only choice; the screens always ask for both). */
export type StepState = 'pending' | 'running' | 'done' | 'failed' | 'skipped'
export type QuickFormat = 'canvas' | 'youtube'
export type QuickClip = { format: QuickFormat; video_url: string; kind: 'cinematic' | 'loop'; model: string | null }

export type QuickJob = {
  id: string
  userId: string
  projectId: string
  description: string
  status: 'running' | 'done' | 'error'
  stage: string
  steps: Record<QuickStep, StepState>
  scene_label: string | null
  /** The picture idea in one plain sentence (what the art director wrote, or the artist's own words). */
  idea: string | null
  /** The takes drawn for this cover (newest run), and which one is the cover. */
  takes: StudioFile[]
  take: number | null
  /** The image model that drew them, or null (the classic engine made the cover). */
  model: string | null
  artwork_url: string | null
  finalized_artwork_url: string | null
  lettering: StudioFile | null
  /** How the title was lettered (the resolved colour and spot, the size), so a client's Adjust the title starts from it. */
  title: { color: string | null; position: LetteringPosition | null; size: LetteringSize } | null
  clips: QuickClip[]
  notes: string[]
  error: string | null
  createdAt: number
  updatedAt: number
}

/** What a client sees of a job (no user id). */
export function publicJob(j: QuickJob) {
  const { userId: _userId, ...rest } = j
  void _userId
  return rest
}

const jobs = new Map<string, QuickJob>()
const MAX_RUNNING = 2
const KEEP_MS = 3 * 60 * 60_000
const STUCK_MS = 30 * 60_000

function prune() {
  const now = Date.now()
  for (const [id, j] of jobs) {
    if (j.status === 'running' && now - j.updatedAt > STUCK_MS) {
      j.status = 'error'; j.error = 'This run stopped responding. Please try again.'; j.updatedAt = now
    }
    if (j.status !== 'running' && now - j.updatedAt > KEEP_MS) jobs.delete(id)
  }
}

export function getQuickJob(id: string): QuickJob | null {
  prune()
  return jobs.get(id) ?? null
}

/** The newest job for this user + project (running or recent), or null. */
export function latestQuickJob(userId: string, projectId: string): QuickJob | null {
  prune()
  let best: QuickJob | null = null
  for (const j of jobs.values()) if (j.userId === userId && j.projectId === projectId && (!best || j.createdAt > best.createdAt)) best = j
  return best
}

/**
 * The project's cover changed outside a run — Adjust the title (render with
 * scene = keep) or Finish the look — so the latest finished run shows the
 * cover as it now is when a client reloads it, not the one the run made.
 * With a `size` the title was re-lettered: its resolved colour/spot replace
 * the run's; without one only the cover URLs move (a look on the same title).
 */
export function syncQuickCover(
  userId: string, projectId: string,
  cover: {
    artwork_url: string | null; finalized_artwork_url: string | null; color?: string | null; position?: LetteringPosition | null; size?: LetteringSize
    /** Another take of the run was made the cover (render with scene = take). */
    takePath?: string
  },
): void {
  const j = latestQuickJob(userId, projectId)
  if (!j || j.status === 'running' || !cover.artwork_url) return
  const take = cover.takePath ? j.takes.findIndex(t => t.path === cover.takePath) : -1
  update(j, {
    artwork_url: cover.artwork_url,
    finalized_artwork_url: cover.finalized_artwork_url,
    title: cover.size ? { color: cover.color ?? null, position: cover.position ?? null, size: cover.size } : j.title,
    take: take >= 0 ? take : j.take,
  })
}

export type StartResult = { ok: true; job: QuickJob } | { ok: false; code: 'user_busy' | 'server_busy'; existing?: QuickJob }

export type QuickRequest = {
  userId: string
  projectId: string
  title: string
  genre?: string | null
  bpm?: number | null
  key?: string | null
  /** The artist's own idea for the cover; '' → the idea comes from the title. */
  description: string
  subjectPath: string
  /** An exact scene brief, used as written instead of an art-directed concept. */
  prompt?: string
  /** Which clips to make (default both). */
  formats?: QuickFormat[]
  /** How many takes to draw (default DEFAULT_TAKES). */
  takes?: number
  /** Pin one image model instead of the best-first chain. */
  model?: ArtModelId
}

export function startQuickJob(args: QuickRequest): StartResult {
  prune()
  let running = 0
  for (const j of jobs.values()) {
    if (j.status !== 'running') continue
    running++
    if (j.userId === args.userId) return { ok: false, code: 'user_busy', existing: j }
  }
  if (running >= MAX_RUNNING) return { ok: false, code: 'server_busy' }
  const now = Date.now()
  const formats = args.formats ?? ['canvas', 'youtube']
  const job: QuickJob = {
    id: randomUUID(),
    userId: args.userId,
    projectId: args.projectId,
    description: args.description,
    status: 'running',
    stage: 'Finding the idea…',
    steps: {
      brief: 'running', cover: 'pending',
      canvas: formats.includes('canvas') ? 'pending' : 'skipped',
      youtube: formats.includes('youtube') ? 'pending' : 'skipped',
    },
    scene_label: null,
    idea: null,
    takes: [],
    take: null,
    model: null,
    artwork_url: null,
    finalized_artwork_url: null,
    lettering: null,
    title: null,
    clips: [],
    notes: [],
    error: null,
    createdAt: now,
    updatedAt: now,
  }
  jobs.set(job.id, job)
  void run(job, { ...args, formats })
  return { ok: true, job }
}

function update(job: QuickJob, patch: Partial<QuickJob>) {
  Object.assign(job, patch, { updatedAt: Date.now() })
}
function setStep(job: QuickJob, step: QuickStep, state: StepState) {
  job.steps = { ...job.steps, [step]: state }
  job.updatedAt = Date.now()
}

const FORMAT_LABEL: Record<QuickFormat, string> = { canvas: 'Canvas', youtube: 'YouTube' }

/**
 * A run does not film its clips on its own (2026-11-11): two Veo 3.1 clips
 * cost about $6 of Runway credits, twelve times the cover itself, and were
 * spent before the artist had seen the cover. The clips are the cover set in
 * slow motion (no AI) until filming is asked for.
 */
const AUTO_FILM = false
class FilmingOff extends Error {}

async function run(job: QuickJob, req: QuickRequest & { formats: QuickFormat[] }): Promise<void> {
  try {
    // ── 1. Concept ────────────────────────────────────────────────────────
    const concept = req.prompt?.trim()
      ? promptConcept(req.prompt, req.title)
      : await writeCoverConcept({
          title: req.title, idea: job.description, genre: req.genre, bpm: req.bpm, key: req.key,
          avoid: await recentIdeas(job.userId),
        })
    update(job, { scene_label: concept.label, idea: concept.idea })
    setStep(job, 'brief', 'done')

    // ── 2. Lettering ──────────────────────────────────────────────────────
    update(job, { stage: 'Writing the title in your handwriting…' })
    const lettering = await buildLettering(job, req.title)
    if (lettering) update(job, { lettering })

    // ── 3. Cover ──────────────────────────────────────────────────────────
    setStep(job, 'cover', 'running')
    update(job, { stage: 'Drawing the cover around your cassette (about 2 minutes)…' })
    const project = await loadCoverProject(job.userId, job.projectId)
    if (!project) throw new CoverError('Project not found', 404)
    let cover: CoverResult
    try {
      cover = await drawCover(job, req, concept, project, lettering)
    } catch (err) {
      if (err instanceof CoverError) throw err
      // No art model could draw it: the classic engine still makes a cover.
      console.error('[cassette-quick] art engine failed, using the classic scene:', err instanceof Error ? err.message : err)
      update(job, { stage: 'Building the cover around your cassette (~40s)…', takes: [], take: null, model: null })
      const setting = job.description || `a dark stone ledge in low dramatic light, a mood that suits a song called ${req.title || 'this one'}`
      cover = await makeStudioCover({
        userId: job.userId, project, scene: 'custom', setting: concept.label, subjectPath: req.subjectPath, background: null,
        letteringPath: lettering?.path ?? '', color: 'auto', position: 'auto', size: 'medium', reflection: false,
        placement: {}, prompt: scenePrompt(setting),
      })
      job.notes.push('The drawn cover was not available this time, so this one is your cassette photo in a painted scene.')
    }
    update(job, {
      artwork_url: cover.artwork_url, finalized_artwork_url: cover.finalized_artwork_url,
      title: lettering ? { color: cover.color, position: cover.position, size: 'medium' } : null,
    })
    setStep(job, 'cover', 'done')

    // ── 4. Clips ──────────────────────────────────────────────────────────
    if (req.formats.length) {
      update(job, { stage: `Filming the ${req.formats.map(f => FORMAT_LABEL[f]).join(' and ')} scene${req.formats.length > 1 ? 's' : ''} (2–4 min)…` })
      await Promise.all(req.formats.map(f => film(job, f, concept, cover.artwork_url)))
    }

    const failed = req.formats.filter(f => job.steps[f] === 'failed')
    update(job, { status: 'done', stage: failed.length ? `Done, except ${failed.map(f => FORMAT_LABEL[f]).join(' and ')}.` : 'Done.' })
  } catch (err) {
    const msg = err instanceof CoverError ? err.message : 'Could not make the cover. Please try again.'
    if (!(err instanceof CoverError)) console.error('[cassette-quick] run failed:', err instanceof Error ? err.message : err)
    for (const s of ['brief', 'cover', 'canvas', 'youtube'] as const) if (job.steps[s] === 'running' || job.steps[s] === 'pending') setStep(job, s, 'failed')
    update(job, { status: 'error', error: msg, stage: msg })
  }
}

/**
 * The ideas this artist's recent one-click covers used, newest first, so the
 * next one is told to do something else. Read back from the clips each run
 * saved (their titles are "<idea> · Canvas" / "<idea> · YouTube"). Best-effort.
 */
async function recentIdeas(userId: string): Promise<string[]> {
  try {
    const { data, error } = await supabaseAdmin
      .from('mb_visualizers')
      .select('title')
      .eq('user_id', userId)
      .eq('settings->>source', 'cassette-quick')
      .order('created_at', { ascending: false })
      .limit(40)
    if (error || !data) return []
    const seen = new Set<string>()
    for (const row of data as { title?: string | null }[]) {
      const idea = (row.title ?? '').replace(/\s+·\s+(Canvas|YouTube)\s*$/, '').trim()
      if (idea.length >= 3 && seen.size < 8) seen.add(idea)
    }
    return [...seen]
  } catch {
    return []
  }
}

/** Runs of takes kept per song (older ones are removed when a new run starts). */
const KEEP_TAKE_RUNS = 2

/** Remove this song's takes from all but its newest runs. Best-effort. */
async function pruneTakes(userId: string, projectId: string): Promise<void> {
  try {
    const mine = (await listStudio(userId, `take-${projectId}-`))
      .map(f => ({ f, k: parseTakeKey(f.path, userId) }))
      .filter((e): e is { f: StudioFile; k: NonNullable<ReturnType<typeof parseTakeKey>> } => e.k !== null && e.k.projectId === projectId)
    const runs = [...new Set(mine.map(e => e.k.run))].sort((a, b) => Number(b) - Number(a))
    const keep = new Set(runs.slice(0, KEEP_TAKE_RUNS - 1))
    await removeStudio(mine.filter(e => !keep.has(e.k.run)).map(e => e.f.path))
  } catch (err) {
    console.error('[cassette-quick] take pruning failed:', err instanceof Error ? err.message : err)
  }
}

/**
 * The drawn cover: takes from the art engine, the best one chosen and made
 * the project's cover. Counts once against the monthly artwork allowance
 * (refunded on failure). Throws CoverError for what the artist should read,
 * anything else when no art model could draw it (the caller then falls back
 * to the classic engine).
 */
async function drawCover(
  job: QuickJob, req: QuickRequest, concept: CoverConcept, project: CoverProject, lettering: StudioFile | null,
): Promise<CoverResult> {
  const { userId, projectId } = job
  const count = Math.max(1, Math.min(MAX_TAKES, Math.round(req.takes ?? DEFAULT_TAKES)))
  const gate = await checkAndIncrementUsage(userId, 'artwork')
  if (gate.error) throw new CoverError('Could not reserve a generation slot. Please try again.', 503)
  if (!gate.allowed) {
    throw new CoverError(`Monthly artwork limit reached (${gate.used}/${gate.limit}). Your allowance resets at the start of next month.`, 403)
  }
  let refund: (() => Promise<unknown>) | null = () => refundUsage(userId, 'artwork', gate.month)
  const run = String(Date.now())
  const tmp: string[] = []
  try {
    const reference = await buildReference(await downloadStudio(req.subjectPath))
    const refPath = `${studioPrefix(userId)}tmp-${run}-ref.jpg`
    tmp.push(refPath)
    const refUrl = await uploadStudio(refPath, reference, 'image/jpeg')
    const prompt = artPrompt(concept.scene)

    let set = await generateTakes(refUrl, prompt, count, req.model)
    update(job, { stage: 'Choosing the best take…', model: set.model.label })
    let verdict = await judgeTakes(reference, set.takes, concept)
    if (verdict.notes.length) console.log('[cassette-quick] takes:', verdict.notes.join(' | '))
    if (!verdict.usable && verdict.fix) {
      // The cassette came out wrong in every take: one corrected redraw.
      update(job, { stage: 'Redrawing: the cassette was not right yet…' })
      try {
        const again = await generateTakes(refUrl, `${prompt}\n\nThe last attempt got this wrong, correct it: ${verdict.fix}`, Math.min(2, count), req.model)
        const second = await judgeTakes(reference, again.takes, concept)
        if (second.notes.length) console.log('[cassette-quick] redraw:', second.notes.join(' | '))
        if (second.usable) { set = again; verdict = second }
      } catch (err) {
        console.error('[cassette-quick] corrected redraw failed:', err instanceof Error ? err.message : err)
      }
      if (!verdict.usable) job.notes.push('The cassette is not drawn quite like yours in this one. Make it again for another go.')
    }

    await pruneTakes(userId, projectId)
    const takes: StudioFile[] = []
    for (let i = 0; i < set.takes.length; i++) {
      const path = takeKey(userId, projectId, run, i)
      await uploadStudio(path, await storeTake(set.takes[i]), 'image/jpeg')
      takes.push({ path, url: studioPublicUrl(path), createdAt: new Date(Number(run)).toISOString() })
    }
    const best = Math.min(verdict.best, takes.length - 1)
    update(job, { takes, take: best, model: set.model.label, stage: 'Lettering the cover…' })

    const cover = await makeStudioCover({
      userId, project, scene: 'take', setting: concept.label, takePath: takes[best].path, subjectPath: '', background: null,
      letteringPath: lettering?.path ?? '', color: 'auto', position: verdict.spot ?? 'auto', size: 'medium', reflection: false,
      placement: {},
    })
    refund = null
    return cover
  } finally {
    if (refund) await refund()
    await removeStudio(tmp)
  }
}

/**
 * The lockup for this song: signature over the title written from the glyph
 * bank. A title the bank cannot write falls back to this song's own newest
 * handwriting photo, used whole. Saved as the project's lettering. Null when
 * there is no handwriting of any kind yet (the cover is made unlettered).
 */
async function buildLettering(job: QuickJob, title: string): Promise<StudioFile | null> {
  const { userId, projectId } = job
  let signature: Buffer | null = null
  try {
    signature = (await loadSignature(userId))?.png ?? null
  } catch (err) {
    console.error('[cassette-quick] signature load failed:', err instanceof Error ? err.message : err)
  }

  const { text, dropped } = titleForHandwriting(title)
  // Without a signature the title stays on one line, so a later look for a
  // signature (the first of two lines) can never mistake a title for one.
  const lines = signature ? text : text.replace(/\n/g, ' ')
  let titlePng: Buffer | null = null
  let metrics: TitleMetrics | undefined
  let missing: string[] = []
  if (lines) {
    try {
      const bank = await loadGlyphBank(userId, lines)
      const out = await composeHandwriting(lines, bank, { align: 'center', seed: (Math.random() * 2147483647) >>> 0 })
      if (out.ok) { titlePng = out.lettering.png; metrics = { cap: out.cap, stroke: out.stroke } }
      else missing = out.missing
    } catch (err) {
      console.error('[cassette-quick] title compose failed:', err instanceof Error ? err.message : err)
    }
  }
  if (dropped.length) job.notes.push(`Left out of the handwritten title: ${dropped.join(' ')}`)

  if (!titlePng) {
    // This song's own photographed handwriting, if it has one.
    try {
      const own = (await listStudio(userId, `lettering-${projectId}-`)).filter(f => isOwnStudioKey(f.path, userId, 'lettering'))[0]
      if (own) {
        job.notes.push(missing.length
          ? `Used this song's own handwriting photo — the title has letters your handwriting sheet doesn't cover (${missing.join(' ')}).`
          : "Used this song's own handwriting photo.")
        return own
      }
    } catch (err) {
      console.error('[cassette-quick] lettering listing failed:', err instanceof Error ? err.message : err)
    }
    if (missing.length) job.notes.push(`The title isn't on the cover yet: no handwriting for ${missing.join(' ')}. Add your handwriting sheet once and every title is written automatically.`)
    else if (!signature) job.notes.push('No handwriting on the cover yet: add your handwriting sheet once in Setup.')
  }

  const lockup = await stackLockup(signature, titlePng, metrics)
  if (!lockup) return null
  const ts = Date.now()
  const path = `${studioPrefix(userId)}lettering-${projectId}-${ts}.png`
  const url = await uploadStudio(path, lockup.png, 'image/png')
  return { path, url, createdAt: new Date(ts).toISOString() }
}

/**
 * One moving scene: extend the cover to the format's shape, film it, loop it,
 * save it, pin it. If it cannot be filmed, the same extended still is set
 * gently in motion instead (a classic cover gets its turning reels). Never throws.
 */
async function film(job: QuickJob, format: QuickFormat, concept: CoverConcept, artworkUrl: string): Promise<void> {
  setStep(job, format, 'running')
  const shape: FrameShape = format === 'canvas' ? 'portrait' : 'landscape'
  const size = format === 'canvas' ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 }
  const tmp: string[] = []
  let refund: (() => Promise<unknown>) | null = null
  let reason = ''
  /** The cover extended to this format's shape, once there is one. */
  let still: Buffer | null = null
  let cover: Buffer | null = null
  try {
    const key = storagePathFromUrl(artworkUrl, ARTWORK_BUCKET)
    if (!key) throw new Error('cover not found in storage')
    cover = await downloadStudio(key)
    const ts = `${Date.now()}-${format}`
    try {
      const req = await buildOutpaintRequest(cover, shape)
      const imgPath = `${studioPrefix(job.userId)}tmp-${ts}-wide.jpg`
      const maskPath = `${studioPrefix(job.userId)}tmp-${ts}-widemask.png`
      tmp.push(imgPath, maskPath)
      const [imgUrl, maskUrl] = await Promise.all([
        uploadStudio(imgPath, req.image, 'image/jpeg'),
        uploadStudio(maskPath, req.mask, 'image/png'),
      ])
      const filled = await fillScene(imgUrl, maskUrl, outpaintPrompt(concept), (Math.random() * 2147483647) >>> 0)
      still = await finishOutpaint(filled, cover, req, size.width)
    } catch (err) {
      // The picture could not be extended: the whole cover over a soft blur of itself.
      console.error(`[cassette-quick] ${format} extension failed:`, err instanceof Error ? err.message : err)
      still = await fitStill(cover, size.width, size.height)
    }
    if (!AUTO_FILM) throw new FilmingOff()
    const stillPath = `${studioPrefix(job.userId)}tmp-${ts}-still.jpg`
    tmp.push(stillPath)
    const stillUrl = await uploadStudio(stillPath, still, 'image/jpeg')

    const gate = await checkAndIncrementUsage(job.userId, 'video')
    if (gate.error || !gate.allowed) throw new VideoUnavailable('no video allowance')
    refund = () => refundUsage(job.userId, 'video', gate.month)
    const shot = await filmStill(stillUrl, concept.motion, shape)
    const loop = await seamlessLoop(shot.bytes, { width: size.width, height: size.height, fade: 0.8 })
    const stored = await storeVisualizer({
      userId: job.userId,
      projectId: job.projectId,
      bytes: loop,
      contentType: 'video/mp4',
      kind: 'ai',
      title: `${concept.label} · ${FORMAT_LABEL[format]}`,
      sourceImageUrl: artworkUrl,
      settings: { source: 'cassette-quick', format, model: shot.model },
    })
    if (!stored) throw new Error('saving the clip failed')
    refund = null
    await pin(job.userId, job.projectId, stored.video_url, format === 'youtube')
    job.clips = [...job.clips, { format, video_url: stored.video_url, kind: 'cinematic', model: shot.model }]
    setStep(job, format, 'done')
    return
  } catch (err) {
    if (!(err instanceof FilmingOff)) {
      reason = err instanceof VideoUnavailable ? 'cinematic video is not available right now' : 'the cinematic shot could not be made'
      console.error(`[cassette-quick] ${format} cinematic failed:`, err instanceof Error ? err.message : err)
    }
  } finally {
    if (refund) await refund()
    await removeStudio(tmp)
  }

  // Fallback (no AI). A classic cover has its own cassette layer: the reels turn.
  try {
    const project = await loadCoverProject(job.userId, job.projectId)
    if (!project) throw new Error('project vanished')
    let stored: { id: string; video_url: string } | null = null
    let what = 'the cover in slow motion'
    if (job.model === null) {
      stored = await makeMovingCover(job.userId, project, format, false, 'cassette-quick')
      what = 'the cassette loop'
    } else {
      const base = still ?? (cover ? await fitStill(cover, size.width, size.height) : null)
      if (!base) throw new Error('no still to move')
      const bytes = await stillLoop(base, size)
      stored = await storeVisualizer({
        userId: job.userId,
        projectId: job.projectId,
        bytes,
        contentType: 'video/mp4',
        kind: 'free',
        title: `${concept.label} · ${FORMAT_LABEL[format]}`,
        sourceImageUrl: artworkUrl,
        settings: { source: 'cassette-quick', format, title: false, motion: 'drift' },
      })
      if (!stored) throw new Error('saving the loop failed')
    }
    await pin(job.userId, job.projectId, stored.video_url, format === 'youtube')
    job.clips = [...job.clips, { format, video_url: stored.video_url, kind: 'loop', model: null }]
    if (reason) job.notes.push(`${FORMAT_LABEL[format]}: ${reason}, so it is ${what} instead.`)
    setStep(job, format, 'done')
  } catch (err) {
    console.error(`[cassette-quick] ${format} loop fallback failed:`, err instanceof Error ? err.message : err)
    job.notes.push(`${FORMAT_LABEL[format]} could not be made this time.`)
    setStep(job, format, 'failed')
  }
}

/** What FLUX Fill is told when it extends a cover beyond its edges: the same picture, continued. */
function outpaintPrompt(concept: CoverConcept): string {
  const scene = concept.scene.trim().replace(/\s+/g, ' ').slice(0, 700)
  return `The same picture continued seamlessly beyond its edges, in the same medium, light and palette, with no new subjects, no text and no borders. ${scene}`
}

/** Pin a clip on the project: Canvas → visualizer_url, YouTube → visualizer_wide_url. */
async function pin(userId: string, projectId: string, url: string, wide: boolean): Promise<void> {
  const column = wide ? 'visualizer_wide_url' : 'visualizer_url'
  const run = () => supabaseAdmin
    .from('mb_projects')
    .update({ [column]: url, updated_at: new Date().toISOString() })
    .eq('id', projectId)
    .eq('user_id', userId)
  let { error } = await run()
  if (error && isMissingVisualizerColumn(error) && await ensureProjectVisualizerColumn()) ({ error } = await run())
  if (error) throw new Error(`pin: ${error.message}`)
}
