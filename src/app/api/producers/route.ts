import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// GET /api/producers?handle=xxx
export async function GET(req: NextRequest) {
  const handle = req.nextUrl.searchParams.get('handle')
  if (!handle) return NextResponse.json({ error: 'handle required' }, { status: 400 })

  const { data } = await supabaseAdmin
    .from('mf_producers')
    .select('id, handle, credits, created_at')
    .eq('handle', handle)
    .single()

  return NextResponse.json(data ?? null)
}

// POST /api/producers — create or fetch producer handle
export async function POST(req: NextRequest) {
  const { handle } = await req.json()
  if (!handle?.trim()) return NextResponse.json({ error: 'handle required' }, { status: 400 })

  const clean = handle.trim().toLowerCase().replace(/[^a-z0-9_]/g, '')
  if (clean.length < 2) return NextResponse.json({ error: 'Handle too short' }, { status: 400 })

  // Upsert — returns existing if handle taken
  const { data: existing } = await supabaseAdmin
    .from('mf_producers')
    .select('*')
    .eq('handle', clean)
    .single()

  if (existing) return NextResponse.json({ error: 'Handle already taken' }, { status: 409 })

  const { data, error } = await supabaseAdmin
    .from('mf_producers')
    .insert({ handle: clean, credits: 3 })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data, { status: 201 })
}
