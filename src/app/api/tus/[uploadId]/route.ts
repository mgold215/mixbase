import { NextRequest, NextResponse } from 'next/server'

export const maxDuration = 300

const SUPABASE_TUS_BASE = `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://mdefkqaawrusoaojstpq.supabase.co'}/storage/v1/upload/resumable`

function serviceKey() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY not set')
  return key
}

type Ctx = { params: Promise<{ uploadId: string }> }

// PATCH — forward one chunk to Supabase TUS using the service-role key.
// tus-js-client sends chunks of chunkSize (8 MB), each as a separate PATCH request.
// Railway allows each 8 MB request through; stitching happens at Supabase.
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const userId = req.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { uploadId } = await ctx.params
  const url = `${SUPABASE_TUS_BASE}/${uploadId}`

  const forwardHeaders: Record<string, string> = {
    Authorization: `Bearer ${serviceKey()}`,
    'Tus-Resumable': req.headers.get('tus-resumable') ?? '1.0.0',
    'Content-Type': req.headers.get('content-type') ?? 'application/offset+octet-stream',
  }
  const offset = req.headers.get('upload-offset')
  if (offset) forwardHeaders['Upload-Offset'] = offset

  const upstream = await fetch(url, {
    method: 'PATCH',
    headers: forwardHeaders,
    body: req.body ?? undefined,
    // @ts-expect-error Node 18+ streaming
    duplex: 'half',
  })

  const res = new NextResponse(null, { status: upstream.status })
  res.headers.set('Tus-Resumable', '1.0.0')
  const newOffset = upstream.headers.get('upload-offset')
  if (newOffset) res.headers.set('Upload-Offset', newOffset)
  return res
}

// HEAD — check resume offset (used by tus-js-client on retry/resume)
export async function HEAD(req: NextRequest, ctx: Ctx) {
  const userId = req.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { uploadId } = await ctx.params
  const url = `${SUPABASE_TUS_BASE}/${uploadId}`

  const upstream = await fetch(url, {
    method: 'HEAD',
    headers: {
      Authorization: `Bearer ${serviceKey()}`,
      'Tus-Resumable': '1.0.0',
    },
  })

  const res = new NextResponse(null, { status: upstream.status })
  res.headers.set('Tus-Resumable', '1.0.0')
  res.headers.set('Cache-Control', 'no-store')
  const uploadOffset = upstream.headers.get('upload-offset')
  const uploadLength = upstream.headers.get('upload-length')
  if (uploadOffset) res.headers.set('Upload-Offset', uploadOffset)
  if (uploadLength) res.headers.set('Upload-Length', uploadLength)
  return res
}
