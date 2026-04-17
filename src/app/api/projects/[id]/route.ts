import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// GET /api/projects/[id] — get one project with its versions and feedback counts
export async function GET(_req: NextRequest, ctx: RouteContext<'/api/projects/[id]'>) {
  const { id } = await ctx.params

  const [projectRes, versionsRes] = await Promise.all([
    supabaseAdmin.from('mb_projects').select('*').eq('id', id).single(),
    supabaseAdmin
      .from('mb_versions')
      .select('*, mb_feedback(count)')
      .eq('project_id', id)
      .order('version_number', { ascending: false }),
  ])

  if (projectRes.error) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json({
    project: projectRes.data,
    versions: versionsRes.data ?? [],
  })
}

// PATCH /api/projects/[id] — update project fields (whitelisted only)
export async function PATCH(request: NextRequest, ctx: RouteContext<'/api/projects/[id]'>) {
  const { id } = await ctx.params
  const body = await request.json()

  // Only allow updating these fields — prevents clients from overwriting arbitrary columns
  const allowed = ['title', 'genre', 'bpm', 'key_signature', 'artwork_url'] as const
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  for (const key of allowed) {
    if (key in body) patch[key] = body[key]
  }

  const { data, error } = await supabaseAdmin
    .from('mb_projects')
    .update(patch)
    .eq('id', id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

// DELETE /api/projects/[id]
export async function DELETE(_req: NextRequest, ctx: RouteContext<'/api/projects/[id]'>) {
  const { id } = await ctx.params

  const { error } = await supabaseAdmin.from('mb_projects').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
