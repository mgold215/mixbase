// Cassette Studio — the server-side pipeline the routes share: build a cover
// (scene + cassette + handwriting) for a project, and finish a project's cover
// with a look. /api/cassette-studio/render and /filter are thin wrappers that
// validate the request and call in here; /api/cassette-studio/theme/apply
// runs the same two steps from the owner's saved theme, so a release made by
// hand and one made from the theme go through exactly one implementation.
//
// Server-only (Supabase, Replicate). Inputs arrive VALIDATED: a route has
// already pinned the project to the caller, the subject/lettering keys to the
// caller's studio folder (isOwnStudioKey) and the scene to a known id.

import sharp from 'sharp'
import { supabaseAdmin } from '@/lib/supabase'
import { isSupabaseStorageUrl } from '@/lib/validators'
import { checkAndIncrementUsage, refundUsage } from '@/lib/tier'
import { ARTWORK_BUCKET, storagePathFromUrl } from '@/lib/project-assets'
import {
  downloadStudio, fillScene, findStudioObject, removeStudio, studioPrefix, studioPublicUrl, uploadStudio,
} from '@/lib/cassette-server'
import {
  applyLettering, artworkStamp, buildFillRequest, composeLayers, filteredCoverKey, finalizedCoverKey, finishCover,
  layerKey, motionLayerFiles, parseFinalizedCover, parseSourcePath, placeSubject, plateKey, tintLettering, titleKey,
  type CoverLayers, type LetteringPosition, type LetteringSize, type Placement,
} from '@/lib/cassette-studio'
import { CASSETTE_SCENES, scenePrompt } from '@/lib/cassette-scenes'
import { decodeForFilter, filterRawToJpeg, isIdentityFilter, type FilterSettings, type RawImage } from '@/lib/cover-filters'

/** A failure the artist should see as it is, with the HTTP status it maps to. */
export class CoverError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message)
  }
}

export type CoverProject = { id: string; artwork_url: string | null; finalized_artwork_url: string | null }

export async function loadCoverProject(userId: string, projectId: string): Promise<CoverProject | null> {
  const { data, error } = await supabaseAdmin
    .from('mb_projects')
    .select('id, artwork_url, finalized_artwork_url')
    .eq('id', projectId)
    .eq('user_id', userId)
    .single()
  return error || !data ? null : (data as CoverProject)
}

// ── Cover ───────────────────────────────────────────────────────────────────

export type CoverJob = {
  userId: string
  project: CoverProject
  /** A preset id, 'custom', 'photo' or 'keep' (re-letter the current artwork). Never 'random' — resolve it first. */
  scene: string
  /** The custom setting (scene = 'custom'). */
  setting: string
  /** studio/<uid>/subject-<ts>.png; ignored for scene = 'keep'. */
  subjectPath: string
  /** The artist's own background (scene = 'photo'). */
  background: Buffer | null
  /** studio/<uid>/lettering-<projectId>-<ts>.png, or '' for an unlettered cover. */
  letteringPath: string
  /** '#rrggbb' or 'auto'. */
  color: string
  position: LetteringPosition
  size: LetteringSize
  /** A glossy surface (photo mode): mirror the cassette in it. */
  reflection: boolean
  placement: Placement
}

export type CoverResult = {
  artwork_url: string
  finalized_artwork_url: string | null
  scene: string
  scene_label: string | null
  prompt_used: string | null
  color: string | null
}

/** Pick a random preset scene id. */
export function randomSceneId(): string {
  return CASSETTE_SCENES[Math.floor(Math.random() * CASSETTE_SCENES.length)].id
}

