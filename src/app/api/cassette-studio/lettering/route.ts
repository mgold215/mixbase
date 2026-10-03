import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { canonicalUuid } from '@/lib/validators'
import { cassetteStudioLimiter, checkUserLimit, rateLimitHeaders } from '@/lib/rate-limit'
import { readPhoto, studioPrefix, uploadStudio } from '@/lib/cassette-server'
import { extractHandwriting } from '@/lib/handwriting'

export const runtime = 'nodejs'
export const maxDuration = 60

// POST /api/cassette-studio/lettering   (multipart: photo, project_id)
//
// Lifts the artist's handwriting off a photo (src/lib/handwriting.ts) and
// saves it as this project's lettering: studio/<userId>/lettering-<projectId>-<ts>.png.
// No AI involved — every stroke in the result is the artist's own ink.
export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const limit = await checkUserLimit(cassetteStudioLimiter, userId)
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded. Try again later.' }, { status: 429, headers: rateLimitHeaders(limit) })
  }

  const form = await request.formData().catch(() => null)
  if (!form) return NextResponse.json({ error: 'Invalid upload' }, { status: 400 })
  // Canonical: the id becomes part of a storage key (see generate-artwork).
  const projectId = canonicalUuid(form.get('project_id'))
  if (!projectId) return NextResponse.json({ error: 'Valid project_id is required' }, { status: 400 })

  const { data: project } = await supabaseAdmin
    .from('mb_projects').select('id').eq('id', projectId).eq('user_id', userId).single()
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const photo = await readPhoto(form, 'photo')
  if (typeof photo === 'string') return NextResponse.json({ error: photo }, { status: 400 })

  let png: Buffer
  try {
    png = (await extractHandwriting(photo)).png
  } catch (err) {
    const msg = err instanceof Error && err.message.startsWith('No writing') ? err.message : 'Could not read that photo — try a JPEG or PNG.'
    return NextResponse.json({ error: msg }, { status: 400 })
  }

  const ts = Date.now()
  const path = `${studioPrefix(userId)}lettering-${projectId}-${ts}.png`
  try {
    const url = await uploadStudio(path, png, 'image/png')
    return NextResponse.json({ lettering: { path, url, createdAt: new Date(ts).toISOString() } })
  } catch (err) {
    console.error('[cassette-studio] lettering upload failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Could not save your lettering. Please try again.' }, { status: 500 })
  }
}
