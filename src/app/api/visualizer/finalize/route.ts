import { NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import { supabaseAdmin } from '@/lib/supabase'
import { indexVisualizer, indexedVisualizerAt, storeVisualizer, userOwnsProject, VIDEO_BUCKET } from '@/lib/visualizer-store'
import { removeStorageObjectsLogged } from '@/lib/storage-remove'
import { webmToMp4, mp4TwinPath, tryAcquireTranscodeSlot, releaseTranscodeSlot } from '@/lib/visualizer-encode'
import { isUuid, isSupabaseStorageUrl } from '@/lib/validators'
import { vizSaveLimiter, checkUserLimit, rateLimitHeaders } from '@/lib/rate-limit'
import {
  MP4_PROBE_BYTES,
  clipRejectionReason,
  maxFinalizeBytesFor,
  parseVizStoragePath,
  sanitizeSettings,
  totalBytesFromHeaders,
  type ClipProbe,
} from '@/lib/visualizer-finalize'

// Allow time to validate (mp4) or download + transcode (webm) and index.
export const maxDuration = 60

// Read the container metadata out of a clip's bytes with mediabunny — a pure-JS
// demux, so no ffprobe binary has to be traced into the Railway bundle (see the
// outputFileTracingIncludes note in next.config.ts for how fragile that is).
//
// Throws when the bytes are not a recognizable container AT ALL, and that throw
// is itself a rejection the callers rely on: MediaRecorder hands back a 0-byte
// Blob when 'dataavailable' never fires, and nothing downstream notices in time
// — ffmpeg dies with "EBML header parsing failed", which the webm lane used to
// treat as a mere transcode miss before storing the garbage anyway.
async function probeClip(bytes: Uint8Array): Promise<ClipProbe> {
  const { Input, BufferSource, ALL_FORMATS } = await import('mediabunny')
  // Copy into a plain Uint8Array rather than passing the Buffer through: a
  // Node Buffer can be a view into a larger pooled ArrayBuffer, and anything
  // downstream that reaches for `.buffer` without honouring byteOffset would
  // read the wrong bytes. Bounded by the size gates each lane runs first.
  const input = new Input({ source: new BufferSource(new Uint8Array(bytes)), formats: ALL_FORMATS })
  const track = await input.getPrimaryVideoTrack()
  return { codec: track?.codec ?? null, duration: await input.computeDuration() }
}

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

  // ── Ownership first, rate limit second ────────────────────────────────────
  // This order is load-bearing in both directions. An object may only be
  // deleted once its key has been proven to sit under a project THIS caller
  // owns, so every gate that establishes that has to run before any exit that
  // wants to clean up. And a claim we reject as malformed must not cost the
  // user one of their 20 saves/hour — nothing was uploaded on our account, and
  // nothing was computed.
  const body = await req.json().catch(() => null) as {
    projectId?: unknown
    storagePath?: unknown
    title?: unknown
    settings?: unknown
    sourceImageUrl?: unknown
    abandonedPaths?: unknown
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

  // Delete an object ONLY if no mb_visualizers row references it. All stored
  // clips — including finished youtube/shorts renders and pinned loops —
  // share the `{projectId}/viz-*.{ext}` key shape, so an owner can
  // legitimately name an already-indexed object in a claim; failing that
  // claim's validation must never take a library item's bytes down with it.
  // On a failed reference check, err on the side of keeping the object.
  //
  // The delete goes through removeStorageObjectsLogged() rather than
  // storage.remove() directly: a remove refused by storage RLS is NOT an error
  // — the policy matches no rows and the API answers 200 with `[]` — so a
  // cleanup that only checks `error` reports success while the bytes stay
  // public. That is what turned every "the bytes go with the rejected claim"
  // guarantee in this route into a no-op in production.
  const removeIfUnreferenced = async (key: string) => {
    const { data: keyPub } = supabaseAdmin.storage.from(VIDEO_BUCKET).getPublicUrl(key)
    const { data, error } = await supabaseAdmin
      .from('mb_visualizers')
      .select('id')
      .eq('video_url', keyPub.publicUrl)
      .limit(1)
      .maybeSingle()
    if (error || data) return
    await removeStorageObjectsLogged(VIDEO_BUCKET, [key], 'visualizer-finalize discard')
  }

  const safeRemove = () => removeIfUnreferenced(storagePath)

  // Keys the client signed but abandoned mid-upload. fx/upload.ts retries a
  // failed PUT against a FRESH key rather than replaying the spent signed URL
  // (signing with `upsert` would stamp overwrite authorization into the token —
  // deliberately not done, see /api/upload-url), so when the first PUT actually
  // delivered its bytes and only the response was lost, that first object is
  // real, unreferenced, and unreachable by every other cleanup path. The client
  // reports those keys here so the same reference-checked delete that protects
  // the claimed object also collects them. Each is re-validated against THIS
  // caller's owned project — an abandoned key is not a licence to name
  // someone else's object — and the list is capped, since a legitimate client
  // abandons at most one key per save.
  const abandonedPaths = (Array.isArray(body.abandonedPaths) ? body.abandonedPaths : [])
    .slice(0, 4)
    .filter((p): p is string => typeof p === 'string' && p !== storagePath && !!parseVizStoragePath(projectId, p))

  // Swept before the claim is processed, and awaited rather than fired into the
  // background: the response ends the request on Railway, and an unawaited
  // delete can be cut off with the bytes still there.
  for (const key of abandonedPaths) await removeIfUnreferenced(key)

  // ── The two failure exits ─────────────────────────────────────────────────
  // Every non-2xx return below goes through one of these, because the choice
  // between them is the whole safety property of this route.
  //
  // discardAndFail: the claim is definitively rejected, so the bytes must go
  // with it. The signed PUT lands the object BEFORE this JSON claim indexes
  // it, so any failure exit that just returns leaves a file sitting in the
  // PUBLIC mf-video bucket with no mb_visualizers row pointing at it — which
  // is invisible in Media, undeletable through DELETE /api/visualizer/[id]
  // (that route derives its storage key from video_url), and missed by
  // /api/auth/delete-account. That is the GDPR-delete leak class
  // webmOriginalPath() was written to close on 2026-08-04; it must not
  // reappear through the back door of an early return.
  //
  // `refund` gives back the rate-limit credit when the failure is OURS (a DB
  // insert that didn't land) rather than the caller's. A rejected-as-bad claim
  // deliberately keeps its credit: the probe fetch and demux are real work,
  // and the limiter is the only thing bounding a client that loops on them.
  const discardAndFail = async (
    error: string,
    status: number,
    opts?: { refund?: boolean; headers?: Record<string, string> },
  ) => {
    if (opts?.refund) vizSaveLimiter.rollback(userId)
    await safeRemove()
    return NextResponse.json({ error }, { status, headers: opts?.headers })
  }

  // retryLater: we could not REACH or MEASURE the object, or the encoder was
  // busy. None of that is proof of a bad upload, and fx/upload.ts retries a
  // 503 without re-uploading — so the bytes stay exactly where they are. The
  // credit comes back by default, otherwise the client's own three-attempt
  // retry loop would spend three of the user's twenty hourly saves on one
  // save that never happened.
  //
  // `refund: false` is for the one 503 that fires AFTER real work: the busy
  // encoder is rejected only once the webm has been downloaded into memory and
  // demuxed. Refunding that would leave the most expensive path in the route
  // costing nothing, and a client looping on it could hold repeated 48 MB
  // allocations in the shared container forever with the limiter never moving.
  const retryLater = (error: string, retryAfterSec: string, opts?: { refund?: boolean }) => {
    if (opts?.refund !== false) vizSaveLimiter.rollback(userId)
    return NextResponse.json({ error }, { status: 503, headers: { 'Retry-After': retryAfterSec } })
  }

  // Same cap as the multipart save path — this is the same logical operation.
  const limit = await checkUserLimit(vizSaveLimiter, userId)
  if (!limit.allowed) {
    // The object is already in the bucket and this claim is the only thing
    // that would ever have indexed it, so a rate-limited claim orphans the
    // bytes unless they go now. The client does not retry a 429.
    return await discardAndFail('Too many visualizer saves. Try again shortly.', 429, {
      headers: rateLimitHeaders(limit),
    })
  }

  if (parsed.ext === 'mp4') {
    // Validate the head of the object: both client encoders write faststart
    // MP4s, so the moov metadata sits in the first couple of MB. The Range
    // response's Content-Range also tells us the total object size without a
    // second request. Server-to-server fetch — no Railway limits apply.
    let head: Buffer
    let totalBytes = 0
    try {
      const res = await fetch(pub.publicUrl, {
        headers: { Range: `bytes=0-${MP4_PROBE_BYTES - 1}` },
        signal: AbortSignal.timeout(30_000),
      })
      // A 0-byte object cannot satisfy ANY byte range and answers 416 Range
      // Not Satisfiable. That is a measurement — the object is empty — not a
      // transport failure, so reject it here. Letting the blanket catch below
      // turn it into a 503 would put the client through three pointless
      // retries and leave the empty object sitting orphaned in the bucket.
      if (res.status === 416) {
        res.body?.cancel().catch(() => {})
        return await discardAndFail('Uploaded file is not a playable H.264 MP4 clip.', 400)
      }
      if (!res.ok || !res.body) throw new Error(`fetch ${res.status}`)
      const measuredBytes = totalBytesFromHeaders(res.headers)
      // An UNMEASURABLE object is not a small one. The previous inline parse
      // fell back to 0 when the response carried neither Content-Range nor
      // Content-Length, and `0 > MAX_FINALIZE_BYTES` is false — so the cap
      // silently didn't apply. Fail it the same way an unreachable object
      // fails: retryable, bytes untouched, no guessing.
      if (measuredBytes === null) {
        res.body.cancel().catch(() => {})
        throw new Error('object size unknown')
      }
      if (measuredBytes > maxFinalizeBytesFor('mp4')) {
        res.body.cancel().catch(() => {})
        return await discardAndFail('Video too large', 413)
      }
      totalBytes = measuredBytes
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
    } catch {
      // Could not REACH the object — transient storage trouble is not proof
      // of a bad upload, so leave the bytes alone and tell the client to
      // retry the (cheap) finalize call. fx/upload.ts retries 503s.
      return retryLater('Could not verify the upload. Try again in a moment.', '10')
    }

    // h264 is required — it's the one codec every surface (web, share, iOS
    // AVPlayer, finalize-video) plays. clipRejectionReason owns that rule so
    // the webm lane below runs the same gate rather than its own weaker one.
    try {
      const reason = clipRejectionReason(await probeClip(head), 'mp4')
      if (reason) throw new Error(reason)
    } catch (err) {
      Sentry.captureException(err, {
        level: 'warning',
        tags: { area: 'visualizer-finalize', phase: 'validate' },
        extra: { projectId, storagePath, totalBytes },
      })
      return await discardAndFail('Uploaded file is not a playable H.264 MP4 clip.', 400)
    }

    const stored = await indexVisualizer({
      userId, projectId, storagePath, kind: 'free', title, sourceImageUrl, settings,
    })
    // Our failure, not the caller's: refund the credit, but still take the
    // bytes down — nothing else will ever index them.
    if (!stored) return await discardAndFail('Failed to save visualizer', 500, { refund: true })
    return NextResponse.json({ id: stored.id, video_url: stored.video_url, saved: true, transcoded: true })
  }

  // webm: the MediaRecorder fallback path. Download server-to-server and run
  // the exact same webm→mp4 normalization /api/visualizer/save performs, so
  // every stored clip plays on iOS. The original webm object is replaced by
  // the mp4 twin on success; on transcode failure the webm row is indexed
  // as-is (web plays it; the boot heal in visualizer-transcode.ts retries).

  // ── Has this exact claim already succeeded? ───────────────────────────────
  // Unlike the mp4 lane, this one MOVES the object: the success path writes a
  // separate mp4 twin and then deletes the webm the claim names. So a replayed
  // claim — fx/upload.ts re-POSTs whenever the response is lost, deliberately —
  // arrives naming an object that no longer exists. Every probe below then
  // reads "unreachable", which is a 503; the client burns its three retries and
  // gives up; and FreeStudio falls back to the legacy multipart save, which
  // uploads the SAME video a second time and writes a SECOND row. The user ends
  // up with a duplicate in Media over duplicate bytes — the exact outcome
  // fx/upload.ts's retry loop and migration 033 were built to prevent, reached
  // by the one lane whose key changes underneath the claim.
  //
  // Nothing needs to be recorded to undo that, because the twin's key is
  // DERIVED from the claimed key (mp4TwinPath, the WebM→MP4 heal's own
  // convention) rather than freshly stamped. Both possible outcomes of a first
  // claim are therefore addressable from the claim alone: the twin if the
  // transcode succeeded, the original if it did not. Either hit is answered
  // with the row that claim already produced — the same success the lost
  // response carried — before any download, transcode or insert happens.
  const twinPath = mp4TwinPath(storagePath)
  const storedTwin = await indexedVisualizerAt(twinPath, userId)
  if (storedTwin) {
    return NextResponse.json({ id: storedTwin.id, video_url: storedTwin.video_url, saved: true, transcoded: true })
  }
  // The transcode-failure outcome: the row points at the webm itself, which is
  // still in place. Re-transcoding here would succeed on a good day and write a
  // SECOND row beside the first — so hand back the row that exists and let the
  // boot heal convert it, exactly as that path already promises.
  const storedOriginal = await indexedVisualizerAt(storagePath, userId)
  if (storedOriginal) {
    return NextResponse.json({ id: storedOriginal.id, video_url: storedOriginal.video_url, saved: true, transcoded: false })
  }

  // MEASURE BEFORE DOWNLOADING. supabaseAdmin.storage.download() buffers the
  // ENTIRE object and only then exposes .size, so checking the cap afterwards
  // was no cap at all: the bucket ceiling is 500 MB, and an owner claiming a
  // large webm could allocate all of it inside the shared Railway container
  // and OOM the app for every user. A one-byte Range probe answers the same
  // question for free, through the same header parser the mp4 lane uses.
  let webmTotalBytes: number | null = null
  let webmIsEmpty = false
  try {
    const res = await fetch(pub.publicUrl, {
      headers: { Range: 'bytes=0-0' },
      signal: AbortSignal.timeout(30_000),
    })
    res.body?.cancel().catch(() => {})
    // 416 = the object is 0 bytes (nothing can satisfy `bytes=0-0`). That is a
    // measurement, not a transport failure — and it is the likeliest bad
    // upload on this lane, since MediaRecorder hands back an empty Blob
    // whenever 'dataavailable' never fired.
    if (res.status === 416) webmIsEmpty = true
    else if (res.ok) webmTotalBytes = totalBytesFromHeaders(res.headers)
  } catch {
    // Unreachable — falls into the same "could not measure" branch below.
  }
  if (webmIsEmpty) {
    return await discardAndFail('Uploaded file is not a playable video clip.', 400)
  }
  if (webmTotalBytes === null) {
    return retryLater('Could not verify the upload. Try again in a moment.', '10')
  }
  if (webmTotalBytes > maxFinalizeBytesFor('webm')) {
    return await discardAndFail('Video too large', 413)
  }

  const { data: blob, error: dlError } = await supabaseAdmin.storage
    .from(VIDEO_BUCKET)
    .download(storagePath)
  if (dlError || !blob) {
    // Same retry semantics as the size probe: an unreachable object is not a
    // proven-bad object, so never delete on a failed download.
    return retryLater('Could not verify the upload. Try again in a moment.', '10')
  }
  // Cross-check the measurement against what actually arrived. The probe and
  // the download are two separate requests, and this is the only bound on what
  // the 60 s-SIGKILL transcoder is about to be handed.
  if (blob.size > maxFinalizeBytesFor('webm')) {
    return await discardAndFail('Video too large', 413)
  }

  const webmBytes = Buffer.from(await blob.arrayBuffer())

  // Content validation, which this lane never had: its only gate was
  // blob.size, so a 0-byte or corrupt blob was indexed and reported "Saved"
  // to the user. Runs BEFORE the transcode slot so junk can never occupy one
  // of the two encoder slots, and rejects with the same delete-and-400 the
  // mp4 lane uses. The codec is only required to EXIST here — a webm carries
  // vp8/vp9/av1 by construction, and it is the mp4 twin below that reaches
  // iOS.
  try {
    const reason = clipRejectionReason(await probeClip(webmBytes), 'webm')
    if (reason) throw new Error(reason)
  } catch (err) {
    Sentry.captureException(err, {
      level: 'warning',
      tags: { area: 'visualizer-finalize', phase: 'validate' },
      extra: { projectId, storagePath, totalBytes: webmBytes.length },
    })
    return await discardAndFail('Uploaded file is not a playable video clip.', 400)
  }

  if (!tryAcquireTranscodeSlot()) {
    // Fail fast like the save route: the client is waiting, and the object is
    // still in place — the client retries finalize without re-uploading. This
    // one keeps its rate-limit credit: by here the object has been measured,
    // downloaded and demuxed, and that work is what the cap exists to bound.
    return retryLater(
      'Server is busy converting another visualizer. Try again in a moment.',
      '20',
      { refund: false },
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
    // `path` is what makes a replay resolvable: the twin lands on a key this
    // claim can recompute, not on a fresh timestamp only the first response
    // ever knew.
    const stored = await storeVisualizer({
      userId, projectId, bytes: mp4Bytes, contentType: 'video/mp4',
      kind: 'free', title, sourceImageUrl, settings, path: twinPath,
    })
    if (!stored) {
      // Two claims genuinely in flight together both pass the check at the top
      // of this lane and both transcode; one wins the twin key. The loser must
      // NOT report failure — the client would fall back to the legacy save and
      // duplicate the very video the winner just stored — and must not take any
      // bytes down with it. Ask once more, now that the winner's row exists.
      const won = await indexedVisualizerAt(twinPath, userId)
      if (won) {
        await safeRemove()
        return NextResponse.json({ id: won.id, video_url: won.video_url, saved: true, transcoded: true })
      }
      // The mp4 twin's bytes were already cleaned up by storeVisualizer; the
      // raw webm original would otherwise leak unindexed forever.
      return await discardAndFail('Failed to save visualizer', 500, { refund: true })
    }
    // The mp4 twin is indexed; the raw webm original is no longer referenced.
    await safeRemove()
    return NextResponse.json({ id: stored.id, video_url: stored.video_url, saved: true, transcoded: true })
  }

  const stored = await indexVisualizer({
    userId, projectId, storagePath, kind: 'free', title, sourceImageUrl, settings,
  })
  if (!stored) return await discardAndFail('Failed to save visualizer', 500, { refund: true })
  return NextResponse.json({ id: stored.id, video_url: stored.video_url, saved: true, transcoded: false })
}