/**
 * Build the cover and point the project at it: the clean composite becomes
 * artwork_url and, when lettering is given, the lettered version becomes
 * finalized_artwork_url — the same source/finalized split the rest of the
 * Artwork tab uses. scene = 'keep' skips the scene and re-letters the CURRENT
 * artwork. Alongside the still it keeps what a moving cover is rebuilt from
 * (the plate, the cassette layer, the coloured title — key shapes in
 * cassette-studio.ts "Motion layers"), best-effort.
 *
 * Only an AI scene (preset/custom) counts against the monthly artwork
 * allowance; the reservation is refunded on any failure. Throws CoverError
 * for what the artist should read as is, StudioUnavailable when Replicate is
 * not configured, and anything else for a failure the route reports generically.
 */
export async function makeStudioCover(job: CoverJob): Promise<CoverResult> {
  const { userId, project, scene, setting, letteringPath, color, position, size, placement } = job
  const projectId = project.id
  const isAiScene = scene !== 'photo' && scene !== 'keep'
  let background = job.background

  const seed = (Math.random() * 2147483647) >>> 0
  const ts = Date.now()
  // The stamp shared by this render's cover keys and its motion-layer keys —
  // the ONLY link between them (mf-artwork takes no JSON sidecar).
  const stamp = String(ts)
  const tmp: string[] = []
  // Motion layers written by THIS request; removed again if the render fails,
  // so a cover that never landed leaves nothing behind. `motionPending` is
  // drained before that cleanup so a save still in flight can't land after it.
  const motionSaved: string[] = []
  const motionPending: Promise<void>[] = []
  let delivered = false
  let refund: (() => Promise<unknown>) | null = null
  let prompt: string | null = null

  try {
    // ── 1. The clean composite (artwork_url) ────────────────────────────────
    let art: Buffer
    let artPath: string
    let layers: CoverLayers | null = null
    if (scene === 'keep') {
      if (!project.artwork_url || !isSupabaseStorageUrl(project.artwork_url)) throw new CoverError('Make a cover first.', 400)
      const res = await fetch(project.artwork_url, { signal: AbortSignal.timeout(30_000) })
      if (!res.ok) throw new CoverError('Could not load the current artwork.', 400)
      art = Buffer.from(await res.arrayBuffer())
      artPath = ''
    } else {
      const subject = await downloadStudio(job.subjectPath)
      const meta = await sharp(subject).metadata()
      const box = placeSubject(meta.width ?? 1, meta.height ?? 1, seed, placement)

      if (isAiScene) {
        const gate = await checkAndIncrementUsage(userId, 'artwork')
        if (gate.error) throw new CoverError('Could not reserve a generation slot. Please try again.', 503)
        if (!gate.allowed) {
          throw new CoverError(
            `Monthly artwork limit reached (${gate.used}/${gate.limit}). Your allowance resets at the start of next month. You can still use your own background photo.`,
            403,
          )
        }
        refund = () => refundUsage(userId, 'artwork', gate.month)

        const sceneSetting = scene === 'custom' ? setting : CASSETTE_SCENES.find(s => s.id === scene)!.setting
        prompt = scenePrompt(sceneSetting)
        const fill = await buildFillRequest(subject, box)
        const imgPath = `${studioPrefix(userId)}tmp-${ts}-fill.jpg`
        const maskPath = `${studioPrefix(userId)}tmp-${ts}-mask.png`
        tmp.push(imgPath, maskPath)
        const [imgUrl, maskUrl] = await Promise.all([
          uploadStudio(imgPath, fill.image, 'image/jpeg'),
          uploadStudio(maskPath, fill.mask, 'image/png'),
        ])
        background = await fillScene(imgUrl, maskUrl, prompt, seed)
      }

      layers = await composeLayers({
        background: background!,
        subject,
        box,
        kind: isAiScene ? 'scene' : 'photo',
        seed,
        reflection: job.reflection ? 0.6 : 0,
      })
      art = await finishCover(layers, seed)
      // ai- prefix → Artwork History files it as 'generated'; an own-photo
      // composite has no AI in it and files as an upload.
      artPath = `${projectId}/${isAiScene ? 'ai-cassette' : 'cassette'}-${stamp}.jpg`
    }

    // The moving cover's plate + cassette layer, saved while the still is
    // lettered and uploaded (best-effort: never throws — see saveMotionFile).
    if (layers) motionPending.push(saveMotionLayers(userId, stamp, layers, motionSaved))

    // ── 2. The lettered cover (finalized_artwork_url) ───────────────────────
    let finalized: Buffer | null = null
    let usedColor: string | null = null
    if (letteringPath) {
      const lettering = await downloadStudio(letteringPath)
      const out = await applyLettering(art, lettering, { color, position, size })
      finalized = out.jpeg
      usedColor = out.color
      // The same ink in the same resolved colour ('auto' included), at the
      // lettering's native size: the moving cover's title card. Keyed by the
      // FINALIZED stamp, which on scene=keep differs from the cover's.
      motionPending.push(saveTitle(userId, stamp, lettering, out.color, position, size, motionSaved))
    }

    // ── 3. Save + point the project at it ───────────────────────────────────
    const artworkUrl = artPath ? await uploadCoverFile(artPath, art) : project.artwork_url!
    const finalizedUrl = finalized ? await uploadCoverFile(`${projectId}/finalized-${stamp}.jpg`, finalized) : null
    // Before the project points at the new cover, so a client that asks
    // /api/cassette-studio/motion right after this response finds the layers.
    await Promise.all(motionPending)
    const { error: dbError } = await supabaseAdmin
      .from('mb_projects')
      .update({ artwork_url: artworkUrl, finalized_artwork_url: finalizedUrl, updated_at: new Date().toISOString() })
      .eq('id', projectId)
      .eq('user_id', userId)
    if (dbError) throw new Error(`db update: ${dbError.message}`)

    refund = null // delivered — the slot is spent
    delivered = true
    return {
      artwork_url: artworkUrl,
      finalized_artwork_url: finalizedUrl,
      scene,
      scene_label: CASSETTE_SCENES.find(s => s.id === scene)?.label ?? (scene === 'custom' ? setting : scene === 'photo' ? 'Your photo' : null),
      prompt_used: prompt,
      color: usedColor,
    }
  } finally {
    if (refund) await refund()
    if (!delivered) await Promise.allSettled(motionPending)
    await removeStudio(delivered ? tmp : [...tmp, ...motionSaved])
  }
}

