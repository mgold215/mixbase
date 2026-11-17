import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { isJsonObject, isUuid } from '@/lib/validators'
import { isAdminIdentity } from '@/lib/admin-identity'
import { ownsProject } from '@/lib/ownership'
import { checkUserLimit, mixCheckLimiter, rateLimitHeaders } from '@/lib/rate-limit'
import { GENRE_FAMILIES } from '@/lib/mix-check-findings.ts'
import { measureUrl } from '@/lib/mix-check-server'

// POST /api/mix-check/references — add a commercial track to a genre's
// reference set from a full-quality file (owner-only).
//
// The shared reference sets are measured from short streaming previews, which
// are good for tonal balance and nothing else. A track added here is measured
// from the whole file and then stands in for the preview of the same track.
//
// Body: { project_id, path, family, artist, title }
//   `path` is a file the client just uploaded through POST /api/upload-url into
//   one of the caller's own song folders: `<project_id>/mixref-<stamp>.<ext>`.
//
// ONLY THE MEASUREMENT IS KEPT. The file is deleted from Storage whether the
// measurement succeeds or not — mixBASE does not store other people's music.

export const dynamic = 'force-dynamic'

const REF_PATH_RE = /^([0-9a-f-]{36})\/mixref-\d{10,16}\.(wav|aif|aiff|flac|mp3|m4a)$/
const MAX_TEXT = 120

export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!(await isAdminIdentity(userId))) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body: unknown = await request.json().catch(() => null)
  if (!isJsonObject(body)) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  const { project_id, path, family } = body
  const artist = typeof body.artist === 'string' ? body.artist.trim().slice(0, MAX_TEXT) : ''
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, MAX_TEXT) : ''
  if (!artist || !title) return NextResponse.json({ error: 'artist and title are required' }, { status: 400 })
  if (typeof family !== 'string' || !GENRE_FAMILIES.some(f => f.key === family)) {
    return NextResponse.json({ error: 'Unknown genre family' }, { status: 400 })
  }
  const match = typeof path === 'string' ? REF_PATH_RE.exec(path) : null
  if (!isUuid(project_id) || !match || match[1] !== project_id) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 })
  }

  const rl = await checkUserLimit(mixCheckLimiter, userId)
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many checks — try again later' }, { status: 429, headers: rateLimitHeaders(rl) })
  }
  if (!(await ownsProject(project_id, userId))) {
    mixCheckLimiter.rollback(userId)
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const key = path as string
  const { data: pub } = supabaseAdmin.storage.from('mf-audio').getPublicUrl(key)
  try {
    const measured = await measureUrl(pub.publicUrl, 'full')
    // One row per artist + track + family for this user: a second upload of
    // the same track replaces the first.
    await supabaseAdmin
      .from('mb_mix_references')
      .delete()
      .eq('user_id', userId)
      .eq('family', family)
      .ilike('artist', artist.replace(/[%_]/g, m => `\\${m}`))
      .ilike('title', title.replace(/[%_]/g, m => `\\${m}`))
    const { error } = await supabaseAdmin
      .from('mb_mix_references')
      .insert({ user_id: userId, family, artist, title, source: 'full', summary: measured.summary })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ artist, title, family, source: 'full' }, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message || 'Could not measure that file' }, { status: 422 })
  } finally {
    await supabaseAdmin.storage.from('mf-audio').remove([key]).catch(() => {})
  }
}
