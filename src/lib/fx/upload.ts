// Client half of the full-resolution save path: PUT the encoded clip DIRECTLY
// to Supabase Storage via a short-lived signed URL, then register it with
// /api/visualizer/finalize. File bytes never traverse Railway (its proxy
// truncates bodies over 10 MB — see upload-audio-architecture); only the
// small JSON claim does.

import type { VizRecipe } from './types.ts'

export type UploadedVisualizer = {
  id: string
  video_url: string
  transcoded: boolean
}

export class VizUploadError extends Error {}

async function putWithRetry(signedUrl: string, blob: Blob, contentType: string): Promise<void> {
  // One retry on a network-level failure: signed-URL PUTs are single-shot
  // (no resume), and a second attempt absorbs the transient blips that
  // dominate upload failures in practice.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(signedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: blob,
      })
      if (res.ok) return
      // A definitive rejection (expired token, bucket policy) won't improve
      // on retry with the same URL.
      throw new VizUploadError(`Upload failed (${res.status})`)
    } catch (err) {
      if (err instanceof VizUploadError) throw err
      if (attempt === 1) throw new VizUploadError('Upload failed (network)')
      await new Promise(r => setTimeout(r, 1500))
    }
  }
}

// Upload + register a rendered clip. Throws VizUploadError with a
// user-presentable message on failure; the caller may fall back to the legacy
// multipart save for small blobs.
export async function uploadVisualizer(opts: {
  blob: Blob
  contentType: 'video/mp4' | 'video/webm'
  projectId: string
  title: string
  settings: VizRecipe
  sourceImageUrl: string | null
}): Promise<UploadedVisualizer> {
  const ext = opts.contentType === 'video/mp4' ? 'mp4' : 'webm'
  const storagePath = `${opts.projectId}/viz-${Date.now()}.${ext}`

  const urlRes = await fetch('/api/upload-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: storagePath, contentType: opts.contentType, bucket: 'mf-video' }),
  })
  const urlData = await urlRes.json().catch(() => null) as { signedUrl?: string; error?: string } | null
  if (!urlRes.ok || !urlData?.signedUrl) {
    throw new VizUploadError(urlData?.error ?? `Could not start the upload (${urlRes.status})`)
  }

  await putWithRetry(urlData.signedUrl, opts.blob, opts.contentType)

  // Register the object. On a busy-transcoder 503 the object is still in
  // place, so retry the (cheap) finalize call after the advertised delay
  // instead of re-uploading.
  for (let attempt = 0; ; attempt++) {
    const finRes = await fetch('/api/visualizer/finalize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: opts.projectId,
        storagePath,
        title: opts.title,
        settings: opts.settings,
        sourceImageUrl: opts.sourceImageUrl ?? undefined,
      }),
    })
    if (finRes.status === 503 && attempt < 2) {
      const retryAfter = parseInt(finRes.headers.get('Retry-After') ?? '20', 10)
      await new Promise(r => setTimeout(r, Math.min(30, Math.max(5, retryAfter)) * 1000))
      continue
    }
    const finData = await finRes.json().catch(() => null) as
      | { id?: string; video_url?: string; transcoded?: boolean; error?: string }
      | null
    if (!finRes.ok || !finData?.video_url) {
      throw new VizUploadError(finData?.error ?? `Could not save the video (${finRes.status})`)
    }
    return {
      id: finData.id ?? '',
      video_url: finData.video_url,
      transcoded: finData.transcoded !== false,
    }
  }
}