async function uploadCoverFile(path: string, bytes: Buffer): Promise<string> {
  const { data, error } = await supabaseAdmin.storage.from(ARTWORK_BUCKET).upload(path, bytes, { contentType: 'image/jpeg', upsert: false })
  if (error || !data) throw new Error(`upload ${path}: ${error?.message}`)
  return supabaseAdmin.storage.from(ARTWORK_BUCKET).getPublicUrl(data.path).data.publicUrl
}

/** Best-effort studio write for a motion layer: logs and returns on failure, never throws. */
async function saveMotionFile(path: string, bytes: Buffer, contentType: string, saved: string[]): Promise<boolean> {
  try {
    await uploadStudio(path, bytes, contentType)
    saved.push(path)
    return true
  } catch (err) {
    console.error('[cassette-studio] motion layer not saved:', path.slice(path.lastIndexOf('/') + 1), err instanceof Error ? err.message : err)
    return false
  }
}

/** The coloured title card for a finalized stamp. Never throws. */
async function saveTitle(
  userId: string, fstamp: string, lettering: Buffer, color: string,
  position: LetteringPosition, size: LetteringSize, saved: string[],
): Promise<void> {
  try {
    const png = await tintLettering(lettering, color)
    await saveMotionFile(titleKey(userId, fstamp, position, size), png, 'image/png', saved)
  } catch (err) {
    console.error('[cassette-studio] title layer not saved:', err instanceof Error ? err.message : err)
  }
}

/**
 * Plate (q90 JPEG) + finished cassette (RGBA PNG at its placed size) for this
 * stamp. Both or neither: the motion route needs the pair, so a lone survivor
 * is removed rather than left to look like half a cover. Never throws.
 */
