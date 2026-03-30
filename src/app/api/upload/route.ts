import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, SUPABASE_URL } from '@/lib/supabase'

export const maxDuration = 120

// POST /api/upload — proxy file upload to Supabase using service role key
// Bypasses the anon key 50MB gateway limit
export async function POST(req: NextRequest) {
  const filename = req.headers.get('x-filename')
  const contentType = req.headers.get('x-content-type') ?? 'application/octet-stream'

  if (!filename) return NextResponse.json({ error: 'x-filename header required' }, { status: 400 })

  const buffer = await req.arrayBuffer()

  const { error } = await supabaseAdmin.storage
    .from('mf-audio')
    .upload(filename, Buffer.from(buffer), { contentType, upsert: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const { data } = supabaseAdmin.storage.from('mf-audio').getPublicUrl(filename)
  return NextResponse.json({ audioUrl: data.publicUrl })
}
