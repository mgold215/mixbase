import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { canonicalUuid, isSupabaseStorageUrl } from '@/lib/validators'
import { cassetteStudioLimiter, checkUserLimit, rateLimitHeaders } from '@/lib/rate-limit'
import { checkAndIncrementUsage, refundUsage } from '@/lib/tier'
import {
  downloadStudio, fillScene, isOwnStudioKey, readPhoto, removeStudio, studioPrefix, uploadStudio, StudioUnavailable,
} from '@/lib/cassette-server'
import {
  applyLettering, buildFillRequest, composeCover, placeSubject,
  LETTERING_POSITIONS, LETTERING_SIZES, type LetteringPosition, type LetteringSize,
} from '@/lib/cassette-studio'
import { CASSETTE_SCENES, isSceneId, MAX_CUSTOM_SETTING, scenePrompt } from '@/lib/cassette-scenes'
import sharp from 'sharp'

export const runtime = 'nodejs'
export const maxDuration = 180

// POST /api/cassette-studio/render   (multipart)
//
//   project_id   uuid, owned by the caller
//   subject      studio/<userId>/subject-<ts>.png   (required unless scene=keep)
//   scene        a preset id | 'random' | 'custom' | 'photo' | 'keep'
//   setting      free text when scene=custom
//   background   image file when scene=photo
//   lettering    studio/<userId>/lettering-<projectId>-<ts>.png, optional
//   color        '#rrggbb' | 'auto'
//   position     one of LETTERING_POSITIONS
//   size         small | medium | large
//   reflection   '1' for a glossy surface (photo mode)
//
// Writes the clean composite as the project's artwork_url and, when lettering
// is given, the lettered version as finalized_artwork_url — the same
// source/finalized split the rest of the Artwork tab uses. scene=keep skips the
// scene entirely and re-letters the CURRENT artwork (change colour or position
// without paying for a new scene).
//
// Only the AI scene path (preset/random/custom) counts against the monthly
// artwork allowance; the reservation is refunded on any failure.
export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const limit = await checkUserLimit(cassetteStudioLimiter, userId)
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded. Try again later.' }, { status: 429, headers: rateLimitHeaders(limit) })
  }

  const form = await request.formData().catch(() => null)
  if (!form) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  const str = (k: string) => { const v = form.get(k); return typeof v === 'string' ? v : '' }

  const projectId = canonicalUuid(str('project_id'))
  if (!projectId) return NextResponse.json({ error: 'Valid project_id is required' }, { status: 400 })
  const { data: project } = await supabaseAdmin
    .from('mb_projects').select('id, artwork_url').eq('id', projectId).eq('user_id', userId).single()
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  let scene = str('scene') || 'random'
  if (scene === 'random') scene = CASSETTE_SCENES[Math.floor(Math.random() * CASSETTE_SCENES.length)].id
  const isAiScene = isSceneId(scene) || scene === 'custom'
  if (!isAiScene && scene !== 'photo' && scene !== 'keep') {
    return NextResponse.json({ error: 'Unknown scene' }, { status: 400 })
  }
  const setting = scene === 'custom' ? str('setting').trim().slice(0, MAX_CUSTOM_SETTING) : ''
  if (scene === 'custom' && !setting) return NextResponse.json({ error: 'Describe the scene first.' }, { status: 400 })

  const subjectPath = str('subject')
  if (scene !== 'keep' && !isOwnStudioKey(subjectPath, userId, 'subject')) {
    return NextResponse.json({ error: 'Add a cassette photo first.' }, { status: 400 })
  }
  const letteringPath = str('lettering')
  if (letteringPath && (!isOwnStudioKey(letteringPath, userId, 'lettering') || !letteringPath.includes(`/lettering-${projectId}-`))) {
    return NextResponse.json({ error: 'Lettering not found' }, { status: 404 })
  }
  if (scene === 'keep' && !letteringPath) return NextResponse.json({ error: 'Add your handwriting first.' }, { status: 400 })
  const position: LetteringPosition = (LETTERING_POSITIONS as readonly string[]).includes(str('position')) ? str('position') as LetteringPosition : 'bottom-left'
  const size: LetteringSize = (LETTERING_SIZES as readonly string[]).includes(str('size')) ? str('size') as LetteringSize : 'medium'
  const color = /^#[0-9a-f]{6}$/i.test(str('color')) ? str('color') : 'auto'

  let background: Buffer | null = null
  if (scene === 'photo') {
    const photo = await readPhoto(form, 'background')
    if (typeof photo === 'string') return NextResponse.json({ error: photo }, { status: 400 })
    background = photo
  }

  const seed = (Math.random() * 2147483647) >>> 0
  const ts = Date.now()
  const tmp: string[] = []
  let refund: (() => Promise<unknown>) | null = null
  let prompt: string | null = null

  try {
    // ── 1. The clean composite (artwork_url) ────────────────────────────────
    let art: Buffer
    let artPath: string
    if (scene === 'keep') {
      if (!project.artwork_url || !isSupabaseStorageUrl(project.artwork_url)) {
        return NextResponse.json({ error: 'Make a cover first.' }, { status: 400 })
      }
      const res = await fetch(project.artwork_url, { signal: AbortSignal.timeout(30_000) })
      if (!res.ok) return NextResponse.json({ error: 'Could not load the current artwork.' }, { status: 400 })
      art = Buffer.from(await res.arrayBuffer())
      artPath = ''
    } else {
      const subject = await downloadStudio(subjectPath)
      const meta = await sharp(subject).metadata()
      const box = placeSubject(meta.width ?? 1, meta.height ?? 1, seed)

      if (isAiScene) {
        const gate = await checkAndIncrementUsage(userId, 'artwork')
        if (gate.error) return NextResponse.json({ error: 'Could not reserve a generation slot. Please try again.' }, { status: 503 })
        if (!gate.allowed) {
          return NextResponse.json(
            { error: `Monthly artwork limit reached (${gate.used}/${gate.limit}). Your allowance resets at the start of next month. You can still use your own background photo.` },
            { status: 403 },
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

      art = await composeCover({
        background: background!,
        subject,
        box,
        kind: isAiScene ? 'scene' : 'photo',
        seed,
        reflection: str('reflection') === '1' ? 0.6 : 0,
      })
      // ai- prefix → Artwork History files it as 'generated'; an own-photo
      // composite has no AI in it and files as an upload.
      artPath = `${projectId}/${isAiScene ? 'ai-cassette' : 'cassette'}-${ts}.jpg`
    }

    // ── 2. The lettered cover (finalized_artwork_url) ───────────────────────
    let finalized: Buffer | null = null
    let usedColor: string | null = null
    if (letteringPath) {
      const lettering = await downloadStudio(letteringPath)
      const out = await applyLettering(art, lettering, { color, position, size })
      finalized = out.jpeg
      usedColor = out.color
    }

    // ── 3. Save + point the project at it ───────────────────────────────────
    const artworkUrl = artPath ? await uploadArtwork(artPath, art) : project.artwork_url!
    const finalizedUrl = finalized ? await uploadArtwork(`${projectId}/finalized-${ts}.jpg`, finalized) : null
    const { error: dbError } = await supabaseAdmin
      .from('mb_projects')
      .update({ artwork_url: artworkUrl, finalized_artwork_url: finalizedUrl, updated_at: new Date().toISOString() })
      .eq('id', projectId)
      .eq('user_id', userId)
    if (dbError) throw new Error(`db update: ${dbError.message}`)

    refund = null // delivered — the slot is spent
    return NextResponse.json({
      artwork_url: artworkUrl,
      finalized_artwork_url: finalizedUrl,
      scene,
      scene_label: CASSETTE_SCENES.find(s => s.id === scene)?.label ?? (scene === 'custom' ? setting : scene === 'photo' ? 'Your photo' : null),
      prompt_used: prompt,
      color: usedColor,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[cassette-studio] render failed:', msg)
    if (err instanceof StudioUnavailable) {
      return NextResponse.json({ error: 'Scene generation is temporarily unavailable. You can still use your own background photo.' }, { status: 503 })
    }
    return NextResponse.json({ error: 'Could not make the cover. Please try again.' }, { status: 502 })
  } finally {
    if (refund) await refund()
    await removeStudio(tmp)
  }
}

async function uploadArtwork(path: string, bytes: Buffer): Promise<string> {
  const { data, error } = await supabaseAdmin.storage.from('mf-artwork').upload(path, bytes, { contentType: 'image/jpeg', upsert: false })
  if (error || !data) throw new Error(`upload ${path}: ${error?.message}`)
  return supabaseAdmin.storage.from('mf-artwork').getPublicUrl(data.path).data.publicUrl
}
