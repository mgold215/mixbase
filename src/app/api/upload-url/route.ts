import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { uploadLimiter } from '@/lib/rate-limit'
import { isUuid } from '@/lib/validators'
import { ownsProject } from '@/lib/ownership'

// Buckets the client is allowed to request a signed upload URL for.
const ALLOWED_BUCKETS = ['mf-audio', 'mf-artwork'] as const
type UploadBucket = (typeof ALLOWED_BUCKETS)[number]

// POST /api/upload-url
// Returns a short-lived Supabase signed upload URL so the client can PUT the file
// directly to Supabase Storage — completely bypassing Railway's HTTP proxy and its
// request body limits, which were causing long audio files to be silently truncated.
export async function POST(req: NextRequest) {
  const userId = req.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const limit = uploadLimiter.check(userId)
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Too many upload requests. Try again later.' }, { status: 429 })
  }

  const { filename, contentType, bucket } = await req.json()
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
  const safeFilename = normalized.replace(/^\/+/, '')

  // Ownership gate. The client always names objects `<projectId>/<timestamp>.<ext>`
  // (ProjectClient.tsx / NewProjectForm.tsx). Because this is an upsert into a shared
  // public bucket, without this check a user could request a signed URL for another
  // user's object path and overwrite their audio/artwork in place (IDOR). Validate the
  // prefix is a UUID this user owns — mirrors the upload-audio route.
  const projectId = safeFilename.split('/')[0]
  if (!isUuid(projectId)) {
    return NextResponse.json({ error: 'Valid project_id prefix is required' }, { status: 400 })
  }
  if (!await ownsProject(projectId, userId)) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  const { data, error } = await supabaseAdmin.storage
    .from(targetBucket)
    .createSignedUploadUrl(safeFilename, { upsert: true })

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
