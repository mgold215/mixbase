import { NextRequest, NextResponse } from 'next/server'
import { isUuid } from '@/lib/validators'
import { ownsProject } from '@/lib/ownership'
import { verifyAccessToken, makeJwtKey } from '@/lib/verifyToken'

// Disable body parsing — we stream the body straight through to Supabase
export const maxDuration = 300

const SUPABASE_TUS = `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://mdefkqaawrusoaojstpq.supabase.co'}/storage/v1/upload/resumable`

function serviceKey() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY not set')
  return key
}

// Parse a TUS Upload-Metadata header ("key b64val,key2 b64val2") and return the
// decoded value for one key, or null if absent/undecodable.
function metadataValue(header: string | null, key: string): string | null {
  if (!header) return null
  for (const pair of header.split(',')) {
    const [k, v] = pair.trim().split(' ')
    if (k === key && v) {
      try { return Buffer.from(v, 'base64').toString('utf8') } catch { return null }
    }
  }
  return null
}

// Resolve the caller from the access-token cookie. /api/tus is a public path (the
// resumable protocol streams large bodies and must skip the auth-refresh middleware),
// so we verify the cookie here in-route instead of reading the X-User-Id header.
async function userIdFromCookie(req: NextRequest): Promise<string | null> {
  const token = req.cookies.get('sb-access-token')?.value
  if (!token) return null
  const { userId } = await verifyAccessToken(token, makeJwtKey(process.env.SUPABASE_JWT_SECRET))
  return userId
}

// POST — create a new TUS upload session at Supabase using the service-role key.
// The service-role key bypasses Supabase's anon per-file size limit.
// We return a /api/tus/<uploadId> Location so subsequent PATCHes go through this proxy
// (each PATCH is one chunk ≤ 8 MB, well under Railway's 10 MB request body wall).
export async function POST(req: NextRequest) {
  // Authenticate (cookie-based — see userIdFromCookie) and verify the caller owns the
  // project the object path is namespaced under. The path is `<projectId>/<ts>.<ext>`
  // and this creates an upsert-enabled session into the shared public bucket, so
  // without this a user could overwrite another user's audio/artwork (IDOR).
  const userId = await userIdFromCookie(req)
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const objectName = metadataValue(req.headers.get('upload-metadata'), 'objectName')
  const projectId = objectName?.split('/')[0]
  if (!projectId || !isUuid(projectId)) {
    return NextResponse.json({ error: 'Valid objectName project prefix is required' }, { status: 400 })
  }
  if (!await ownsProject(projectId, userId)) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

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
    // Return JSON so the client's `await res.json()` can't throw on a plain-text
    // body and crash the upload with an unhandled rejection.
    const text = await upstream.text()
    return NextResponse.json({ error: text || 'TUS session creation failed' }, { status: upstream.status })
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
