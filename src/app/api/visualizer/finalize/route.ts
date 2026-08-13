import { NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import { supabaseAdmin } from '@/lib/supabase'
import { indexVisualizer, storeVisualizer, userOwnsProject, VIDEO_BUCKET } from '@/lib/visualizer-store'
import { webmToMp4, tryAcquireTranscodeSlot, releaseTranscodeSlot } from '@/lib/visualizer-encode'
import { isUuid, isSupabaseStorageUrl } from '@/lib/validators'
import { vizSaveLimiter, checkUserLimit, rateLimitHeaders } from '@/lib/rate-limit'
import {
  MAX_FINALIZE_BYTES,
  MAX_FINALIZE_WEBM_BYTES,
  MIN_CLIP_SECONDS,
  MP4_PROBE_BYTES,
  parseVizStoragePath,
  sanitizeSettings,
} from '@/lib/visualizer-finalize'

// Allow time to validate (mp4) or download + transcode (webm) and index.
export const maxDuration = 60

// POST /api/visualizer/finalize — index a visualizer the client already
// uploaded DIRECTLY to mf-video via a signed URL from /api/upload-url. The
// bytes never traverse Railway (10 MB proxy wall — see
// upload-audio-architecture), so full-resolution exports of any size land
// here as a small JSON claim: { projectId, storagePath, title?, settings?,
// sourceImageUrl? }.
//
// The object is validated server-side before it becomes visible in the
// library: the storage key must be owned-project-prefixed and viz-shaped, and
// the bytes must actually be a playable clip (h264 mp4 with sane duration, or
// a webm we transcode exactly like /api/visualizer/save does). A claim that
// fails validation deletes the object — an unindexed upload must not leak.
export async function POST(req: NextRequest) {
  const userId = req.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  // Same cap as the multipart save path — this is the same logical operation.
  const limit = await checkUserLimit(vizSaveLimiter, userId)
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Too many visualizer saves. Try again shortly.' },
      { status: 429, headers: rateLimitHeaders(limit) },
    )
  }

  const body = await req.json().catch(() => null) as {
    projectId?: unknown
    storagePath?: unknown
    title?: unknown
    settings?: unknown
    sourceImageUrl?: unknown
  } | null
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

  const projectId = String(body.projectId ?? '')
  if (!isUuid(projectId)) return NextResponse.json({ error: 'Valid projectId is required' }, { status: 400 })
  if (!(await userOwnsProject(userId, projectId))) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  const parsed = parseVizStoragePath(projectId, body.storagePath)
  if (!parsed) return NextResponse.json({ error: 'Invalid storagePath' }, { status: 400 })
  const storagePath = body.storagePath as string

  const title = String(body.title ?? 'Visualizer').slice(0, 200)
  // Only a real Supabase Storage URL may persist as the poster reference —
  // same guard as /api/visualizer/save.
  const sourceImageUrl = isSupabaseStorageUrl(body.sourceImageUrl)
    ? String(body.sourceImageUrl)
    : null
  const settings = sanitizeSettings(body.settings)

  const { data: pub } = supabaseAdmin.storage.from(VIDEO_BUCKET).getPublicUrl(storagePath)

  // Delete a claimed object ONLY if no mb_visualizers row references it. All
  // stored clips — including finished youtube/shorts renders and pinned
  // loops — share the `{projectId}/viz-*.{ext}` key shape, so an owner can
  // legitimately name an already-indexed object in a claim; failing that
  // claim's validation must never take a library item's bytes down with it.
  // On a failed reference check, err on the side of keeping the object.
  const safeRemove = async () => {
    const { data, error } = await supabaseAdmin
      .from('mb_visualizers')
      .select('id')
      .eq('video_url', pub.publicUrl)
      .limit(1)
      .maybeSingle()
    if (error || data) return
    await supabaseAdmin.storage.from(VIDEO_BUCKET).remove([storagePath]).catch(() => {})
  }

  if (parsed.ext === 'mp4') {
    // Validate the head of the object: both client encoders write faststart
    // MP4s, so the moov metadata sits in the first couple of MB. The Range
    // response's Content-Range also tells us the total object size without a
    // second request. Server-to-server fetch — no Railway limits apply.
    let head: Uint8Array
    let totalBytes = 0
    try {
      const res = await fetch(pub.publicUrl, {
        headers: { Range: `bytes=0-${MP4_PROBE_BYTES - 1}` },
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok || !res.body) throw new Error(`fetch ${res.status}`)
      // Total size: Content-Range on a 206; Content-Length when the server
      // ignores Range and answers 200 (Supabase public URLs have exactly that
      // flakiness — it's why audioProxyUrl exists).
      const contentRange = res.headers.get('content-range') // "bytes 0-x/TOTAL"
      totalBytes = contentRange
        ? parseInt(contentRange.split('/')[1] ?? '0', 10)
        : parseInt(res.headers.get('content-length') ?? '0', 10)
      if (Number.isFinite(totalBytes) && totalBytes > MAX_FINALIZE_BYTES) {
        res.body.cancel().catch(() => {})
        await safeRemove()
        return NextResponse.json({ error: 'Video too large' }, { status: 413 })
      }
      // Stream at most the probe window, then hang up — never buffer a
      // Range-ignoring 200's full body (up to the bucket's 500 MB) in memory.
      const chunks: Uint8Array[] = []
      let got = 0
      const reader = res.body.getReader()
      while (got < MP4_PROBE_BYTES) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        got += value.byteLength
      }
      reader.cancel().catch(() => {})
      head = Buffer.concat(chunks)
      if (!totalBytes) totalBytes = got
    } catch {
      // Could not REACH the object — transient storage trouble is not proof
      // of a bad upload, so leave the bytes alone and tell the client to
      // retry the (cheap) finalize call. fx/upload.ts retries 503s.
      return NextResponse.json(
        { error: 'Could not verify the upload. Try again in a moment.' },
        { status: 503, headers: { 'Retry-After': '10' } },
      )
    }

    // Pure-JS demux (mediabunny) instead of ffprobe: no traced binaries, no
    // next.config.ts changes. h264 is required — it's the one codec every
    // surface (web, share, iOS AVPlayer, finalize-video) plays.
    try {
      const { Input, BufferSource, ALL_FORMATS } = await import('mediabunny')
      const input = new Input({ source: new BufferSource(new Uint8Array(head)), formats: ALL_FORMATS })
      const track = await input.getPrimaryVideoTrack()
      if (!track) throw new Error('no video track')
      if (track.codec !== 'avc') throw new Error(`codec ${track.codec}`)
      const duration = await input.computeDuration()
      if (!(duration >= MIN_CLIP_SECONDS)) throw new Error(`duration ${duration}`)
    } catch (err) {
      await safeRemove()
      Sentry.captureException(err, {
        level: 'warning',
        tags: { area: 'visualizer-finalize', phase: 'validate' },
        extra: { projectId, storagePath, totalBytes },
      })
      return NextResponse.json(
        { error: 'Uploaded file is not a playable H.264 MP4 clip.' },
        { status: 400 },
      )
    }

    const stored = await indexVisualizer({
      userId, projectId, storagePath, kind: 'free', title, sourceImageUrl, settings,
    })
    if (!stored) return NextResponse.json({ error: 'Failed to save visualizer' }, { status: 500 })
    return NextResponse.json({ id: stored.id, video_url: stored.video_url, saved: true, transcoded: true })
  }

  // webm: the MediaRecorder fallback path. Download server-to-server and run
  // the exact same webm→mp4 normalization /api/visualizer/save performs, so
  // every stored clip plays on iOS. The original webm object is replaced by
  // the mp4 twin on success; on transcode failure the webm row is indexed
  // as-is (web plays it; the boot heal in visualizer-transcode.ts retries).
  const { data: blob, error: dlError } = await supabaseAdmin.storage
    .from(VIDEO_BUCKET)
    .download(storagePath)
  if (dlError || !blob) {
    // Same retry semantics as the mp4 probe: an unreachable object is not a
    // proven-bad object, so never delete on a failed download.
    return NextResponse.json(
      { error: 'Could not verify the upload. Try again in a moment.' },
      { status: 503, headers: { 'Retry-After': '10' } },
    )
  }
  if (blob.size > MAX_FINALIZE_WEBM_BYTES) {
    await safeRemove()
    return NextResponse.json({ error: 'Video too large' }, { status: 413 })
  }

  const webmBytes = Buffer.from(await blob.arrayBuffer())

  if (!tryAcquireTranscodeSlot()) {
    // Fail fast like the save route: the client is waiting, and the object is
    // still in place — the client retries finalize without re-uploading.
    return NextResponse.json(
      { error: 'Server is busy converting another visualizer. Try again in a moment.' },
      { status: 503, headers: { 'Retry-After': '20' } },
    )
  }
  let mp4Bytes: Buffer | null = null
  try {
    mp4Bytes = await webmToMp4(webmBytes)
  } catch (err) {
    Sentry.captureException(err, {
      level: 'warning',
      tags: { area: 'visualizer-transcode', phase: 'finalize' },
      extra: { projectId, storagePath, sizeBytes: webmBytes.length },
    })
  } finally {
    releaseTranscodeSlot()
  }

  if (mp4Bytes) {
    const stored = await storeVisualizer({
      userId, projectId, bytes: mp4Bytes, contentType: 'video/mp4',
      kind: 'free', title, sourceImageUrl, settings,
    })
    if (!stored) {
      // The mp4 twin's bytes were already cleaned up by storeVisualizer; the
      // raw webm original would otherwise leak unindexed forever.
      await safeRemove()
      return NextResponse.json({ error: 'Failed to save visualizer' }, { status: 500 })
    }
    // The mp4 twin is indexed; the raw webm original is no longer referenced.
    await safeRemove()
    return NextResponse.json({ id: stored.id, video_url: stored.video_url, saved: true, transcoded: true })
  }

  const stored = await indexVisualizer({
    userId, projectId, storagePath, kind: 'free', title, sourceImageUrl, settings,
  })
  if (!stored) return NextResponse.json({ error: 'Failed to save visualizer' }, { status: 500 })
  return NextResponse.json({ id: stored.id, video_url: stored.video_url, saved: true, transcoded: false })
}
