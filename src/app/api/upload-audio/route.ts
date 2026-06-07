import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

const MAX_AUDIO_SIZE = 50 * 1024 * 1024  // 50MB — Supabase free tier max
const MAX_IMAGE_SIZE = 50 * 1024 * 1024  // 50MB for artwork (signed-URL path bypasses Railway's 10MB wall)

const ARTWORK_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
const AUDIO_MIME_TYPES = ['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/aiff', 'audio/x-aiff', 'audio/flac', 'audio/ogg', 'audio/mp4', 'audio/x-m4a', 'audio/*']

// Track which buckets have been verified this process lifetime
const verifiedBuckets = new Set<string>()

// Verify the storage bucket exists (create only if missing — never update limits)
async function ensureBucket(bucket: string, isAudio: boolean) {
  if (verifiedBuckets.has(bucket)) return
  const mimeTypes = isAudio ? AUDIO_MIME_TYPES : ARTWORK_MIME_TYPES
  // mf-audio is configured for 2GB; mf-artwork for 50MB — set in Supabase dashboard
  const sizeLimit = isAudio ? 2147483648 : 52428800
  const { error } = await supabaseAdmin.storage.getBucket(bucket)
  if (error?.message?.includes('not found') || error?.message?.includes('does not exist')) {
    await supabaseAdmin.storage.createBucket(bucket, {
      public: true,
      fileSizeLimit: sizeLimit,
      allowedMimeTypes: mimeTypes,
    })
  }
  // Never updateBucket — that would overwrite limits configured in the dashboard
  verifiedBuckets.add(bucket)
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

  const ext = (file.name.split('.').pop() ?? '').toLowerCase()
  const filename = `${projectId}/${Date.now()}.${ext}`

  // Some browsers report empty mime for HEIC/HEIF — fall back by extension
  const mimeByExt: Record<string, string> = {
    heic: 'image/heic', heif: 'image/heif',
    jpg: 'image/jpeg', jpeg: 'image/jpeg',
    png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  }
  const contentType = file.type || mimeByExt[ext] || 'application/octet-stream'

  const arrayBuffer = await file.arrayBuffer()
  const buffer = new Uint8Array(arrayBuffer)

  const { data, error } = await supabaseAdmin.storage
    .from(bucket)
    .upload(filename, buffer, {
      contentType,
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
