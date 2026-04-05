import { NextRequest, NextResponse } from 'next/server'

// Disable body parsing — we stream the body straight through to Supabase
export const maxDuration = 300

const SUPABASE_TUS = `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://mdefkqaawrusoaojstpq.supabase.co'}/storage/v1/upload/resumable`

function serviceKey() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY not set')
  return key
}

// POST — create a new TUS upload session at Supabase using the service-role key.
// The service-role key bypasses Supabase's anon per-file size limit.
// We return a /api/tus/<uploadId> Location so subsequent PATCHes go through this proxy
// (each PATCH is one chunk ≤ 8 MB, well under Railway's 10 MB request body wall).
export async function POST(req: NextRequest) {
  const forwardHeaders: Record<string, string> = {
    Authorization: `Bearer ${serviceKey()}`,
    'Tus-Resumable': req.headers.get('tus-resumable') ?? '1.0.0',
    'x-upsert': 'true',
  }
  for (const h of ['upload-length', 'upload-metadata', 'upload-defer-length', 'content-type']) {
    const v = req.headers.get(h)
    if (v) forwardHeaders[h] = v
  }

  const upstream = await fetch(SUPABASE_TUS, {
    method: 'POST',
    headers: forwardHeaders,
    body: req.body ?? undefined,
    // @ts-expect-error Node 18+ streaming
    duplex: 'half',
  })

  if (!upstream.ok) {
    const text = await upstream.text()
    return new NextResponse(text, { status: upstream.status })
  }

  // Supabase returns: Location: https://…/storage/v1/upload/resumable/<uploadId>
  const supabaseLocation = upstream.headers.get('location') ?? ''
  const uploadId = supabaseLocation.split('/upload/resumable/').pop() ?? ''

  const res = new NextResponse(null, { status: 201 })
  res.headers.set('Location', `/api/tus/${uploadId}`)
  res.headers.set('Tus-Resumable', '1.0.0')
  const offset = upstream.headers.get('upload-offset')
  if (offset) res.headers.set('Upload-Offset', offset)
  return res
}
