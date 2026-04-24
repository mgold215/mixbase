import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'

// GET /api/media — list all artwork images across all projects
export async function GET() {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('mb_projects')
    .select('id, title, artwork_url')
    .not('artwork_url', 'is', null)
    .order('updated_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}
