import { supabaseAdmin } from '@/lib/supabase'

// Shared persistence for generated visualizers. Both the AI path
// (/api/visualizer/runway) and the free path (/api/visualizer/save) upload the
// video bytes to the mf-video bucket and record a row so the result is findable
// in the Media library — mirroring how artwork lands in mf-artwork.

const VIDEO_BUCKET = 'mf-video'

// Confirm the caller owns the project before writing a visualizer against it —
// the same IDOR guard generate-artwork uses before touching project artwork.
export async function userOwnsProject(userId: string, projectId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('mb_projects')
    .select('id')
    .eq('id', projectId)
    .eq('user_id', userId)
    .single()
  return !error && !!data
}

export type StoreVisualizerArgs = {
  userId: string
  projectId: string
  bytes: Buffer | Uint8Array
  contentType: string
  kind: 'free' | 'ai'
  title: string
  sourceImageUrl?: string | null
}

export type StoredVisualizer = { id: string; video_url: string }

// Upload a generated visualizer and index it. Returns null when the upload
// itself fails (caller decides how to degrade); if only the DB insert fails the
// bytes are still stored, so the public URL is returned with an empty id.
export async function storeVisualizer(args: StoreVisualizerArgs): Promise<StoredVisualizer | null> {
  const { userId, projectId, bytes, contentType, kind, title, sourceImageUrl } = args

  const ext = contentType.includes('mp4') ? 'mp4'
    : contentType.includes('quicktime') ? 'mov'
    : 'webm'
  const filename = `${projectId}/viz-${Date.now()}.${ext}`

  const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
    .from(VIDEO_BUCKET)
    .upload(filename, bytes, { contentType, upsert: false })
  if (uploadError || !uploadData) {
    console.error('[visualizer-store] upload error:', uploadError?.message)
    return null
  }

  const { data: urlData } = supabaseAdmin.storage.from(VIDEO_BUCKET).getPublicUrl(uploadData.path)
  const videoUrl = urlData.publicUrl

  const { data: row, error: dbError } = await supabaseAdmin
    .from('mb_visualizers')
    .insert({
      user_id: userId,
      project_id: projectId,
      video_url: videoUrl,
      source_image_url: sourceImageUrl ?? null,
      kind,
      title,
    })
    .select('id')
    .single()
  if (dbError || !row) {
    // Bytes are saved but unindexed — still hand back the URL so the user sees
    // their video; the row is what Media reads, so log loudly for follow-up.
    console.error('[visualizer-store] db insert error:', dbError?.message)
    return { id: '', video_url: videoUrl }
  }

  return { id: row.id as string, video_url: videoUrl }
}

// Derive the storage object path (after the bucket segment) from a public URL,
// for deletes. Returns null if the URL isn't an mf-video object.
export function videoStoragePath(url: string): string | null {
  const marker = `/storage/v1/object/public/${VIDEO_BUCKET}/`
  const idx = url.indexOf(marker)
  if (idx === -1) return null
  return url.slice(idx + marker.length)
}

export { VIDEO_BUCKET }
