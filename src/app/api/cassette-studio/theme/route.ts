import { NextRequest, NextResponse } from 'next/server'
import { canonicalUuid, isJsonObject } from '@/lib/validators'
import { isAdminIdentity } from '@/lib/admin-identity'
import { cassetteStudioLimiter, checkUserLimit, rateLimitHeaders } from '@/lib/rate-limit'
import { isOwnStudioKey, listStudio, loadTheme, removeStudio, uploadStudio } from '@/lib/cassette-server'
import { parsePlacement, LETTERING_POSITIONS, LETTERING_SIZES, type LetteringPosition, type LetteringSize } from '@/lib/cassette-studio'
import {
  THEME_ALIGNS, THEME_FORMATS, THEME_LETTERING_MODES, parseThemeKey, themeKey, themeToJson,
  type StudioTheme, type ThemeAlign, type ThemeFormat, type ThemeLetteringMode,
} from '@/lib/cassette-theme'
import { loadCoverProject, resolveCoverBase } from '@/lib/cassette-pipeline'
import { normalizeFilter, type FilterSettings } from '@/lib/cover-filters'
import sharp from 'sharp'

export const runtime = 'nodejs'

// Cassette Studio — the owner's THEME (src/lib/cassette-theme.ts): the one
// recipe every release is rendered in. Stored as a 1×1 PNG whose key holds
// the recipe, in the owner's studio folder; the newest wins (loadTheme in
// cassette-server.ts) and saving replaces the older ones. Owner-only (404
// otherwise) — see src/app/api/cassette-studio/route.ts.

// GET /api/cassette-studio/theme → { theme: ThemeJson | null }
export async function GET(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!(await isAdminIdentity(userId))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  try {
    const found = await loadTheme(userId)
    return NextResponse.json({ theme: found ? themeToJson(userId, found.theme) : null })
  } catch (err) {
    console.error('[cassette-studio/theme] load failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Could not load your theme.' }, { status: 500 })
  }
}

// POST /api/cassette-studio/theme   JSON
//   subject        studio/<uid>/subject-<ts>.png — the cassette every release uses
//   place_x/y/scale  optional, as /render takes them (left out = the default framing)
//   lettering      'title' | 'artist-title' | 'existing' | 'none'
//   align          'left' | 'center' | 'right'
//   color          '#rrggbb' | 'auto';  position / size  as /render
//   filter         FilterSettings to finish every cover with, or null;
//                  OR project_id — take the look that song's cover carries now
//   formats        clips to render after each cover: subset of canvas/square/youtube/story
//   clip_title     whether those clips carry the handwritten title
// → { theme: ThemeJson }
export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!(await isAdminIdentity(userId))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const limit = await checkUserLimit(cassetteStudioLimiter, userId)
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded. Try again later.' }, { status: 429, headers: rateLimitHeaders(limit) })
  }
  const body = await request.json().catch(() => null)
  if (!isJsonObject(body)) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

  const subject = body.subject
  if (!isOwnStudioKey(subject, userId, 'subject')) return NextResponse.json({ error: 'Pick the cassette your theme uses first.' }, { status: 400 })
  const subjectTs = /subject-(\d{10,16})\.png$/.exec(subject)![1]
  const placement = parsePlacement(body.place_x, body.place_y, body.place_scale)
  const lettering = (THEME_LETTERING_MODES as readonly string[]).includes(body.lettering as string) ? body.lettering as ThemeLetteringMode : 'title'
  const align = (THEME_ALIGNS as readonly string[]).includes(body.align as string) ? body.align as ThemeAlign : 'center'
  const color = typeof body.color === 'string' && /^#[0-9a-f]{6}$/i.test(body.color) ? body.color : 'auto'
  const position = (LETTERING_POSITIONS as readonly string[]).includes(body.position as string) ? body.position as LetteringPosition : 'bottom-left'
  const size = (LETTERING_SIZES as readonly string[]).includes(body.size as string) ? body.size as LetteringSize : 'medium'
  const formats: ThemeFormat[] = Array.isArray(body.formats)
    ? body.formats.filter((f): f is ThemeFormat => (THEME_FORMATS as readonly string[]).includes(f as string))
    : []
  const clipTitle = body.clip_title !== false

  let filter: FilterSettings | null = null
  if (body.filter !== undefined && body.filter !== null) {
    filter = normalizeFilter(body.filter)
    if (!filter) return NextResponse.json({ error: 'Those filter settings are not valid.' }, { status: 400 })
  } else {
    const projectId = canonicalUuid(body.project_id)
    if (projectId) {
      const project = await loadCoverProject(userId, projectId)
      if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
      try {
        filter = (await resolveCoverBase(project)).current
      } catch (err) {
        console.error('[cassette-studio/theme] look lookup failed:', err instanceof Error ? err.message : err)
        return NextResponse.json({ error: "Could not read this song's look. Please try again." }, { status: 502 })
      }
    }
  }

  const ts = Date.now()
  const theme: Omit<StudioTheme, 'ts'> = {
    subjectTs, placement: { x: placement.x ?? null, y: placement.y ?? null, scale: placement.scale ?? null },
    lettering, align, color, position, size, filter, formats, clipTitle,
  }
  try {
    const path = themeKey(userId, theme, ts)
    const dot = await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer()
    await uploadStudio(path, dot, 'image/png')
    // The newest theme wins; older ones are removed so the folder never fills.
    const older = (await listStudio(userId, 'theme-')).filter(f => f.path !== path && parseThemeKey(f.path, userId))
    await removeStudio(older.map(f => f.path))
    return NextResponse.json({ theme: themeToJson(userId, { ...theme, ts: String(ts) }) })
  } catch (err) {
    console.error('[cassette-studio/theme] save failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Could not save your theme. Please try again.' }, { status: 500 })
  }
}

// DELETE /api/cassette-studio/theme → { ok: true }
export async function DELETE(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!(await isAdminIdentity(userId))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  try {
    const mine = (await listStudio(userId, 'theme-')).filter(f => parseThemeKey(f.path, userId))
    await removeStudio(mine.map(f => f.path))
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[cassette-studio/theme] delete failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Could not remove your theme.' }, { status: 500 })
  }
}
