import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { supabaseAdmin } from '@/lib/supabase'
import { isUuid, isSupabaseStorageUrl } from '@/lib/validators'
import { buildFinalized, isHexColor, DEFAULT_TEXT_COLOR, POSITIONS, FILTERS, type Position, type Size, type Filter } from '@/lib/finalize-render'

export const runtime = 'nodejs'
export const maxDuration = 60

// ── POST /api/finalize-artwork ──────────────────────────────────────────────
// Always renders against the immutable source (mb_projects.artwork_url) and
// writes the rendered output to mb_projects.finalized_artwork_url. The client
// only sends { project_id } — passing artwork_url from the browser would let
// stale finalized URLs feed back into the renderer.
export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  const { project_id, artist } = body
  if (!isUuid(project_id)) {
    return NextResponse.json({ error: 'Valid project_id is required' }, { status: 400 })
  }

  // Deterministic, user-chosen layout — no Vision guesswork.
  const position: Position = POSITIONS.includes(body.position) ? body.position : 'top-left'
  const size: Size = ['small', 'medium', 'large'].includes(body.size) ? body.size : 'medium'
  // Divider line on by default — omit only when the client explicitly says false.
  const showRule: boolean = body.showRule !== false
  const filter: Filter = FILTERS.includes(body.filter) ? body.filter : 'none'
  const color: string = isHexColor(body.color) ? body.color : DEFAULT_TEXT_COLOR

  const { data: project, error: projectError } = await supabaseAdmin
    .from('mb_projects')
    .select('artwork_url, title')
    .eq('id', project_id)
    .eq('user_id', userId)
    .single()

  if (projectError || !project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }
  if (!project.artwork_url) {
    return NextResponse.json({ error: 'Generate or upload artwork before finalizing' }, { status: 400 })
  }
  if (!project.title) {
    return NextResponse.json({ error: 'Project title is required to finalize' }, { status: 400 })
  }

  const supabase = await createClient()

  // SSRF guard: the source is fetched server-side, so refuse anything that isn't
  // a Supabase Storage URL (the only shape artwork_url legitimately takes).
  if (!isSupabaseStorageUrl(project.artwork_url)) {
    return NextResponse.json({ error: 'Artwork source is not a valid storage URL' }, { status: 400 })
  }

  const imageRes = await fetch(project.artwork_url)
  if (!imageRes.ok) return NextResponse.json({ error: 'Could not fetch artwork' }, { status: 400 })
  const imageBuffer = Buffer.from(await imageRes.arrayBuffer())

  const finalBuffer = await buildFinalized(
    imageBuffer, project.title, artist || 'moodmixformat', position, size, showRule, filter, color
  )

  const filename = `${project_id}/finalized-${Date.now()}.jpg`
  const { data: uploadData, error: uploadError } = await supabase.storage
    .from('mf-artwork')
    .upload(filename, finalBuffer, { contentType: 'image/jpeg', upsert: false })

  if (uploadError) {
    console.error('[finalize-artwork] Upload error:', uploadError.message)
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 })
  }

  const { data: urlData } = supabase.storage.from('mf-artwork').getPublicUrl(uploadData.path)
  const finalUrl = urlData.publicUrl

  const { error: dbError } = await supabaseAdmin
    .from('mb_projects')
    .update({ finalized_artwork_url: finalUrl, updated_at: new Date().toISOString() })
    .eq('id', project_id)
    .eq('user_id', userId) // defense-in-depth: scope the write to the owner
  if (dbError) {
    // The render uploaded fine but the URL didn't persist — surface it rather
    // than returning a success the next page load won't reflect.
    console.error('[finalize-artwork] DB update error:', dbError.message)
    return NextResponse.json({ error: 'Saved image but failed to update project. Please retry.' }, { status: 500 })
  }

  return NextResponse.json({ finalized_artwork_url: finalUrl, position, size, showRule, filter, color })
}
