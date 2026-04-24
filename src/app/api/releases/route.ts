import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'

export async function GET() {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('mb_releases')
    .select('*, mb_projects(title, artwork_url)')
    .order('release_date', { ascending: true, nullsFirst: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const { title, release_date, project_id, genre, label, isrc, notes, final_version_id } = body

  if (!title?.trim()) return NextResponse.json({ error: 'Title is required' }, { status: 400 })

  const { data, error } = await supabase
    .from('mb_releases')
    .insert({ title: title.trim(), release_date, project_id, genre, label, isrc, notes, final_version_id, user_id: user.id })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await supabase.from('mb_activity').insert({
    type: 'release_created',
    project_id: project_id ?? null,
    release_id: data.id,
    description: `Release "${data.title}" added to pipeline`,
    user_id: user.id,
  })

  return NextResponse.json(data, { status: 201 })
}
