import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'

// PATCH /api/versions/[id] — update a version (status, notes, etc.)
export async function PATCH(request: NextRequest, ctx: RouteContext<'/api/versions/[id]'>) {
  const supabase = await createClient()
  const { id } = await ctx.params
  const body = await request.json()

  // Only allow updating these fields — prevents clients from overwriting arbitrary columns
  const allowed = ['status', 'label', 'private_notes', 'public_notes', 'change_log', 'allow_download'] as const
  const patch: Record<string, unknown> = {}
  for (const key of allowed) {
    if (key in body) patch[key] = body[key]
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
  }

  // Only pre-fetch the old version when we need to log a status change
  let oldVersion: { status: string; project_id: string; version_number: number } | null = null
  if (patch.status) {
    const { data } = await supabase
      .from('mb_versions')
      .select('status, project_id, version_number')
      .eq('id', id)
      .single()
    oldVersion = data
  }

  const { data, error } = await supabase
    .from('mb_versions')
    .update(patch)
    .eq('id', id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Log status change activity
  if (patch.status && oldVersion && patch.status !== oldVersion.status) {
    await supabase.from('mb_activity').insert({
      type: 'status_change',
      project_id: oldVersion.project_id,
      version_id: id,
      description: `v${oldVersion.version_number} moved from ${oldVersion.status} to ${patch.status}`,
    })
  }

  return NextResponse.json(data)
}

// GET /api/versions/[id] — get one version with its feedback
export async function GET(_req: NextRequest, ctx: RouteContext<'/api/versions/[id]'>) {
  const supabase = await createClient()
  const { id } = await ctx.params

  const { data, error } = await supabase
    .from('mb_versions')
    .select('*, mb_feedback(*)')
    .eq('id', id)
    .single()

  if (error) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(data)
}

// DELETE /api/versions/[id]
export async function DELETE(_req: NextRequest, ctx: RouteContext<'/api/versions/[id]'>) {
  const supabase = await createClient()
  const { id } = await ctx.params
  const { error } = await supabase.from('mb_versions').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
