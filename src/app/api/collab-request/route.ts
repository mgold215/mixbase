import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// POST /api/collab-request — send a collab request on a version
export async function POST(req: NextRequest) {
  const { version_id, producer_handle, message } = await req.json()

  if (!version_id || !producer_handle) {
    return NextResponse.json({ error: 'version_id and producer_handle required' }, { status: 400 })
  }

  // Verify producer exists
  const { data: producer } = await supabaseAdmin
    .from('mf_producers')
    .select('id')
    .eq('handle', producer_handle)
    .single()

  if (!producer) return NextResponse.json({ error: 'Unknown producer handle' }, { status: 404 })

  // Prevent duplicate requests from same producer on same version
  const { data: existing } = await supabaseAdmin
    .from('mf_collab_requests')
    .select('id')
    .eq('version_id', version_id)
    .eq('producer_handle', producer_handle)
    .single()

  if (existing) return NextResponse.json({ error: 'You already sent a collab request for this track' }, { status: 409 })

  const { data, error } = await supabaseAdmin
    .from('mf_collab_requests')
    .insert({ version_id, producer_handle, message: message?.trim() ?? null })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json(data, { status: 201 })
}

// GET /api/collab-request?version_id=... — list requests for a version
export async function GET(req: NextRequest) {
  const version_id = req.nextUrl.searchParams.get('version_id')
  if (!version_id) return NextResponse.json({ error: 'version_id required' }, { status: 400 })

  const { data, error } = await supabaseAdmin
    .from('mf_collab_requests')
    .select('*')
    .eq('version_id', version_id)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}
