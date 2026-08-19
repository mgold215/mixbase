import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { uploadLimiter, rateLimitHeaders , checkUserLimit } from '@/lib/rate-limit'
import { ownsProject } from '@/lib/ownership'
import { isUuid, canonicalUuid } from '@/lib/validators'
import { VIZ_KEY_RE } from '@/lib/visualizer-finalize'

// Buckets the client is allowed to request a signed upload URL for.
// mf-video: full-resolution FX-studio exports (too big for the 10 MB multipart
// save path) PUT here directly, then register through /api/visualizer/finalize,
// which validates the object and indexes the mb_visualizers row. The ownership
// gate below already covers it — video keys are `<ownedProjectId>/viz-*.<ext>`.
const ALLOWED_BUCKETS = ['mf-audio', 'mf-artwork', 'mf-video'] as const
type UploadBucket = (typeof ALLOWED_BUCKETS)[number]

// POST /api/upload-url
// Returns a short-lived Supabase signed upload URL so the client can PUT the file
// directly to Supabase Storage — completely bypassing Railway's HTTP proxy and its
// request body limits, which were causing long audio files to be silently truncated.
export async function POST(req: NextRequest) {
  const userId = req.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const limit = await checkUserLimit(uploadLimiter, userId)
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Too many upload requests. Try again later.' }, { status: 429, headers: rateLimitHeaders(limit) })
  }

  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  const { filename, contentType, bucket } = body
  if (!filename || typeof filename !== 'string') {
    return NextResponse.json({ error: 'filename required' }, { status: 400 })
  }

  const targetBucket: UploadBucket =
    ALLOWED_BUCKETS.includes(bucket) ? bucket : 'mf-audio'

  // Sanitize: reject path traversal and null bytes; strip leading slashes
  const normalized = filename.replace(/\\/g, '/')
  if (normalized.split('/').some(seg => seg === '..' || seg === '.' || seg.includes('\0'))) {
    return NextResponse.json({ error: 'Invalid filename' }, { status: 400 })
  }

  // Canonicalise the leading id segment INSIDE THE KEY, before anything reads
  // it. The client hands us the WHOLE key here, and the key is what Supabase
  // stores verbatim — so lowercasing only the variable we validate would
  // authorize a canonical id while signing an uppercase one, and an uppercase
  // key is unreapable (see canonicalUuid). Rewriting the key first makes the id
  // we validate, the id we authorize, and the key we sign the same string by
  // construction. A non-UUID first segment is left untouched and refused two
  // lines below, exactly as before.
  //
  // Order matters: the traversal/null-byte rejection above already ran, and a
  // canonical UUID contains no `/`, `.` or `\0`, so this substitution cannot
  // reintroduce anything that check just refused.
  const segments = normalized.replace(/^\/+/, '').split('/')
  const canonicalFirst = canonicalUuid(segments[0])
  if (canonicalFirst) segments[0] = canonicalFirst
  const safeFilename = segments.join('/')

  // Rejecting `..` is NOT enough on its own: every key in these buckets is a
  // perfectly ordinary `<projectId>/<timestamp>.<ext>` path, so traversal was
  // never needed to reach someone else's object — you just ask for their key.
  // And those keys are not secret: GET /api/feed hands every signed-in user the
  // `audio_url` and `artwork_url` of every other user's uploads. Without an
  // ownership check this route would mint a valid upload URL for a stranger's
  // object in a public-read bucket. Same gate /api/tus already applies to the
  // chunked path that large files take.
  const projectId = safeFilename.split('/')[0]
  if (!isUuid(projectId) || !(await ownsProject(projectId, userId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // mf-video keys must be the viz-* shape /api/visualizer/finalize accepts —
  // anything else could be signed and uploaded but never indexed, so it could
  // only ever leak storage.
  if (targetBucket === 'mf-video' && !VIZ_KEY_RE.test(safeFilename)) {
    return NextResponse.json({ error: 'Invalid filename' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin.storage
    .from(targetBucket)
    // No overwrites. Every caller builds a fresh `<projectId>/<Date.now()>` key,
    // so nothing here needs upsert — and signing WITH it stamps overwrite
    // authorization into the token itself (storage-js sends `x-upsert` at the
    // sign step), which is what turned a stray key into a defacement primitive.
    .createSignedUploadUrl(safeFilename, { upsert: false })

  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? 'Failed to create signed URL' }, { status: 500 })
  }

  const { data: pub } = supabaseAdmin.storage.from(targetBucket).getPublicUrl(safeFilename)

  return NextResponse.json({
    signedUrl: data.signedUrl,
    publicUrl: pub.publicUrl,
    contentType,
  })
}
