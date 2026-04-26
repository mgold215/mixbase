import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { verifyProjectOwner } from '@/lib/ownership'

// POST /api/upload-url
// Returns a short-lived Supabase signed upload URL so the client can PUT the file
// directly to Supabase Storage — completely bypassing Railway's HTTP proxy and its
// request body limits, which were causing long audio files to be silently truncated.
export async function POST(req: NextRequest) {
  const userId = req.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { filename, contentType, project_id } = await req.json()
  if (!filename) return NextResponse.json({ error: 'filename required' }, { status: 400 })
  if (!project_id) return NextResponse.json({ error: 'project_id required' }, { status: 400 })
  if (!filename.startsWith(`${project_id}/`)) {
    return NextResponse.json({ error: 'filename must be scoped to project_id' }, { status: 400 })
  }

  if (!await verifyProjectOwner(project_id, userId)) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  const { data, error } = await supabaseAdmin.storage
    .from('mf-audio')
    .createSignedUploadUrl(filename, { upsert: true })

  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? 'Failed to create signed URL' }, { status: 500 })
  }

  const { data: pub } = supabaseAdmin.storage.from('mf-audio').getPublicUrl(filename)

  return NextResponse.json({
    signedUrl: data.signedUrl,
    publicUrl: pub.publicUrl,
    contentType,
  })
}
