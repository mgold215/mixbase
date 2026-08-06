import { NextRequest, NextResponse } from 'next/server'
import { storeVisualizer, userOwnsProject } from '@/lib/visualizer-store'
import {
  renderFreeVisualizer, tryAcquireTranscodeSlot, releaseTranscodeSlot,
  FREE_FORMATS, FREE_EFFECTS, isFreeFormat, isFreeEffect,
} from '@/lib/visualizer-encode'
import { isUuid, isSupabaseStorageUrl } from '@/lib/validators'
import { freeRenderLimiter, checkUserLimit, rateLimitHeaders } from '@/lib/rate-limit'

// Download the artwork + render up to 30s of 1080p + push to storage. Advisory
// on Railway (plain `next start`), like the other video routes.
export const maxDuration = 300

// The artwork fetch gets its own deadline — undici has no response timeout of
// its own, and a stalled storage read must not pin the handler.
const IMAGE_TIMEOUT_MS = 30_000
// Artwork is a cover image; anything past this is not artwork.
const MAX_IMAGE_BYTES = 50 * 1024 * 1024

// GET /api/visualizer/free — the formats and effects this renderer offers, so
// clients (the iOS app today) stay current without hardcoding.
export async function GET() {
  return NextResponse.json({
    formats: Object.entries(FREE_FORMATS).map(([id, f]) => ({ id, ...f })),
    effects: Object.entries(FREE_EFFECTS).map(([id, e]) => ({ id, ...e })),
  })
}

// POST /api/visualizer/free — server-side free visualizer render. The web free
// generator records a browser canvas, which iOS (native app and Safari alike)
// cannot do — this renders the same artwork-to-motion-loop idea with ffmpeg so
// every client has a free path. No monthly tier gate on purpose: the web
// equivalent is free and unlimited, so the hourly limiter + encoder gate are
// the protection here, matching /api/visualizer/save's posture.
export async function POST(req: NextRequest) {
  const userId = req.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const limit = await checkUserLimit(freeRenderLimiter, userId)
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Too many free renders this hour. Try again shortly.' },
      { status: 429, headers: rateLimitHeaders(limit) },
    )
  }

  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  const { projectId, imageUrl, format, effect, bpm } = body as Record<string, unknown>

  if (!isUuid(projectId)) return NextResponse.json({ error: 'Valid projectId is required' }, { status: 400 })
  // Same allowlist as the runway path: only a Supabase Storage URL is a
  // legitimate artwork source, and it keeps this route from fetching arbitrary
  // hosts server-side (SSRF) or persisting an off-host poster URL.
  if (!isSupabaseStorageUrl(imageUrl)) {
    return NextResponse.json({ error: 'imageUrl must be a Supabase storage URL' }, { status: 400 })
  }
  if (!isFreeFormat(format)) return NextResponse.json({ error: 'Unknown format' }, { status: 400 })
  if (!isFreeEffect(effect)) return NextResponse.json({ error: 'Unknown effect' }, { status: 400 })
  if (!(await userOwnsProject(userId, projectId))) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  // Fetch the artwork BEFORE taking an encoder slot — a slow storage read must
  // not sit on one of the two slots while doing no encoding.
  let img: Buffer
  try {
    const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) })
    if (!imgRes.ok) {
      return NextResponse.json({ error: 'Could not load the artwork image' }, { status: 502 })
    }
    img = Buffer.from(await imgRes.arrayBuffer())
  } catch {
    return NextResponse.json({ error: 'Could not load the artwork image' }, { status: 502 })
  }
  if (img.length === 0 || img.length > MAX_IMAGE_BYTES) {
    return NextResponse.json({ error: 'Artwork image is empty or too large' }, { status: 400 })
  }

  // Same 2-slot encoder gate as the WebM transcode: the limiter caps how often
  // one user asks, this caps how many encoders run at once on the shared box.
  if (!tryAcquireTranscodeSlot()) {
    return NextResponse.json(
      { error: 'Server is busy rendering another visualizer. Try again in a moment.' },
      { status: 503, headers: { 'Retry-After': '30' } },
    )
  }

  let bytes: Buffer
  try {
    bytes = await renderFreeVisualizer(img, {
      format,
      effect,
      bpm: typeof bpm === 'number' ? bpm : undefined,
    })
  } catch (err) {
    console.error('[visualizer/free] render failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Render failed. Try again.' }, { status: 502 })
  } finally {
    releaseTranscodeSlot()
  }

  const stored = await storeVisualizer({
    userId,
    projectId,
    bytes,
    contentType: 'video/mp4',
    kind: 'free',
    title: `${FREE_FORMATS[format].label} · ${FREE_EFFECTS[effect].label}`,
    sourceImageUrl: imageUrl,
  })
  if (!stored) return NextResponse.json({ error: 'Failed to save visualizer' }, { status: 500 })

  return NextResponse.json({ id: stored.id, video_url: stored.video_url, saved: true })
}
