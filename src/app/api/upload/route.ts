import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, SUPABASE_URL } from '@/lib/supabase'

export const maxDuration = 300 // 5 minutes — large WAV/AIFF files need time

// POST /api/upload — streams directly to Supabase Storage using service role key.
// Previously used req.arrayBuffer() which loaded the entire file into RAM, causing
// truncation for large files when memory/proxy limits were hit. Streaming avoids this.
export async function POST(req: NextRequest) {
  const filename = req.headers.get('x-filename')
  const contentType = req.headers.get('x-content-type') ?? 'application/octet-stream'

  if (!filename) return NextResponse.json({ error: 'x-filename header required' }, { status: 400 })

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceKey) return NextResponse.json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' }, { status: 500 })

  // Stream the request body directly to Supabase Storage REST API.
  // This avoids buffering the file in memory — critical for large audio files.
  const storageUrl = `${SUPABASE_URL}/storage/v1/object/mf-audio/${filename}`

  const upstream = await fetch(storageUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': contentType,
      'x-upsert': 'true',
    },
    body: req.body,
    // @ts-expect-error — Node 18+ requires duplex: 'half' when body is a stream
    duplex: 'half',
  })

  if (!upstream.ok) {
    const err = await upstream.text()
    return NextResponse.json({ error: `Storage error: ${err}` }, { status: upstream.status })
  }

  const { data } = supabaseAdmin.storage.from('mf-audio').getPublicUrl(filename)
  return NextResponse.json({ audioUrl: data.publicUrl })
}
