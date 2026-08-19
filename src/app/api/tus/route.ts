import { NextRequest, NextResponse } from 'next/server'
import { uploadLimiter, rateLimitHeaders , checkUserLimit } from '@/lib/rate-limit'
import { ownsProject } from '@/lib/ownership'
import { canonicalUuid } from '@/lib/validators'

// Disable body parsing — we stream the body straight through to Supabase
export const maxDuration = 300

const SUPABASE_TUS = `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://mdefkqaawrusoaojstpq.supabase.co'}/storage/v1/upload/resumable`

// Only audio may be chunked-uploaded through this proxy. Artwork/video use the
// signed-URL path. The service-role key would otherwise let a caller target any
// bucket, so this is an explicit allow-list.
const ALLOWED_BUCKET = 'mf-audio'
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024 // 2 GB — matches the mf-audio bucket limit

function serviceKey() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY not set')
  return key
}

// Parse a TUS `Upload-Metadata` header: comma-separated `key <base64value>`
// pairs (value omitted for valueless keys). Returns a plain object of decoded
// string values.
function parseUploadMetadata(header: string | null): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const pair of header.split(',')) {
    const [key, b64] = pair.trim().split(' ')
    if (!key) continue
    if (b64) {
      try {
        out[key] = Buffer.from(b64, 'base64').toString('utf8')
      } catch {
        out[key] = ''
      }
    } else {
      out[key] = ''
    }
  }
  return out
}

// Re-emit an `Upload-Metadata` header with `objectName` replaced by `key`.
//
// This route forwards the CLIENT'S metadata header upstream verbatim, and that
// header — not any variable in this file — is what Supabase turns into the
// storage object key. So validating a normalised/canonical copy of objectName
// and then forwarding the raw one authorizes one key and writes another. Two
// ways that bit us, both of which produce an object no cleanup path can name
// (every reaper matches the lowercase, slash-normalised id Postgres hands back):
//   * an UPPERCASE project segment — see canonicalUuid in @/lib/validators;
//   * a `\`-separated or leading-`/` objectName, which the checks below fold
//     away before validating but which Supabase would have stored as written.
//
// Every OTHER pair is passed through byte-identically rather than re-encoded:
// parseUploadMetadata cannot distinguish a valueless TUS key from one whose
// value failed to decode, so round-tripping the whole header through it could
// silently rewrite metadata this route has no business touching. When
// `objectName` is absent (never, for a real upload — it is required below) the
// pair is appended so the returned header still describes the validated key.
function withObjectName(header: string | null, key: string): string {
  const encoded = Buffer.from(key, 'utf8').toString('base64')
  const pairs = (header ?? '').split(',').map(p => p.trim()).filter(Boolean)
  let replaced = false
  const out = pairs.map(pair => {
    if (pair.split(' ')[0] !== 'objectName') return pair
    replaced = true
    return `objectName ${encoded}`
  })
  if (!replaced) out.push(`objectName ${encoded}`)
  return out.join(',')
}

// POST — create a new TUS upload session at Supabase using the service-role key.
// The service-role key bypasses Supabase's anon per-file size limit.
//
// This route is authenticated (removed from PUBLIC_PATHS): it validates that the
// caller owns the target project and can only write audio to the mf-audio bucket
// under that project's folder. Without these checks the service-role key allowed
// anonymous callers to upload/overwrite arbitrary objects in any bucket.
export async function POST(req: NextRequest) {
  const userId = req.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const limit = await checkUserLimit(uploadLimiter, userId)
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Too many upload requests. Try again later.' },
      { status: 429, headers: rateLimitHeaders(limit) },
    )
  }

  const meta = parseUploadMetadata(req.headers.get('upload-metadata'))

  // Bucket must be the audio bucket.
  if (meta.bucketName !== ALLOWED_BUCKET) {
    return NextResponse.json({ error: 'Invalid bucket' }, { status: 400 })
  }

  // Object key must be `<projectId>/<file>` with no traversal, and the project
  // must belong to this user.
  const objectName = meta.objectName ?? ''
  const normalized = objectName.replace(/\\/g, '/').replace(/^\/+/, '')
  const segments = normalized.split('/')
  if (
    segments.length < 2 ||
    segments.some(seg => seg === '..' || seg === '.' || seg === '' || seg.includes('\0'))
  ) {
    return NextResponse.json({ error: 'Invalid object name' }, { status: 400 })
  }
  const projectId = canonicalUuid(segments[0])
  if (!projectId) {
    return NextResponse.json({ error: 'Invalid object name' }, { status: 400 })
  }
  if (!(await ownsProject(projectId, userId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // The key Supabase will actually store: the normalised path with the id
  // segment in its canonical spelling. Everything downstream must travel on
  // THIS value, never on meta.objectName — see withObjectName.
  segments[0] = projectId
  const storageKey = segments.join('/')

  // Enforce the declared size cap (defence-in-depth alongside the bucket limit).
  const declaredLength = Number(req.headers.get('upload-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: 'File too large (max 2GB)' }, { status: 413 })
  }

  const forwardHeaders: Record<string, string> = {
    Authorization: `Bearer ${serviceKey()}`,
    'Tus-Resumable': req.headers.get('tus-resumable') ?? '1.0.0',
    'x-upsert': 'true',
  }
  for (const h of ['upload-length', 'upload-defer-length', 'content-type']) {
    const v = req.headers.get(h)
    if (v) forwardHeaders[h] = v
  }
  // Deliberately NOT copied from the request alongside the headers above: the
  // metadata is the one header whose contents this route has just validated,
  // so it is re-emitted around the validated key rather than passed through.
  forwardHeaders['upload-metadata'] = withObjectName(req.headers.get('upload-metadata'), storageKey)

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
