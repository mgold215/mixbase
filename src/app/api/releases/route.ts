import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { isUuid } from '@/lib/validators'
import { ownsProject, ownsVersion } from '@/lib/ownership'

export async function GET(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await supabaseAdmin
    .from('mb_releases')
    .select('*, mb_projects(title, artwork_url)')
    .eq('user_id', userId)
    .order('release_date', { ascending: true, nullsFirst: false })
    .limit(500)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const { title, release_date, project_id, genre, label, isrc, notes, final_version_id } = body

  if (!title?.trim()) return NextResponse.json({ error: 'Title is required' }, { status: 400 })

  // Both ids are optional, but when present they must be UUIDs this user owns.
  // GET reads releases back joined with mb_projects(title, artwork_url) via the
  // RLS-bypassing service client, so an unchecked project_id would let a user pull
  // another user's project title/artwork into their own pipeline (cross-user
  // disclosure / IDOR). final_version_id ownership flows through its parent project.
  if (project_id != null && (!isUuid(project_id) || !await ownsProject(project_id, userId))) {
    return NextResponse.json({ error: 'Invalid project_id' }, { status: 400 })
  }
  if (final_version_id != null && (!isUuid(final_version_id) || !await ownsVersion(final_version_id, userId))) {
    return NextResponse.json({ error: 'Invalid final_version_id' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin
    .from('mb_releases')
    .insert({ title: title.trim(), release_date, project_id, genre, label, isrc, notes, final_version_id, user_id: userId })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await supabaseAdmin.from('mb_activity').insert({
    type: 'release_created',
    project_id: project_id ?? null,
    release_id: data.id,
    user_id: userId,
    description: `Release "${data.title}" added to pipeline`,
  })

  return NextResponse.json(data, { status: 201 })
}
