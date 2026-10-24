import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { canonicalUuid, isJsonObject } from '@/lib/validators'
import { isAdminIdentity } from '@/lib/admin-identity'
import { cassetteStudioLimiter, checkUserLimit, rateLimitHeaders } from '@/lib/rate-limit'
import {
  findStudioObject, isOwnStudioKey, listStudio, loadGlyphBank, loadTheme, studioPrefix, uploadStudio, StudioUnavailable,
} from '@/lib/cassette-server'
import { isSceneId } from '@/lib/cassette-scenes'
import { themeLetteringText, themeToJson } from '@/lib/cassette-theme'
import { composeHandwriting, isGlyphChar, MAX_TYPED_CHARS } from '@/lib/handwriting-glyphs'
import { CoverError, loadCoverProject, makeStudioCover, randomSceneId, saveLookOnProject } from '@/lib/cassette-pipeline'

export const runtime = 'nodejs'
export const maxDuration = 180

// POST /api/cassette-studio/theme/apply   JSON { project_id, scene? }
//
// One tap: render THIS song in the owner's theme (src/lib/cassette-theme.ts).
//   1. lettering — the song's title (or artist + title) typed from the glyph
//      bank in the theme's alignment, or the song's own newest photographed
//      lettering, or none; saved as this project's lettering like any other
//   2. cover — the theme's cassette, framing, ink colour/position/size, in
//      `scene` (a preset id, or 'random' / left out: a fresh scene each time —
//      the one thing that changes from release to release)
//   3. look — the theme's filter on the new cover
// Same pipeline as /render + /filter (src/lib/cassette-pipeline.ts). The
// theme's clips are then rendered and pinned by the client through
// /api/cassette-studio/motion and PATCH /api/projects/[id]; this response says
// which (formats, clip_title), so the client follows the theme, not its own idea.
//
// → { artwork_url, finalized_artwork_url, scene_label, lettering, formats, clip_title, look_applied, look_error? }
// A letter the bank cannot type is a 400 naming it — the theme never guesses
// a letter. The AI scene counts against the monthly artwork allowance exactly
// as /render does. Owner-only (404 otherwise).
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
  const projectId = canonicalUuid(body.project_id)
  if (!projectId) return NextResponse.json({ error: 'Valid project_id is required' }, { status: 400 })
  let scene = typeof body.scene === 'string' && body.scene ? body.scene : 'random'
  if (scene === 'random') scene = randomSceneId()
  if (!isSceneId(scene)) return NextResponse.json({ error: 'Unknown scene' }, { status: 400 })

  let found: Awaited<ReturnType<typeof loadTheme>>
  try {
    found = await loadTheme(userId)
  } catch (err) {
    console.error('[cassette-studio/theme] load failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Could not load your theme.' }, { status: 500 })
  }
  if (!found) return NextResponse.json({ error: 'Save a theme first.' }, { status: 400 })
  const { theme } = found
  const subjectPath = `${studioPrefix(userId)}subject-${theme.subjectTs}.png`
  if (!isOwnStudioKey(subjectPath, userId, 'subject') || !(await findStudioObject(subjectPath))) {
    return NextResponse.json({ error: "The cassette your theme uses is gone — save the theme again with another one." }, { status: 400 })
  }

  const { data: row } = await supabaseAdmin.from('mb_projects').select('id, title').eq('id', projectId).eq('user_id', userId).single()
  if (!row) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  const project = await loadCoverProject(userId, projectId)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  // ── 1. Lettering ──────────────────────────────────────────────────────────
  let letteringPath = ''
  let letteringFile: { path: string; url: string; createdAt: string | null } | null = null
  if (theme.lettering === 'title' || theme.lettering === 'artist-title') {
    let artist = ''
    if (theme.lettering === 'artist-title') {
      const { data: profile } = await supabaseAdmin.from('profiles').select('artist_name, display_name').eq('id', userId).maybeSingle()
      const p = profile as { artist_name?: string | null; display_name?: string | null } | null
      artist = p?.artist_name?.trim() || p?.display_name?.trim() || ''
    }
    const text = themeLetteringText(theme.lettering, (row as { title?: string | null }).title ?? '', artist)
    if (!text) return NextResponse.json({ error: 'Give the song a title first.' }, { status: 400 })
    const untypable = [...new Set([...text].filter(c => c !== ' ' && c !== '\n' && !isGlyphChar(c)))]
    if (untypable.length) {
      return NextResponse.json({ error: `The title has characters that can't be written in your hand (${untypable.join(' ')}). Rename the song, or set the theme to use each song's own handwriting.` }, { status: 400 })
    }
    if (text.replace(/\n/g, '').length > MAX_TYPED_CHARS) return NextResponse.json({ error: `The title is too long to letter (at most ${MAX_TYPED_CHARS} characters).` }, { status: 400 })
    try {
      const bank = await loadGlyphBank(userId, text)
      const out = await composeHandwriting(text, bank, { align: theme.align, seed: (Math.random() * 2147483647) >>> 0 })
      if (!out.ok) {
        return NextResponse.json(
          { error: bank.length === 0 ? 'Teach me your handwriting first (a photo of your letters, and what it says).' : `No sample of ${out.missing.join(' ')} yet — teach those letters first.`, missing: out.missing },
          { status: 400 },
        )
      }
      const ts = Date.now()
      letteringPath = `${studioPrefix(userId)}lettering-${projectId}-${ts}.png`
      const url = await uploadStudio(letteringPath, out.lettering.png, 'image/png')
      letteringFile = { path: letteringPath, url, createdAt: new Date(ts).toISOString() }
    } catch (err) {
      console.error('[cassette-studio/theme] lettering failed:', err instanceof Error ? err.message : err)
      return NextResponse.json({ error: 'Could not letter the title. Please try again.' }, { status: 502 })
    }
  } else if (theme.lettering === 'existing') {
    try {
      const mine = (await listStudio(userId, `lettering-${projectId}-`)).filter(f => isOwnStudioKey(f.path, userId, 'lettering'))
      if (mine[0]) { letteringPath = mine[0].path; letteringFile = mine[0] }
    } catch (err) {
      console.error('[cassette-studio/theme] lettering listing failed:', err instanceof Error ? err.message : err)
    }
  }

  // ── 2. Cover ──────────────────────────────────────────────────────────────
  let cover: Awaited<ReturnType<typeof makeStudioCover>>
  try {
    cover = await makeStudioCover({
      userId, project, scene, setting: '', subjectPath, background: null, letteringPath,
      color: theme.color, position: theme.position, size: theme.size, reflection: false,
      placement: { x: theme.placement.x ?? undefined, y: theme.placement.y ?? undefined, scale: theme.placement.scale ?? undefined },
    })
  } catch (err) {
    if (err instanceof CoverError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[cassette-studio/theme] cover failed:', err instanceof Error ? err.message : err)
    if (err instanceof StudioUnavailable) return NextResponse.json({ error: 'Scene generation is temporarily unavailable.' }, { status: 503 })
    return NextResponse.json({ error: 'Could not make the cover. Please try again.' }, { status: 502 })
  }

  // ── 3. Look ───────────────────────────────────────────────────────────────
  // The cover is already applied; a look that fails leaves it plain and says so.
  let finalizedUrl = cover.finalized_artwork_url
  let lookApplied = false
  let lookError: string | null = null
  if (theme.filter) {
    try {
      const fresh = await loadCoverProject(userId, projectId)
      if (!fresh) throw new Error('project vanished')
      const saved = await saveLookOnProject(userId, fresh, theme.filter)
      finalizedUrl = saved.finalized_artwork_url
      lookApplied = true
    } catch (err) {
      console.error('[cassette-studio/theme] look failed:', err instanceof Error ? err.message : err)
      lookError = "Your theme's look could not be added this time; the cover is saved without it."
    }
  }

  return NextResponse.json({
    artwork_url: cover.artwork_url,
    finalized_artwork_url: finalizedUrl,
    scene: cover.scene,
    scene_label: cover.scene_label,
    lettering: letteringFile,
    formats: theme.formats,
    clip_title: theme.clipTitle,
    look_applied: lookApplied,
    look_error: lookError,
    theme: themeToJson(userId, theme),
  })
}
