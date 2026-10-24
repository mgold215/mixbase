import { NextRequest, NextResponse } from 'next/server'
import { canonicalUuid } from '@/lib/validators'
import { cassetteStudioLimiter, checkUserLimit, rateLimitHeaders } from '@/lib/rate-limit'
import { isAdminIdentity } from '@/lib/admin-identity'
import { isOwnStudioKey, readPhoto, StudioUnavailable } from '@/lib/cassette-server'
import { parsePlacement, LETTERING_POSITIONS, LETTERING_SIZES, type LetteringPosition, type LetteringSize } from '@/lib/cassette-studio'
import { isSceneId, MAX_CUSTOM_SETTING } from '@/lib/cassette-scenes'
import { CoverError, loadCoverProject, makeStudioCover, randomSceneId } from '@/lib/cassette-pipeline'

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
//   place_x      where the cassette's centre sits across the cover, 0.15–0.85  ┐ optional —
//   place_y      the surface line it stands on, 0.3–0.97 down the cover        │ any left out
//   place_scale  its width as a fraction of the cover, 0.2–0.8                 ┘ falls to the default
//
// Validates the request, then builds the cover through makeStudioCover
// (src/lib/cassette-pipeline.ts — what it writes and why is documented there;
// the theme route runs the same function). Only the AI scene path
// (preset/random/custom) counts against the monthly artwork allowance.
// Owner-only (404 otherwise) — see src/app/api/cassette-studio/route.ts.
export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!(await isAdminIdentity(userId))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const limit = await checkUserLimit(cassetteStudioLimiter, userId)
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded. Try again later.' }, { status: 429, headers: rateLimitHeaders(limit) })
  }

  const form = await request.formData().catch(() => null)
  if (!form) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  const str = (k: string) => { const v = form.get(k); return typeof v === 'string' ? v : '' }

  const projectId = canonicalUuid(str('project_id'))
  if (!projectId) return NextResponse.json({ error: 'Valid project_id is required' }, { status: 400 })
  const project = await loadCoverProject(userId, projectId)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  let scene = str('scene') || 'random'
  if (scene === 'random') scene = randomSceneId()
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
  const placement = parsePlacement(str('place_x'), str('place_y'), str('place_scale'))

  let background: Buffer | null = null
  if (scene === 'photo') {
    const photo = await readPhoto(form, 'background')
    if (typeof photo === 'string') return NextResponse.json({ error: photo }, { status: 400 })
    background = photo
  }

  try {
    const result = await makeStudioCover({
      userId, project, scene, setting, subjectPath, background, letteringPath, color, position, size,
      reflection: str('reflection') === '1', placement,
    })
    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof CoverError) return NextResponse.json({ error: err.message }, { status: err.status })
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[cassette-studio] render failed:', msg)
    if (err instanceof StudioUnavailable) {
      return NextResponse.json({ error: 'Scene generation is temporarily unavailable. You can still use your own background photo.' }, { status: 503 })
    }
    return NextResponse.json({ error: 'Could not make the cover. Please try again.' }, { status: 502 })
  }
}
