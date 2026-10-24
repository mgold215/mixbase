import { NextRequest, NextResponse } from 'next/server'
import { isJsonObject } from '@/lib/validators'
import { cassetteStudioLimiter, checkUserLimit, rateLimitHeaders } from '@/lib/rate-limit'
import { isAdminIdentity } from '@/lib/admin-identity'
import {
  downloadStudio, glyphCoverage as coverage, isOwnStudioKey, listGlyphs, readPhoto, removeStudio, uploadStudio, type GlyphFile,
} from '@/lib/cassette-server'
import { GLYPH_CHARS, glyphKey, isGlyphChar, parseGlyphKey, teachGlyphs } from '@/lib/handwriting-glyphs'

export const runtime = 'nodejs'
export const maxDuration = 60

// Cassette Studio — the handwriting glyph bank ("type in your own
// handwriting"). Samples live at studio/<userId>/glyph-<cp>-<unit>-<base>-<ts>.png
// (src/lib/handwriting-glyphs.ts explains the key; listing + loading in
// src/lib/cassette-server.ts). Owner-only (404 otherwise) — see
// src/app/api/cassette-studio/route.ts.

/** Longest text one teaching photo may be labelled with, and its most lines. */
const MAX_TEACH_CHARS = 160
const MAX_TEACH_LINES = 8

// GET /api/cassette-studio/glyphs
// → { glyphs: GlyphFile[] (newest first), counts: { [char]: n }, chars: GLYPH_CHARS }
export async function GET(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!(await isAdminIdentity(userId))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  try {
    const glyphs = await listGlyphs(userId)
    return NextResponse.json({ glyphs, counts: coverage(glyphs), chars: GLYPH_CHARS })
  } catch (err) {
    console.error('[cassette-studio/glyphs] list failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Could not load your handwriting.' }, { status: 500 })
  }
}

// POST /api/cassette-studio/glyphs
//   multipart { photo, text }                       a photo of separated letters + what it says
//   JSON      { lettering: "studio/<uid>/lettering-…png", text }
//                                                   one of the caller's existing letterings + what it says
// Lifts the ink (photo) or reads it (lettering), cuts it into letters, labels
// them from `text` line by line, and saves one sample per letter.
// → { added: GlyphFile[], counts }  or  400/422 { error, rows? } when the
//   letters and the text disagree (nothing is saved then — a wrong label
//   would be typed back out as the wrong letter).
export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!(await isAdminIdentity(userId))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const limit = await checkUserLimit(cassetteStudioLimiter, userId)
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded. Try again later.' }, { status: 429, headers: rateLimitHeaders(limit) })
  }

  let text = ''
  let source: { photo: Buffer } | { lettering: Buffer }
  if ((request.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) {
    const body = await request.json().catch(() => null)
    if (!isJsonObject(body)) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    text = typeof body.text === 'string' ? body.text : ''
    const key = body.lettering
    if (!isOwnStudioKey(key, userId, 'lettering')) return NextResponse.json({ error: 'Lettering not found' }, { status: 404 })
    try {
      source = { lettering: await downloadStudio(key) }
    } catch {
      return NextResponse.json({ error: 'Lettering not found' }, { status: 404 })
    }
  } else {
    const form = await request.formData().catch(() => null)
    if (!form) return NextResponse.json({ error: 'Invalid upload' }, { status: 400 })
    const t = form.get('text')
    text = typeof t === 'string' ? t : ''
    const photo = await readPhoto(form, 'photo')
    if (typeof photo === 'string') return NextResponse.json({ error: photo }, { status: 400 })
    source = { photo }
  }
  text = text.replace(/\r/g, '').slice(0, MAX_TEACH_CHARS)
  const lines = text.split('\n').filter(l => l.trim())
  if (lines.length === 0) return NextResponse.json({ error: 'Type what the writing says.' }, { status: 400 })
  if (lines.length > MAX_TEACH_LINES) return NextResponse.json({ error: `At most ${MAX_TEACH_LINES} lines per photo.` }, { status: 400 })
  const bad = [...text.replace(/[\s]/g, '')].filter(c => !isGlyphChar(c))
  if (bad.length) {
    return NextResponse.json({ error: `Can't teach ${[...new Set(bad)].map(c => `"${c}"`).join(', ')} — letters, digits and basic punctuation only.` }, { status: 400 })
  }

  let taught: Awaited<ReturnType<typeof teachGlyphs>>
  try {
    taught = await teachGlyphs(source, text)
  } catch (err) {
    const msg = err instanceof Error && err.message.startsWith('No writing') ? err.message : 'Could not read that photo — try a JPEG or PNG.'
    return NextResponse.json({ error: msg }, { status: 400 })
  }
  if (!taught.ok) return NextResponse.json({ error: taught.error, rows: taught.rows }, { status: 422 })

  const ts = Date.now()
  const added: GlyphFile[] = []
  try {
    // One stamp per glyph (ts + index) so two samples of the same letter from
    // one photo never collide on a key.
    for (let i = 0; i < taught.glyphs.length; i++) {
      const g = taught.glyphs[i]
      const path = glyphKey(userId, g.char, g.unit, g.base, ts + i)
      const url = await uploadStudio(path, g.png, 'image/png')
      added.push({ path, url, char: g.char, unit: g.unit, base: g.base, createdAt: new Date(ts + i).toISOString() })
    }
  } catch (err) {
    console.error('[cassette-studio/glyphs] upload failed:', err instanceof Error ? err.message : err)
    await removeStudio(added.map(a => a.path))
    return NextResponse.json({ error: 'Could not save your handwriting. Please try again.' }, { status: 500 })
  }
  let counts: Record<string, number>
  try {
    counts = coverage(await listGlyphs(userId))
  } catch {
    counts = coverage(added)
  }
  return NextResponse.json({ added, counts })
}

// DELETE /api/cassette-studio/glyphs?path=studio/<uid>/glyph-…png   one sample
// DELETE /api/cassette-studio/glyphs?char=a                          every sample of a letter
export async function DELETE(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!(await isAdminIdentity(userId))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const path = request.nextUrl.searchParams.get('path')
  const char = request.nextUrl.searchParams.get('char')
  if (path) {
    if (!parseGlyphKey(path, userId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    await removeStudio([path])
    return NextResponse.json({ ok: true, removed: 1 })
  }
  if (char && isGlyphChar(char)) {
    try {
      const mine = (await listGlyphs(userId)).filter(g => g.char === char).map(g => g.path)
      await removeStudio(mine)
      return NextResponse.json({ ok: true, removed: mine.length })
    } catch (err) {
      console.error('[cassette-studio/glyphs] delete failed:', err instanceof Error ? err.message : err)
      return NextResponse.json({ error: 'Could not remove that.' }, { status: 500 })
    }
  }
  return NextResponse.json({ error: 'Not found' }, { status: 404 })
}
