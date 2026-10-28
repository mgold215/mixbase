// Cassette Studio — ONE CLICK. The artist describes a scene; this makes the
// whole release look from it, in the background, while the screen polls:
//
//   1. brief     the description becomes a photo brief + a motion brief
//                (scene-brief.ts — Claude, or a template from their words)
//   2. lettering the artist's handwritten name (signature) over the song
//                title written in their own hand (glyph bank), as one lockup;
//                if a title letter was never taught, this song's own
//                photographed handwriting is used instead, never a guess
//   3. cover     the real cassette in the described scene (FLUX Fill around
//                it), the lockup in the calmest corner, auto ink colour —
//                applied to the project as soon as it lands
//   4. clips     the same scene extended to 9:16 and 16:9 (FLUX Fill
//                outpainting around the untouched cover) and filmed as a
//                photoreal moving shot of the cassette playing (Runway), made
//                a seamless silent loop, saved and pinned: Canvas → the
//                vertical visualizer, YouTube → the wide one. If a shot cannot
//                be filmed, that format falls back to the no-AI moving cover
//                (the real cassette's reels turning) so the release is never
//                left without one.
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
  downloadStudio, fillScene, isOwnStudioKey, listStudio, loadGlyphBank, loadSignature, removeStudio, studioPrefix, uploadStudio,
  type StudioFile,
} from '@/lib/cassette-server'
import { buildOutpaintRequest, finishOutpaint, type FrameShape } from '@/lib/cassette-studio'
import { scenePrompt } from '@/lib/cassette-scenes'
import { composeHandwriting } from '@/lib/handwriting-glyphs'
import { stackLockup, titleForHandwriting } from '@/lib/handwriting-sheet'
import { writeSceneBrief, type SceneBrief } from '@/lib/scene-brief'
import { filmStill, VideoUnavailable } from '@/lib/runway-video'
import { seamlessLoop } from '@/lib/video-loop'
import { storeVisualizer } from '@/lib/visualizer-store'
import { CoverError, loadCoverProject, makeMovingCover, makeStudioCover } from '@/lib/cassette-pipeline'

export type QuickStep = 'brief' | 'cover' | 'canvas' | 'youtube'
export type StepState = 'pending' | 'running' | 'done' | 'failed'
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
  artwork_url: string | null
  finalized_artwork_url: string | null
  lettering: StudioFile | null
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

export type StartResult = { ok: true; job: QuickJob } | { ok: false; code: 'user_busy' | 'server_busy'; existing?: QuickJob }

