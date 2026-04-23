import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// GET /api/projects/[id] — get one project with its versions (must belong to the user)
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params

  const [projectRes, versionsRes] = await Promise.all([
    supabaseAdmin.from('mb_projects').select('*').eq('id', id).eq('user_id', userId).single(),
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

// PATCH /api/projects/[id] — update project fields (owner only)
export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  const body = await request.json()

  const allowed = ['title', 'genre', 'bpm', 'key_signature', 'artwork_url'] as const
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  for (const key of allowed) {
    if (key in body) patch[key] = body[key]
  }

  const { data, error } = await supabaseAdmin
    .from('mb_projects')
    .update(patch)
    .eq('id', id)
    .eq('user_id', userId)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

// DELETE /api/projects/[id] — owner only
export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params

  const { error } = await supabaseAdmin
    .from('mb_projects')
    .delete()
    .eq('id', id)
    .eq('user_id', userId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
