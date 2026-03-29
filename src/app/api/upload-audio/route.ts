import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// DELETE /api/upload-audio — remove an uploaded file from storage (used for cleanup on failed version creation)
export async function DELETE(request: NextRequest) {
  const { path, bucket } = await request.json()
  if (!path || !bucket) return NextResponse.json({ error: 'path and bucket required' }, { status: 400 })
  const { error } = await supabaseAdmin.storage.from(bucket).remove([path])
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

const MAX_AUDIO_SIZE = 50 * 1024 * 1024  // 50MB — Supabase free tier max
const MAX_IMAGE_SIZE = 10 * 1024 * 1024  // 10MB for artwork

// Ensure the storage bucket exists, creating it if needed
async function ensureBucket(bucket: string, isAudio: boolean) {
  const { error } = await supabaseAdmin.storage.getBucket(bucket)
  if (error?.message?.includes('not found') || error?.message?.includes('does not exist')) {
    await supabaseAdmin.storage.createBucket(bucket, {
      public: true,
      fileSizeLimit: isAudio ? 52428800 : 10485760,
      allowedMimeTypes: isAudio
        ? ['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/aiff', 'audio/x-aiff', 'audio/flac', 'audio/ogg', 'audio/mp4', 'audio/x-m4a', 'audio/*']
        : ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
    })
  }
}

// POST /api/upload-audio — upload audio file or artwork to Supabase Storage
export async function POST(request: NextRequest) {
  const formData = await request.formData()
  const file = formData.get('file') as File | null
  const projectId = formData.get('project_id') as string
  const type = (formData.get('type') as string) ?? 'audio'  // 'audio' | 'artwork'

  if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 })

  const maxSize = type === 'artwork' ? MAX_IMAGE_SIZE : MAX_AUDIO_SIZE
  if (file.size > maxSize) {
    return NextResponse.json(
      { error: `File too large. Maximum size is ${maxSize / 1024 / 1024}MB.` },
      { status: 413 }
    )
  }

  const bucket = type === 'artwork' ? 'mf-artwork' : 'mf-audio'
  const isAudio = type !== 'artwork'

  // Auto-create the bucket if it doesn't exist yet
  await ensureBucket(bucket, isAudio)

  const ext = file.name.split('.').pop()
  const filename = `${projectId}/${Date.now()}.${ext}`

  const arrayBuffer = await file.arrayBuffer()
  const buffer = new Uint8Array(arrayBuffer)

  const { data, error } = await supabaseAdmin.storage
    .from(bucket)
    .upload(filename, buffer, {
      contentType: file.type,
      upsert: false,
    })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const { data: urlData } = supabaseAdmin.storage.from(bucket).getPublicUrl(data.path)

  return NextResponse.json({
    url: urlData.publicUrl,
    path: data.path,
    size: file.size,
    name: file.name,
  })
}
