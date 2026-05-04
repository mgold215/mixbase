import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { uploadLimiter } from '@/lib/rate-limit'

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

  const { filename, contentType } = await req.json()
  if (!filename || typeof filename !== 'string') {
    return NextResponse.json({ error: 'filename required' }, { status: 400 })
  }

  // Sanitize: reject path traversal and null bytes; strip leading slashes
  const normalized = filename.replace(/\\/g, '/')
  if (normalized.split('/').some(seg => seg === '..' || seg === '.' || seg.includes('\0'))) {
    return NextResponse.json({ error: 'Invalid filename' }, { status: 400 })
  }
  const safeFilename = normalized.replace(/^\/+/, '')

  const { data, error } = await supabaseAdmin.storage
    .from('mf-audio')
    .createSignedUploadUrl(safeFilename, { upsert: true })

  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? 'Failed to create signed URL' }, { status: 500 })
  }

  const { data: pub } = supabaseAdmin.storage.from('mf-audio').getPublicUrl(safeFilename)

  return NextResponse.json({
    signedUrl: data.signedUrl,
    publicUrl: pub.publicUrl,
    contentType,
  })
}