async function saveMotionLayers(userId: string, stamp: string, layers: CoverLayers, saved: string[]): Promise<void> {
  try {
    const files = await motionLayerFiles(layers)
    if (!files) return
    const plate = plateKey(userId, stamp)
    const layer = layerKey(userId, stamp, files.left, files.top)
    const [okPlate, okLayer] = await Promise.all([
      saveMotionFile(plate, files.plateJpeg, 'image/jpeg', saved),
      saveMotionFile(layer, files.layerPng, 'image/png', saved),
    ])
    if (okPlate !== okLayer) {
      const lone = okPlate ? plate : layer
      await removeStudio([lone])
      saved.splice(saved.indexOf(lone), 1)
    }
  } catch (err) {
    console.error('[cassette-studio] motion layers not saved:', err instanceof Error ? err.message : err)
  }
}

// ── Look ────────────────────────────────────────────────────────────────────
// A look is always applied to the UNFILTERED cover — the "base" — never to a
// previous filtered result, so re-filtering never stacks. The base is
// resolved from the project's own columns, never named by a request:
//
//   finalized = <pid>/finalized-<fts>.jpg          → base = that file
//   finalized = <pid>/finalized-<fts>-f<code>.jpg  → base = <pid>/finalized-<fts>.jpg if it exists,
//                                                    else artwork_url when its stamp is <fts>
//   no finalized                                   → base = artwork_url, if it is an image under <pid>/
//
// A saved look is <pid>/finalized-<fts>-f<code>.jpg (the look rides in the
// key: mf-artwork takes images only) and becomes finalized_artwork_url;
// artwork_url is never touched. Saving "Original" resets: finalized goes back
// to the base, or to null when the base is the clean artwork (a cover with no
// handwriting). An artwork with no stamp in its name (deezer-<id>.jpg) first
// gets an unfiltered anchor copy, finalized-<now>.jpg, so its look can be
// redone later.

export type CoverBase = {
  /** mf-artwork key of the unfiltered image a look is applied to. */
  key: string
  /** The stamp a filtered cover is keyed by; null → save mints an anchor first. */
  fts: string | null
  /** The base is the project's clean artwork: a reset clears finalized_artwork_url. */
  isArtwork: boolean
}

export const NO_COVER = 'Make a cover first.'
export const LOAD_FAILED = 'Could not load the cover. Please try again.'
const SAVE_MAX_SIDE = 3000

/**
 * The base a look is applied to, and the look the current cover carries.
 * Every candidate key is derived from the row with storagePathFromUrl (our
 * Supabase host + mf-artwork only — any other URL is refused) and re-parsed
 * against THIS project's id, so nothing outside `<projectId>/` can become a
 * base. Throws only when Storage itself fails.
 */
export async function resolveCoverBase(project: CoverProject): Promise<{ base: CoverBase | null; current: FilterSettings | null }> {
  const artKey = storagePathFromUrl(project.artwork_url, ARTWORK_BUCKET)
  if (project.finalized_artwork_url) {
    const finKey = storagePathFromUrl(project.finalized_artwork_url, ARTWORK_BUCKET)
    const fin = parseFinalizedCover(finKey, project.id)
    // A finalized cover this tool did not make and cannot parse: leave it be.
    if (!finKey || !fin) return { base: null, current: null }
    if (!fin.filter) return { base: { key: finKey, fts: fin.fts, isArtwork: false }, current: null }
    const plain = finalizedCoverKey(project.id, fin.fts)
    if (await findStudioObject(plain)) return { base: { key: plain, fts: fin.fts, isArtwork: false }, current: fin.filter }
    if (artKey && artworkStamp(artKey, project.id) === fin.fts) {
      return { base: { key: artKey, fts: fin.fts, isArtwork: true }, current: fin.filter }
    }
    return { base: null, current: fin.filter }
  }
  if (!artKey || parseSourcePath(artKey)?.projectId !== project.id) return { base: null, current: null }
  return { base: { key: artKey, fts: artworkStamp(artKey, project.id), isArtwork: true }, current: null }
}

