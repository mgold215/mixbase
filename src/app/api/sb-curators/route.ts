import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import type { CuratorInsert } from '@/lib/submit'

// GET — the shared starter directory (user_id IS NULL) plus the user's own curators.
export async function GET(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await supabaseAdmin
    .from('sb_curators')
    .select('*')
    .or(`user_id.eq.${userId},user_id.is.null`)
    .order('name')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

// POST — add a single curator, or bulk-import via { rows: [...] } (CSV import).
export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()

  if (Array.isArray(body?.rows)) {
    const rows = (body.rows as CuratorInsert[])
      .filter((r) => r.name?.trim())
      .map((r) => ({ ...r, user_id: userId }))
    if (rows.length === 0) return NextResponse.json({ error: 'No valid rows' }, { status: 400 })
    const { data, error } = await supabaseAdmin.from('sb_curators').insert(rows).select()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ inserted: data?.length ?? 0 }, { status: 201 })
  }

  if (!body?.name?.trim()) return NextResponse.json({ error: 'Name is required' }, { status: 400 })
  const { data, error } = await supabaseAdmin
    .from('sb_curators')
    .insert({ ...body, user_id: userId })
    .select()
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data, { status: 201 })
}
