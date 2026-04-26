import { NextRequest, NextResponse } from 'next/server'
import { verifyProjectOwner } from '@/lib/ownership'

// Disable body parsing — we stream the body straight through to Supabase
export const maxDuration = 300

const SUPABASE_TUS = `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://mdefkqaawrusoaojstpq.supabase.co'}/storage/v1/upload/resumable`

function serviceKey() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY not set')
  return key
}

function parseUploadMetadata(value: string | null): Record<string, string> {
  if (!value) return {}

  return Object.fromEntries(
    value.split(',').map((pair) => {
      const [key, encoded = ''] = pair.trim().split(/\s+/, 2)
      let decoded = ''
      try {
        decoded = Buffer.from(encoded, 'base64').toString('utf8')
      } catch {
        decoded = ''
      }
      return [key, decoded]
    }).filter(([key]) => key)
  )
}

async function validateTusUploadRequest(req: NextRequest, userId: string): Promise<NextResponse | null> {
  const metadata = parseUploadMetadata(req.headers.get('upload-metadata'))
  const bucketName = metadata.bucketName ?? metadata.bucket
  const objectName = metadata.objectName ?? metadata.filename ?? metadata.name
  const contentType = metadata.contentType ?? req.headers.get('content-type') ?? ''

  if (bucketName !== 'mf-audio') {
    return NextResponse.json({ error: 'TUS uploads are only allowed for mf-audio' }, { status: 400 })
  }
  if (!objectName || !objectName.includes('/')) {
    return NextResponse.json({ error: 'objectName metadata must be scoped to a project path' }, { status: 400 })
  }
  if (contentType && !contentType.startsWith('audio/')) {
    return NextResponse.json({ error: 'TUS uploads must be audio files' }, { status: 400 })
  }

  const projectId = objectName.split('/')[0]
  if (!await verifyProjectOwner(projectId, userId)) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  return null
}

// POST — create a new TUS upload session at Supabase using the service-role key.
// The service-role key bypasses Supabase's anon per-file size limit.
// We return a /api/tus/<uploadId> Location so subsequent PATCHes go through this proxy
// (each PATCH is one chunk ≤ 8 MB, well under Railway's 10 MB request body wall).
export async function POST(req: NextRequest) {
  const userId = req.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const validationError = await validateTusUploadRequest(req, userId)
  if (validationError) return validationError

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
