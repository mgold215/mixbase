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

// One signed slot: the URL to PUT to and the storage key it writes.
type SignedSlot = { signedUrl: string; storagePath: string }

// Ask the server for a fresh signed upload URL against a brand-new key.
// Key shape is enforced server-side (VIZ_KEY_RE in visualizer-finalize.ts):
// `<projectId>/viz-<stamp>.<ext>`.
async function signSlot(projectId: string, ext: string, contentType: string): Promise<SignedSlot> {
  const storagePath = `${projectId}/viz-${Date.now()}.${ext}`
  const res = await fetch('/api/upload-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: storagePath, contentType, bucket: 'mf-video' }),
  })
  const data = await res.json().catch(() => null) as { signedUrl?: string; error?: string } | null
  if (!res.ok || !data?.signedUrl) {
    throw new VizUploadError(data?.error ?? `Could not start the upload (${res.status})`)
  }
  return { signedUrl: data.signedUrl, storagePath }
}

async function putWithRetry(
  sign: () => Promise<SignedSlot>,
  blob: Blob,
  contentType: string,
  // Keys signed but abandoned mid-flight are pushed here so the caller can hand
  // them to /api/visualizer/finalize, which reference-checks and deletes them.
  abandoned: string[],
): Promise<SignedSlot> {
  // One retry on a network-level failure: signed-URL PUTs are single-shot
  // (no resume), and a second attempt absorbs the transient blips that
  // dominate upload failures in practice.
  //
  // The retry must use a FRESH url + key, never a replay of the old one.
  // /api/upload-url signs with `{ upsert: false }` (deliberately — signing WITH
  // upsert stamps overwrite authorization into the token), so if the first PUT
  // actually delivered the bytes and only the response was lost, replaying that
  // URL hits an existing object and fails: bytes in the bucket, no row, and the
  // user told the save failed. A new key always writes.
  //
  // That leaves the first key's bytes behind whenever the lost-response case is
  // the real one, so the abandoned key is recorded and reported in the finalize
  // claim — the server deletes it under the same reference check that guards
  // the claimed object. Neither leak, and the save still reports the truth.
  let slot = await sign()
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(slot.signedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: blob,
      })
      if (res.ok) return slot
      // A definitive rejection (expired token, bucket policy) won't improve
      // on retry with the same URL.
      throw new VizUploadError(`Upload failed (${res.status})`)
    } catch (err) {
      if (err instanceof VizUploadError) throw err
      if (attempt === 1) throw new VizUploadError('Upload failed (network)')
      await new Promise(r => setTimeout(r, 1500))
      abandoned.push(slot.storagePath)
      // May itself throw VizUploadError — a signing failure is definitive.
      slot = await sign()
    }
  }
  // Unreachable: the loop either returns or throws. Present so the return type
  // stays honest without widening it to `| undefined`.
  throw new VizUploadError('Upload failed (network)')
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

  // The key is minted per signing attempt, so a retry never replays a spent one.
  const abandonedPaths: string[] = []
  const { storagePath } = await putWithRetry(
    () => signSlot(opts.projectId, ext, opts.contentType),
    opts.blob,
    opts.contentType,
    abandonedPaths,
  )

  // Register the object. On a busy-transcoder 503 the object is still in
  // place, so retry the (cheap) finalize call after the advertised delay
  // instead of re-uploading.
  for (let attempt = 0; ; attempt++) {
    let finRes: Response
    try {
      finRes = await fetch('/api/visualizer/finalize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: opts.projectId,
          storagePath,
          title: opts.title,
          settings: opts.settings,
          sourceImageUrl: opts.sourceImageUrl ?? undefined,
          // Empty on the overwhelmingly common single-attempt path.
          abandonedPaths,
        }),
      })
    } catch {
      // A lost response here used to escape this loop entirely, and the caller
      // (FreeStudio.saveRendered) treats any throw as "signed path failed" and
      // falls into the legacy multipart save — which stores a SECOND copy of
      // the bytes and a second row. The claim is a few hundred bytes of JSON
      // against an object that is already in the bucket, so retrying it is far
      // cheaper: the worst case is a duplicate row pointing at the SAME object
      // instead of duplicate bytes plus a duplicate row.
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 2000))
        continue
      }
      throw new VizUploadError('Could not save the video (network)')
    }
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
