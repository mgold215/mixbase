import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET() {
  const { data, error } = await supabaseAdmin
    .from('mf_releases')
    .select('*, mf_projects(title, artwork_url)')
    .order('release_date', { ascending: true, nullsFirst: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function POST(request: NextRequest) {
  const body = await request.json()
  const { title, release_date, project_id, genre, label, isrc, notes, final_version_id } = body

  if (!title?.trim()) return NextResponse.json({ error: 'Title is required' }, { status: 400 })

  const { data, error } = await supabaseAdmin
    .from('mf_releases')
    .insert({ title: title.trim(), release_date, project_id, genre, label, isrc, notes, final_version_id })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await supabaseAdmin.from('mf_activity').insert({
    type: 'release_created',
    project_id: project_id ?? null,
    release_id: data.id,
    description: `Release "${data.title}" added to pipeline`,
  })

  return NextResponse.json(data, { status: 201 })
}
