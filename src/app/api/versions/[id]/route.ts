import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// PATCH /api/versions/[id] — update a version (status, notes, etc.)
export async function PATCH(request: NextRequest, ctx: RouteContext<'/api/versions/[id]'>) {
  const { id } = await ctx.params
  const body = await request.json()

  // Fetch old version to detect status change
  const { data: oldVersion } = await supabaseAdmin
    .from('mf_versions')
    .select('status, project_id, version_number')
    .eq('id', id)
    .single()

  const { data, error } = await supabaseAdmin
    .from('mf_versions')
    .update(body)
    .eq('id', id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Log status change activity
  if (body.status && oldVersion && body.status !== oldVersion.status) {
    await supabaseAdmin.from('mf_activity').insert({
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
    .from('mf_versions')
    .select('*, mf_feedback(*)')
    .eq('id', id)
    .single()

  if (error) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(data)
}

// DELETE /api/versions/[id]
export async function DELETE(_req: NextRequest, ctx: RouteContext<'/api/versions/[id]'>) {
  const { id } = await ctx.params
  const { error } = await supabaseAdmin.from('mf_versions').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
