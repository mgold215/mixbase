import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// GET /api/versions/[id] — get one version with its feedback (owner only)
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params

  const { data, error } = await supabaseAdmin
    .from('mb_versions')
    .select('*, mb_feedback(*), mb_projects!inner(user_id)')
    .eq('id', id)
    .eq('mb_projects.user_id', userId)
    .single()

  if (error) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(data)
}

// PATCH /api/versions/[id] — update a version (owner only, via project ownership)
export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  const body = await request.json()

  const allowed = ['status', 'label', 'private_notes', 'public_notes', 'change_log', 'allow_download'] as const
  const patch: Record<string, unknown> = {}
  for (const key of allowed) {
    if (key in body) patch[key] = body[key]
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
  }

  // Verify ownership through the parent project before mutating
  const { data: versionCheck } = await supabaseAdmin
    .from('mb_versions')
    .select('status, project_id, version_number, mb_projects!inner(user_id)')
    .eq('id', id)
    .eq('mb_projects.user_id', userId)
    .single()

  if (!versionCheck) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data, error } = await supabaseAdmin
    .from('mb_versions')
    .update(patch)
    .eq('id', id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  if (patch.status && patch.status !== versionCheck.status) {
    await supabaseAdmin.from('mb_activity').insert({
      type: 'status_change',
      user_id: userId,
      project_id: versionCheck.project_id,
      version_id: id,
      description: `v${versionCheck.version_number} moved from ${versionCheck.status} to ${patch.status}`,
    })
  }

  return NextResponse.json(data)
}

// DELETE /api/versions/[id] — owner only
export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params

  // Verify ownership through parent project
  const { data: v } = await supabaseAdmin
    .from('mb_versions')
    .select('id, mb_projects!inner(user_id)')
    .eq('id', id)
    .eq('mb_projects.user_id', userId)
    .single()

  if (!v) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { error } = await supabaseAdmin.from('mb_versions').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
