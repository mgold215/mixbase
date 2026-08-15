import { NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import { storeVisualizer, userOwnsProject } from '@/lib/visualizer-store'
import { webmToMp4, tryAcquireTranscodeSlot, releaseTranscodeSlot } from '@/lib/visualizer-encode'
import { isUuid, isSupabaseStorageUrl } from '@/lib/validators'
import { vizSaveLimiter, checkUserLimit, rateLimitHeaders } from '@/lib/rate-limit'
import { clipRejectionReason, sanitizeSettings, type ClipProbe } from '@/lib/visualizer-finalize'

// Allow time to receive the upload, validate it, transcode WebM→MP4, and push
// to storage.
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
//
// DUPLICATED, deliberately and temporarily, from /api/visualizer/finalize. A
// Next route module may only export the HTTP verb handlers plus segment config,
// so neither route can import a helper from the other, and this adapter is the
// one piece the shared lib doesn't already own. The RULES live in
// clipRejectionReason (imported above) precisely so the two lanes cannot drift
// on what "playable" means; scripts/viz-save-test.mjs asserts these two bodies
// stay byte-identical until someone lifts this into src/lib/.
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

// POST /api/visualizer/save — persist a client-rendered (free) visualizer so it
// shows up in the Media library. The AI path persists server-side in
// /api/visualizer/runway; this is the multipart entry point for the browser's
// canvas-recorded WebM blob.
//
// ── Exit table ───────────────────────────────────────────────────────────────
// Unlike /api/visualizer/finalize, this lane never has bytes resident in the
// bucket at a failure exit: the clip arrives in the request body and the ONLY
// write is the storeVisualizer() call at the very bottom, which removes its own
// object if the mb_visualizers insert fails. So no exit here needs a delete —
// but that argument holds only while this route performs no storage write of
// its own, which viz-save-test.mjs locks down.
//
// What each exit costs the caller, in order:
//   401 not authenticated  — no credit charged (the limiter runs below), no bytes
//   429 over the cap       — credit charged by definition, no bytes
//   400 bad form / no file / bad projectId, 404 not your project, 413 too large
//                          — credit KEPT: the body was already received and
//                            buffered, which is the expensive part of this lane
//   400 unplayable clip    — credit KEPT: receiving up to 10 MB and demuxing it
//                            is real work, and the cap is the only thing
//                            bounding a client that loops on it
//   503 encoder busy       — credit KEPT, same reason (it fires after the body
//                            landed). Refunding it would make the route's most
//                            expensive path free to loop.
//   500 store failed       — credit REFUNDED: our fault, and the save the
//                            credit paid for never happened. Not loopable for
//                            free — nothing a client sends can force it.
export async function POST(req: NextRequest) {
  const userId = req.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  // This route forks libx264 (see the transcode below), so it is CPU work, not
  // bookkeeping — it needs the same per-user cap the other video routes carry.
  //
  // Charged BEFORE the body is read, which is the opposite of finalize's
  // ownership-first ordering and is deliberate: there the claim is a few
  // hundred bytes of JSON, here req.formData() buffers the entire multipart
  // payload before a single field can be inspected. A limiter behind that gate
  // would not be a limiter at all.
  const limit = await checkUserLimit(vizSaveLimiter, userId)
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Too many visualizer saves. Try again shortly.' },
      { status: 429, headers: rateLimitHeaders(limit) },
    )
  }

  const form = await req.formData().catch(() => null)
  if (!form) return NextResponse.json({ error: 'Invalid form data' }, { status: 400 })

  const file = form.get('file')
  const projectId = String(form.get('projectId') ?? '')
  const title = String(form.get('title') ?? 'Visualizer').slice(0, 200)
  // The poster reference is the one client-supplied URL we persist. Only keep it
  // if it's a real Supabase Storage URL (the sole shape a legit artwork URL
  // takes) — mirrors the runway path's imageUrl allowlist and the
  // audio_url/artwork_url write guards, so no off-host URL ever lands in a
  // stored, later-rendered field. Anything else is dropped to null.
  const sourceImageUrl = isSupabaseStorageUrl(form.get('sourceImageUrl'))
    ? String(form.get('sourceImageUrl'))
    : null
  // Optional FX-engine recipe (JSON string) — validated to a canonical
  // VizRecipe or dropped; never fails the save.
  const settings = (() => {
    const raw = form.get('settings')
    if (typeof raw !== 'string' || raw.length > 32_768) return null
    try {
      return sanitizeSettings(JSON.parse(raw))
    } catch {
      return null
    }
  })()

  if (!(file instanceof Blob)) return NextResponse.json({ error: 'file is required' }, { status: 400 })
  if (!isUuid(projectId)) return NextResponse.json({ error: 'Valid projectId is required' }, { status: 400 })
  if (!(await userOwnsProject(userId, projectId))) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  // Free renders are small (1/4-scale WebM), but stay under Railway's 10 MB proxy
  // wall regardless — larger clips would be silently truncated in transit.
  if (file.size > 10 * 1024 * 1024) {
    return NextResponse.json({ error: 'Video too large to save (max 10 MB).' }, { status: 413 })
  }

  let bytes: Buffer = Buffer.from(await file.arrayBuffer())
  let contentType = file.type || 'video/webm'
  // Which rule set the bytes must satisfy, fixed before the transcode rewrites
  // contentType. Mirrors finalize's extension dispatch: a webm carries
  // vp8/vp9/av1 by construction so only the EXISTENCE of a video track is
  // required (the mp4 twin below is what reaches iOS), while anything we store
  // WITHOUT transcoding has to be H.264 to play on every surface.
  const probeExt: 'mp4' | 'webm' = contentType.includes('webm') ? 'webm' : 'mp4'

  // Content validation — the gate this lane never had. Its only check was
  // file.size, so a 0-byte MediaRecorder blob (chunks empty because
  // 'dataavailable' never fired) was stored and announced as "Saved to Media"
  // with a live pin button. /api/visualizer/finalize closed exactly this hole
  // on the signed-URL lane on 2026-08-14; the same blob still walked in through
  // this door — and FreeStudio.saveRendered falls back HERE the moment finalize
  // rejects a webm under 9.5 MB, so the hardened lane was handing the garbage
  // straight to the weak one.
  //
  // Runs BEFORE the transcode slot and BEFORE storeVisualizer: junk must never
  // occupy one of the two encoder slots, and must never reach the bucket. It
  // also runs after the size cap, which is what bounds the demux.
  //
  // The credit is deliberately not refunded — see the exit table above.
  try {
    const reason = clipRejectionReason(await probeClip(bytes), probeExt)
    if (reason) throw new Error(reason)
  } catch (err) {
    Sentry.captureException(err, {
      level: 'warning',
      tags: { area: 'visualizer-save', phase: 'validate' },
      extra: { projectId, sizeBytes: bytes.length, contentType },
    })
    return NextResponse.json(
      { error: 'Uploaded file is not a playable video clip.' },
      { status: 400 },
    )
  }

  // Browsers record the free visualizer as WebM, which iOS AVPlayer cannot
  // decode — so normalize to H.264 MP4 at save time and every surface (web
  // player, share page, native app, finalize-video) plays the same file. If
  // the transcode fails, store the WebM as before: web keeps working and the
  // boot heal (visualizer-transcode.ts) retries the conversion later.
  let transcoded = true
  if (contentType.includes('webm')) {
    if (!tryAcquireTranscodeSlot()) {
      // Fail fast rather than queueing: the client is waiting on this request,
      // and piling encoders up is exactly what the gate exists to prevent.
      return NextResponse.json(
        { error: 'Server is busy converting another visualizer. Try again in a moment.' },
        { status: 503, headers: { 'Retry-After': '20' } },
      )
    }
    try {
      bytes = await webmToMp4(bytes)
      contentType = 'video/mp4'
    } catch (err) {
      // Storing the WebM keeps the web player working, so this is a real
      // fallback rather than a failure — and it is only SAFE as a fallback
      // because the probe above already proved these bytes are a playable
      // clip. Before that gate existed this catch was the back door: ffmpeg
      // failed a 0-byte blob with "EBML header parsing failed", the failure was
      // swallowed as a mere transcode miss, and the garbage got stored anyway.
      // The saved loop will still NOT play on iOS until the boot heal retries
      // it, though, and the user is told "Saved". That silent divergence is
      // invisible in console.error alone (there is no
      // captureConsoleIntegration), so report it.
      transcoded = false
      Sentry.captureException(err, {
        level: 'warning',
        tags: { area: 'visualizer-transcode', phase: 'save' },
        extra: { projectId, sizeBytes: bytes.length },
      })
      console.error('[visualizer/save] webm→mp4 transcode failed, storing webm:',
        err instanceof Error ? err.message : err)
    } finally {
      releaseTranscodeSlot()
    }
  }

  const stored = await storeVisualizer({
    userId,
    projectId,
    bytes,
    contentType,
    kind: 'free',
    title,
    sourceImageUrl,
    settings,
  })
  if (!stored) {
    // Our failure, not the caller's. storeVisualizer already removed whatever
    // it managed to upload before the row insert failed, so nothing is
    // orphaned — but the save this credit paid for never happened, so give it
    // back. Matches finalize's `{ refund: true }` on the same exit, and is not
    // loopable for free: no request a client can send forces a storage/DB
    // failure.
    vizSaveLimiter.rollback(userId)
    return NextResponse.json({ error: 'Failed to save visualizer' }, { status: 500 })
  }

  // `transcoded: false` means the stored loop is still WebM and will not play
  // on iOS until the boot heal converts it. Reported so the client can say so
  // instead of a flat "Saved".
  return NextResponse.json({ id: stored.id, video_url: stored.video_url, saved: true, transcoded })
}
