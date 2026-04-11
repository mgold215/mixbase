import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// GET /api/projects — list all projects
export async function GET() {
  const { data, error } = await supabaseAdmin
    .from('mb_projects')
    .select('*')
    .order('updated_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

// POST /api/projects — create a new project
export async function POST(request: NextRequest) {
  const body = await request.json()
  const { title, genre, bpm, key_signature } = body

  if (!title?.trim()) {
    return NextResponse.json({ error: 'Title is required' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin
    .from('mb_projects')
    .insert({ title: title.trim(), genre, bpm, key_signature })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Log activity
  await supabaseAdmin.from('mb_activity').insert({
    type: 'project_created',
    project_id: data.id,
    description: `Project "${data.title}" created`,
  })

  return NextResponse.json(data, { status: 201 })
}
