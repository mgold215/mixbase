import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// POST /api/upload-url
// Returns a short-lived signed upload URL so the browser can upload the
// audio file DIRECTLY to Supabase Storage, bypassing Railway's HTTP proxy.
// The proxy was silently truncating 30-50MB audio files because it sits
// between the browser and Next.js; with signed URLs the bytes never pass
// through Railway at all.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
  const projectId = body?.project_id as string | undefined
  const filename = body?.filename as string | undefined

  if (!projectId || !filename) {
    return NextResponse.json({ error: 'project_id and filename are required' }, { status: 400 })
  }

  const ext = filename.split('.').pop() ?? 'wav'
  const path = `${projectId}/${Date.now()}.${ext}`

  const { data, error } = await supabaseAdmin.storage
    .from('mf-audio')
    .createSignedUploadUrl(path)

  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? 'Failed to create upload URL' }, { status: 500 })
  }

  const { data: urlData } = supabaseAdmin.storage.from('mf-audio').getPublicUrl(path)

  return NextResponse.json({
    path: data.path,
    token: data.token,
    signedUrl: data.signedUrl,   // browser PUTs the file here directly
    publicUrl: urlData.publicUrl, // where it will live after upload
  })
}
