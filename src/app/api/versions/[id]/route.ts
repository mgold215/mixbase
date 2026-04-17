import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// PATCH /api/versions/[id] — update a version (status, notes, etc.)
export async function PATCH(request: NextRequest, ctx: RouteContext<'/api/versions/[id]'>) {
  const { id } = await ctx.params
  const body = await request.json()

  // Fetch old version to detect status change
  const { data: oldVersion } = await supabaseAdmin
    .from('mb_versions')
    .select('status, project_id, version_number')
    .eq('id', id)
    .single()

  // Only allow updating these fields — prevents clients from overwriting arbitrary columns
  const allowed = ['status', 'label', 'private_notes', 'public_notes', 'change_log', 'allow_download'] as const
  const patch: Record<string, unknown> = {}
  for (const key of allowed) {
    if (key in body) patch[key] = body[key]
  }

  const { data, error } = await supabaseAdmin
    .from('mb_versions')
    .update(patch)
    .eq('id', id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Log status change activity
  if (body.status && oldVersion && body.status !== oldVersion.status) {
    await supabaseAdmin.from('mb_activity').insert({
      type: 'status_change',
      project_id: oldVersion.project_id,
      version_id: id,
      description: `v${oldVersion.version_number} moved from ${oldVersion.status} to ${body.status}`,
    })
  }

  return NextResponse.json(data)
}

// GET /api/versions/[id] — get one version with its feedback
export async function GET(_req: NextRequest, ctx: RouteContext<'/api/versions/[id]'>) {
  const { id } = await ctx.params

  const { data, error } = await supabaseAdmin
    .from('mb_versions')
    .select('*, mb_feedback(*)')
    .eq('id', id)
    .single()

  if (error) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(data)
}

// DELETE /api/versions/[id]
export async function DELETE(_req: NextRequest, ctx: RouteContext<'/api/versions/[id]'>) {
  const { id } = await ctx.params
  const { error } = await supabaseAdmin.from('mb_versions').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
