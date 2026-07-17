import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { isUuid, isSupabaseStorageUrl } from '@/lib/validators'
import { ensureProjectVisualizerColumn, isMissingVisualizerColumn } from '@/lib/schema-heal'

// GET /api/projects/[id] — get one project with its versions (must belong to the user)
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  if (!isUuid(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  const [projectRes, versionsRes] = await Promise.all([
    supabaseAdmin.from('mb_projects').select('*').eq('id', id).eq('user_id', userId).single(),
    supabaseAdmin
      .from('mb_versions')
      .select('*, mb_feedback(count)')
      .eq('project_id', id)
      .order('version_number', { ascending: false })
      .limit(500),
  ])

  if (projectRes.error) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json({
    project: projectRes.data,
    versions: versionsRes.data ?? [],
  })
}

// PATCH /api/projects/[id] — update project fields (owner only)
export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  if (!isUuid(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

  const allowed = ['title', 'genre', 'bpm', 'key_signature', 'artwork_url', 'visualizer_url', 'visualizer_wide_url'] as const
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  for (const key of allowed) {
    if (key in body) patch[key] = body[key]
  }

  // Replacing the source artwork invalidates any prior finalized render —
  // null it out so the next Finalize starts from the new source. The source is
  // fetched server-side by /api/finalize-artwork, so only accept a Supabase
  // Storage URL (its sole legitimate shape) or null to clear it.
  if ('artwork_url' in body) {
    if (body.artwork_url !== null && !isSupabaseStorageUrl(body.artwork_url)) {
      return NextResponse.json({ error: 'artwork_url must be a Supabase storage URL' }, { status: 400 })
    }
    patch.finalized_artwork_url = null
  }

  // The project visualizers (vertical + horizontal pins) are rendered as
  // <video> across the app, so only accept a video the user actually generated
  // (an mb_visualizers row they own — any of their projects, matching how
  // artwork can be reassigned), or null to clear a pin.
  for (const key of ['visualizer_url', 'visualizer_wide_url'] as const) {
    if (key in body && body[key] !== null) {
      if (typeof body[key] !== 'string') {
        return NextResponse.json({ error: `Invalid ${key}` }, { status: 400 })
      }
      // The lookup itself can fail transiently (connection reset, PostgREST
      // blip). That is NOT "unknown video" — swallowing the error here made a
      // freshly saved render un-pinnable with a misleading 400. Retry once,
      // then surface a 503 the client can retry, keeping 400 for the case
      // where the row is genuinely absent.
      let viz: { id: string } | null = null
      let lookupError: { message: string } | null = null
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await supabaseAdmin
          .from('mb_visualizers')
          .select('id')
          .eq('user_id', userId)
          .eq('video_url', body[key])
          .limit(1)
          .maybeSingle()
        viz = res.data
        lookupError = res.error
        if (!lookupError) break
      }
      if (lookupError) {
        console.error('[projects PATCH] visualizer lookup failed:', lookupError.message)
        return NextResponse.json({ error: 'Could not verify the visualizer video. Try again.' }, { status: 503 })
      }
      if (!viz) return NextResponse.json({ error: 'Unknown visualizer video' }, { status: 400 })
    }
  }

  // maybeSingle (not single) so updating a project the caller doesn't own — or
  // one that doesn't exist — matches 0 rows and returns data:null / error:null
  // instead of a PostgREST "no rows" error we'd otherwise surface as a 500.
  const runUpdate = () => supabaseAdmin
    .from('mb_projects')
    .update(patch)
    .eq('id', id)
    .eq('user_id', userId)
    .select()
    .maybeSingle()

  let { data, error } = await runUpdate()

  // Deploys can beat the 015/020 migrations to production — heal the columns and retry.
  if (error && ('visualizer_url' in patch || 'visualizer_wide_url' in patch)
    && isMissingVisualizerColumn(error) && await ensureProjectVisualizerColumn()) {
    ({ data, error } = await runUpdate())
  }

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  return NextResponse.json(data)
}

// DELETE /api/projects/[id] — owner only
export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  if (!isUuid(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  const { error } = await supabaseAdmin
    .from('mb_projects')
    .delete()
    .eq('id', id)
    .eq('user_id', userId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
