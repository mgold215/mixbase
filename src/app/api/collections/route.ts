import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'

// GET /api/collections — list all collections, newest-updated first
export async function GET() {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('mb_collections')
    .select('*')
    .order('updated_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

// POST /api/collections — create a new collection
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const { title, type } = body

  // Title is required
  if (!title?.trim()) {
    return NextResponse.json({ error: 'Title is required' }, { status: 400 })
  }

  // Type must be one of the allowed values
  const allowedTypes = ['playlist', 'ep', 'album']
  if (!type || !allowedTypes.includes(type)) {
    return NextResponse.json(
      { error: `Type must be one of: ${allowedTypes.join(', ')}` },
      { status: 400 }
    )
  }

  const { data, error } = await supabase
    .from('mb_collections')
    .insert({ title: title.trim(), type, user_id: user.id })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data, { status: 201 })
}