export function startQuickJob(args: { userId: string; projectId: string; title: string; description: string; subjectPath: string }): StartResult {
  prune()
  let running = 0
  for (const j of jobs.values()) {
    if (j.status !== 'running') continue
    running++
    if (j.userId === args.userId) return { ok: false, code: 'user_busy', existing: j }
  }
  if (running >= MAX_RUNNING) return { ok: false, code: 'server_busy' }
  const now = Date.now()
  const job: QuickJob = {
    id: randomUUID(),
    userId: args.userId,
    projectId: args.projectId,
    description: args.description,
    status: 'running',
    stage: 'Writing the shot…',
    steps: { brief: 'running', cover: 'pending', canvas: 'pending', youtube: 'pending' },
    scene_label: null,
    artwork_url: null,
    finalized_artwork_url: null,
    lettering: null,
    clips: [],
    notes: [],
    error: null,
    createdAt: now,
    updatedAt: now,
  }
  jobs.set(job.id, job)
  void run(job, args.title, args.subjectPath)
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

async function run(job: QuickJob, title: string, subjectPath: string): Promise<void> {
  try {
    // ── 1. Brief ──────────────────────────────────────────────────────────
    const brief = await writeSceneBrief(job.description)
    update(job, { scene_label: brief.label })
    setStep(job, 'brief', 'done')

    // ── 2. Lettering ──────────────────────────────────────────────────────
    update(job, { stage: 'Writing the title in your handwriting…' })
    const lettering = await buildLettering(job, title)
    if (lettering) update(job, { lettering })

    // ── 3. Cover ──────────────────────────────────────────────────────────
    setStep(job, 'cover', 'running')
    update(job, { stage: 'Building the cover around your cassette (~40s)…' })
    const project = await loadCoverProject(job.userId, job.projectId)
    if (!project) throw new CoverError('Project not found', 404)
    const cover = await makeStudioCover({
      userId: job.userId, project, scene: 'custom', setting: brief.label, subjectPath, background: null,
      letteringPath: lettering?.path ?? '', color: 'auto', position: 'auto', size: 'medium', reflection: false,
      placement: {}, prompt: scenePrompt(brief.setting),
    })
    update(job, { artwork_url: cover.artwork_url, finalized_artwork_url: cover.finalized_artwork_url })
    setStep(job, 'cover', 'done')

    // ── 4. Clips ──────────────────────────────────────────────────────────
    update(job, { stage: 'Filming the Canvas and YouTube scenes (2–4 min)…' })
    await Promise.all((['canvas', 'youtube'] as const).map(f => film(job, f, brief, cover.artwork_url)))

    const failed = (['canvas', 'youtube'] as const).filter(f => job.steps[f] === 'failed')
    update(job, { status: 'done', stage: failed.length ? `Done, except ${failed.map(f => FORMAT_LABEL[f]).join(' and ')}.` : 'Done.' })
  } catch (err) {
    const msg = err instanceof CoverError ? err.message : 'Could not make the cover. Please try again.'
    if (!(err instanceof CoverError)) console.error('[cassette-quick] run failed:', err instanceof Error ? err.message : err)
    for (const s of ['brief', 'cover', 'canvas', 'youtube'] as const) if (job.steps[s] === 'running' || job.steps[s] === 'pending') setStep(job, s, 'failed')
    update(job, { status: 'error', error: msg, stage: msg })
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
  let missing: string[] = []
  if (lines) {
    try {
      const bank = await loadGlyphBank(userId, lines)
      const out = await composeHandwriting(lines, bank, { align: 'left', seed: (Math.random() * 2147483647) >>> 0 })
      if (out.ok) titlePng = out.lettering.png
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

  const lockup = await stackLockup(signature, titlePng)
  if (!lockup) return null
  const ts = Date.now()
  const path = `${studioPrefix(userId)}lettering-${projectId}-${ts}.png`
  const url = await uploadStudio(path, lockup.png, 'image/png')
  return { path, url, createdAt: new Date(ts).toISOString() }
}

/**
 * One moving scene: extend the cover to the format's shape, film it, loop it,
 * save it, pin it. Falls back to the no-AI moving cover. Never throws.
 */
async function film(job: QuickJob, format: QuickFormat, brief: SceneBrief, artworkUrl: string): Promise<void> {
  setStep(job, format, 'running')
  const shape: FrameShape = format === 'canvas' ? 'portrait' : 'landscape'
  const size = format === 'canvas' ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 }
  const tmp: string[] = []
  let refund: (() => Promise<unknown>) | null = null
  let reason = ''
  try {
    const key = storagePathFromUrl(artworkUrl, ARTWORK_BUCKET)
    if (!key) throw new Error('cover not found in storage')
    const cover = await downloadStudio(key)
    const ts = `${Date.now()}-${format}`
    const req = await buildOutpaintRequest(cover, shape)
    const imgPath = `${studioPrefix(job.userId)}tmp-${ts}-wide.jpg`
    const maskPath = `${studioPrefix(job.userId)}tmp-${ts}-widemask.png`
    tmp.push(imgPath, maskPath)
    const [imgUrl, maskUrl] = await Promise.all([
      uploadStudio(imgPath, req.image, 'image/jpeg'),
      uploadStudio(maskPath, req.mask, 'image/png'),
    ])
    const filled = await fillScene(imgUrl, maskUrl, scenePrompt(brief.setting), (Math.random() * 2147483647) >>> 0)
    const still = await finishOutpaint(filled, cover, req, size.width)
    const stillPath = `${studioPrefix(job.userId)}tmp-${ts}-still.jpg`
    tmp.push(stillPath)
    const stillUrl = await uploadStudio(stillPath, still, 'image/jpeg')

    const gate = await checkAndIncrementUsage(job.userId, 'video')
    if (gate.error || !gate.allowed) throw new VideoUnavailable('no video allowance')
    refund = () => refundUsage(job.userId, 'video', gate.month)
    const shot = await filmStill(stillUrl, brief.motion, shape)
    const loop = await seamlessLoop(shot.bytes, { width: size.width, height: size.height, fade: 0.8 })
    const stored = await storeVisualizer({
      userId: job.userId,
      projectId: job.projectId,
      bytes: loop,
      contentType: 'video/mp4',
      kind: 'ai',
      title: `${brief.label} · ${FORMAT_LABEL[format]}`,
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
    reason = err instanceof VideoUnavailable ? 'cinematic video is not available right now' : 'the cinematic shot could not be made'
    console.error(`[cassette-quick] ${format} cinematic failed:`, err instanceof Error ? err.message : err)
  } finally {
    if (refund) await refund()
    await removeStudio(tmp)
  }

  // Fallback: the real cassette's reels turning in the cover itself.
  try {
    const project = await loadCoverProject(job.userId, job.projectId)
    if (!project) throw new Error('project vanished')
    const stored = await makeMovingCover(job.userId, project, format, false, 'cassette-quick')
    await pin(job.userId, job.projectId, stored.video_url, format === 'youtube')
    job.clips = [...job.clips, { format, video_url: stored.video_url, kind: 'loop', model: null }]
    job.notes.push(`${FORMAT_LABEL[format]}: ${reason}, so it uses the cassette loop instead.`)
    setStep(job, format, 'done')
  } catch (err) {
    console.error(`[cassette-quick] ${format} loop fallback failed:`, err instanceof Error ? err.message : err)
    job.notes.push(`${FORMAT_LABEL[format]} could not be made this time.`)
    setStep(job, format, 'failed')
  }
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
