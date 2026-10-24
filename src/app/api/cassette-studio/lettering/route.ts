import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { canonicalUuid, isJsonObject } from '@/lib/validators'
import { cassetteStudioLimiter, checkUserLimit, rateLimitHeaders } from '@/lib/rate-limit'
import { isAdminIdentity } from '@/lib/admin-identity'
import { loadGlyphBank, readPhoto, studioPrefix, uploadStudio } from '@/lib/cassette-server'
import { extractHandwriting } from '@/lib/handwriting'
import { composeHandwriting, MAX_TYPED_CHARS, MAX_TYPED_LINES, textLines, type ComposeAlign } from '@/lib/handwriting-glyphs'

export const runtime = 'nodejs'
export const maxDuration = 60

// POST /api/cassette-studio/lettering
//   multipart { photo, project_id }               lift the handwriting off a photo
//   JSON      { project_id, text, align? }        set `text` from the glyph bank
//                                                 (/api/cassette-studio/glyphs) —
//                                                 "type in my handwriting"
//
// Either way the result is this project's lettering:
// studio/<userId>/lettering-<projectId>-<ts>.png, white RGB + ink alpha,
// consumed by /render exactly like a photographed one. No AI and no font:
// a typed title is laid out from letters the artist actually wrote
// (src/lib/handwriting-glyphs.ts). A character the bank has no sample of is
// reported (400 + `missing`), never invented.
// Owner-only (404 otherwise) — see src/app/api/cassette-studio/route.ts.
export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!(await isAdminIdentity(userId))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const limit = await checkUserLimit(cassetteStudioLimiter, userId)
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded. Try again later.' }, { status: 429, headers: rateLimitHeaders(limit) })
  }

  const isJson = (request.headers.get('content-type') ?? '').toLowerCase().includes('application/json')
  let projectId: string | null
  let typed: { text: string; align: ComposeAlign } | null = null
  let form: FormData | null = null
  if (isJson) {
    const body = await request.json().catch(() => null)
    if (!isJsonObject(body)) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    projectId = canonicalUuid(body.project_id)
    const text = typeof body.text === 'string' ? body.text.replace(/\r/g, '').slice(0, MAX_TYPED_CHARS + 20) : ''
    const lines = textLines(text)
    if (lines.length === 0) return NextResponse.json({ error: 'Type a title first.' }, { status: 400 })
    if (lines.length > MAX_TYPED_LINES) return NextResponse.json({ error: `At most ${MAX_TYPED_LINES} lines.` }, { status: 400 })
    if (lines.join('\n').length > MAX_TYPED_CHARS) return NextResponse.json({ error: `At most ${MAX_TYPED_CHARS} characters.` }, { status: 400 })
    const align = body.align === 'left' || body.align === 'right' ? body.align : 'center'
    typed = { text: lines.join('\n'), align }
  } else {
    form = await request.formData().catch(() => null)
    if (!form) return NextResponse.json({ error: 'Invalid upload' }, { status: 400 })
    // Canonical: the id becomes part of a storage key (see generate-artwork).
    projectId = canonicalUuid(form.get('project_id'))
  }
  if (!projectId) return NextResponse.json({ error: 'Valid project_id is required' }, { status: 400 })

  const { data: project } = await supabaseAdmin
    .from('mb_projects').select('id').eq('id', projectId).eq('user_id', userId).single()
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  let png: Buffer
  if (typed) {
    let bank: Awaited<ReturnType<typeof loadGlyphBank>>
    try {
      bank = await loadGlyphBank(userId, typed.text)
    } catch (err) {
      console.error('[cassette-studio] glyph bank load failed:', err instanceof Error ? err.message : err)
      return NextResponse.json({ error: 'Could not load your handwriting. Please try again.' }, { status: 500 })
    }
    const seed = (Math.random() * 2147483647) >>> 0
    const out = await composeHandwriting(typed.text, bank, { align: typed.align, seed })
    if (!out.ok) {
      const list = out.missing.map(c => (c === ' ' ? 'space' : c)).join(' ')
      return NextResponse.json(
        { error: bank.length === 0 ? 'Teach me your handwriting first (a photo of your letters, and what it says).' : `No sample of ${list} yet — teach those letters first.`, missing: out.missing },
        { status: 400 },
      )
    }
    png = out.lettering.png
  } else {
    const photo = await readPhoto(form!, 'photo')
    if (typeof photo === 'string') return NextResponse.json({ error: photo }, { status: 400 })
    try {
      png = (await extractHandwriting(photo)).png
    } catch (err) {
      const msg = err instanceof Error && err.message.startsWith('No writing') ? err.message : 'Could not read that photo — try a JPEG or PNG.'
      return NextResponse.json({ error: msg }, { status: 400 })
    }
  }

  const ts = Date.now()
  const path = `${studioPrefix(userId)}lettering-${projectId}-${ts}.png`
  try {
    const url = await uploadStudio(path, png, 'image/png')
    return NextResponse.json({ lettering: { path, url, createdAt: new Date(ts).toISOString() }, typed: typed !== null })
  } catch (err) {
    console.error('[cassette-studio] lettering upload failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Could not save your lettering. Please try again.' }, { status: 500 })
  }
}