/**
 * Finish the project's cover with `settings` and point finalized_artwork_url
 * at the result (see the notes above). Throws CoverError(400) when the
 * project has no cover to edit and CoverError(502) when its base cannot be
 * read; anything else is a failure the route reports generically.
 */
export async function saveLookOnProject(
  userId: string, project: CoverProject, settings: FilterSettings,
): Promise<{ artwork_url: string | null; finalized_artwork_url: string | null; filter: FilterSettings | null }> {
  let base: CoverBase | null
  try {
    base = (await resolveCoverBase(project)).base
  } catch (err) {
    console.error('[cassette-studio/filter] lookup failed:', err instanceof Error ? err.message : err)
    throw new CoverError(LOAD_FAILED, 502)
  }
  if (!base) throw new CoverError(NO_COVER, 400)

  let finalizedUrl: string | null
  let filter: FilterSettings | null
  if (isIdentityFilter(settings)) {
    // "Original": back to the base itself — nothing to render.
    finalizedUrl = base.isArtwork ? null : studioPublicUrl(base.key)
    filter = null
  } else {
    let bytes: Buffer
    try {
      bytes = await downloadStudio(base.key)
    } catch (err) {
      console.error('[cassette-studio/filter] base download failed:', err instanceof Error ? err.message : err)
      throw new CoverError(LOAD_FAILED, 502)
    }
    const img = await decodeForFilter(bytes, SAVE_MAX_SIDE)
    let fts = base.fts
    // A clean artwork can share its stamp with a plain finalized cover — a
    // Studio render writes cassette-S.jpg AND the lettered finalized-S.jpg,
    // and restoring the clean one clears finalized. A look keyed by S would
    // then resolve back to the LETTERED base (and the moving cover would find
    // title-S-*.png), bringing the handwriting back. Give it its own stamp.
    if (fts !== null && base.isArtwork && await findStudioObject(finalizedCoverKey(project.id, fts))) fts = null
    if (fts === null) {
      // No stamp of its own to link a look back to this artwork: write the
      // unfiltered anchor finalized-<fts>.jpg first, so the next edit finds its base.
      fts = String(Date.now())
      const anchor = await sharpJpeg(img, 95)
      await uploadLookFile(finalizedCoverKey(project.id, fts), anchor)
    }
    const jpeg = await filterRawToJpeg(img, settings, { quality: 92 })
    finalizedUrl = await uploadLookFile(filteredCoverKey(project.id, fts, settings), jpeg)
    filter = settings
  }

  const { error: dbError } = await supabaseAdmin
    .from('mb_projects')
    .update({ finalized_artwork_url: finalizedUrl, updated_at: new Date().toISOString() })
    .eq('id', project.id)
    .eq('user_id', userId)
  if (dbError) throw new Error(`db update: ${dbError.message}`)
  return { artwork_url: project.artwork_url, finalized_artwork_url: finalizedUrl, filter }
}

async function sharpJpeg(img: RawImage, quality: number): Promise<Buffer> {
  return sharp(img.data, { raw: { width: img.width, height: img.height, channels: 3 } }).jpeg({ quality }).toBuffer()
}

/**
 * Write a cover under the project. upsert:false like every studio write; the
 * one expected collision is the SAME look saved twice on the same cover — the
 * key is derived from (stamp, look) and the render is deterministic, so the
 * object already there is exactly this image and is reused.
 */
async function uploadLookFile(path: string, bytes: Buffer): Promise<string> {
  const { error } = await supabaseAdmin.storage.from(ARTWORK_BUCKET).upload(path, bytes, { contentType: 'image/jpeg', upsert: false })
  if (error && !(await findStudioObject(path))) throw new Error(`upload ${path}: ${error.message}`)
  return studioPublicUrl(path)
}
