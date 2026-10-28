import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { canonicalUuid } from '@/lib/validators'
import { isAdminIdentity } from '@/lib/admin-identity'
import { cassetteStudioLimiter, checkUserLimit, rateLimitHeaders } from '@/lib/rate-limit'
import {
  glyphCoverage, isOwnStudioKey, listGlyphs, listStudio, loadSignature, readPhoto, removeStudio, uploadStudio, type GlyphFile,
} from '@/lib/cassette-server'
import { signatureKey } from '@/lib/cassette-studio'
import { glyphKey } from '@/lib/handwriting-glyphs'
import { readHandwritingSheet, SHEET_DIGITS, SHEET_LETTERS, titleForHandwriting } from '@/lib/handwriting-sheet'

export const runtime = 'nodejs'
export const maxDuration = 60

// Cassette Studio — what the one-click flow needs, and the one photo that
// sets up the handwriting.
//
// GET /api/cassette-studio/setup?project_id=<uuid>
// → { cassette: StudioFile | null,          the newest cut-out cassette (the one used)
//     signature: { url, source } | null,    the handwritten name ('saved' or recovered from a lettering photo)
//     letters: { known, total },            how many of A–Z 0–9 the handwriting knows
//     title: { text, missing } | null }     this song's title as it will be written, and any
//                                           letters the handwriting can't write yet
//
// POST /api/cassette-studio/setup   multipart { photo }
//   The handwriting sheet: your name on the first line, then A–Z and 0–9 in
//   capitals with a gap between each (src/lib/handwriting-sheet.ts). Nothing
//   to type — the letters are labelled by their order.
//   → { signature: { url }, added, letters: { known, total } }  or 422 { error, found, expected }
//
// Owner-only (404 otherwise), like every Cassette Studio route.

const SHEET = SHEET_LETTERS + SHEET_DIGITS

function knownCount(counts: Record<string, number>): number {
  let n = 0
  for (const c of SHEET) if ((counts[c] ?? 0) > 0 || (counts[c.toLowerCase()] ?? 0) > 0) n++
  return n
}

export async function GET(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!(await isAdminIdentity(userId))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const projectId = canonicalUuid(request.nextUrl.searchParams.get('project_id'))
  try {
    const [subjects, signature, glyphs, project] = await Promise.all([
      listStudio(userId, 'subject-'),
      loadSignature(userId),
      listGlyphs(userId),
      projectId
        ? supabaseAdmin.from('mb_projects').select('title').eq('id', projectId).eq('user_id', userId).maybeSingle().then(r => r.data as { title?: string | null } | null)
        : Promise.resolve(null),
    ])
    const cassette = subjects.find(f => isOwnStudioKey(f.path, userId, 'subject')) ?? null
    const counts = glyphCoverage(glyphs)
    let title: { text: string; missing: string[] } | null = null
    if (project) {
      const { text } = titleForHandwriting(project.title ?? '')
      const missing = [...new Set([...text].filter(c => c !== ' ' && c !== '\n' && !(counts[c] > 0) && !(counts[c.toLowerCase()] > 0) && !(counts[c.toUpperCase()] > 0)))]
      title = { text, missing }
    }
    return NextResponse.json({
      cassette: cassette ? { path: cassette.path, url: cassette.url, createdAt: cassette.createdAt } : null,
      signature: signature ? { url: signature.url, source: signature.source } : null,
      letters: { known: knownCount(counts), total: SHEET.length },
      title,
    })
  } catch (err) {
    console.error('[cassette-studio/setup] status failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Could not load your studio.' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!(await isAdminIdentity(userId))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const limit = await checkUserLimit(cassetteStudioLimiter, userId)
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded. Try again later.' }, { status: 429, headers: rateLimitHeaders(limit) })
  }
  const form = await request.formData().catch(() => null)
  if (!form) return NextResponse.json({ error: 'Invalid upload' }, { status: 400 })
  const photo = await readPhoto(form, 'photo')
  if (typeof photo === 'string') return NextResponse.json({ error: photo }, { status: 400 })

  let sheet: Awaited<ReturnType<typeof readHandwritingSheet>>
  try {
    sheet = await readHandwritingSheet(photo)
  } catch (err) {
    const msg = err instanceof Error && err.message.startsWith('No writing') ? err.message : 'Could not read that photo — try a JPEG or PNG.'
    return NextResponse.json({ error: msg }, { status: 400 })
  }
  if (!sheet.ok) return NextResponse.json({ error: sheet.error, found: sheet.found, expected: sheet.expected }, { status: 422 })

  const ts = Date.now()
  const written: string[] = []
  try {
    const sigPath = signatureKey(userId, ts)
    const sigUrl = await uploadStudio(sigPath, sheet.signature.png, 'image/png')
    written.push(sigPath)
    for (let i = 0; i < sheet.glyphs.length; i++) {
      const g = sheet.glyphs[i]
      const path = glyphKey(userId, g.char, g.unit, g.base, ts + i)
      await uploadStudio(path, g.png, 'image/png')
      written.push(path)
    }
    // The newest signature wins; older ones go so the folder never fills.
    const older = (await listStudio(userId, 'signature-')).filter(f => f.path !== sigPath && isOwnStudioKey(f.path, userId, 'signature'))
    await removeStudio(older.map(f => f.path))
    let glyphs: GlyphFile[] = []
    try { glyphs = await listGlyphs(userId) } catch { /* counts below fall back to this sheet */ }
    const counts = glyphCoverage(glyphs.length ? glyphs : sheet.glyphs.map(g => ({ char: g.char } as GlyphFile)))
    return NextResponse.json({ signature: { url: sigUrl }, added: sheet.glyphs.length, letters: { known: knownCount(counts), total: SHEET.length } })
  } catch (err) {
    console.error('[cassette-studio/setup] sheet save failed:', err instanceof Error ? err.message : err)
    await removeStudio(written)
    return NextResponse.json({ error: 'Could not save your handwriting. Please try again.' }, { status: 500 })
  }
}
