import { NextRequest, NextResponse } from 'next/server'
import sharp from 'sharp'
import { cassetteStudioLimiter, checkUserLimit, rateLimitHeaders } from '@/lib/rate-limit'
import { cutOut, readPhoto, removeStudio, studioPrefix, uploadStudio, StudioUnavailable } from '@/lib/cassette-server'
import { seeThrough, trimSubject } from '@/lib/cassette-studio'

export const runtime = 'nodejs'
export const maxDuration = 120

// POST /api/cassette-studio/subject   (multipart: photo)
//
// Turns a photo of the artist's cassette into a reusable cut-out:
//   1. normalise (EXIF rotation, ≤2400px) and stash it as a temp public file
//      — Replicate fetches inputs by URL;
//   2. background removal (src/lib/cassette-server.ts cutOut);
//   3. clear-plastic recovery (seeThrough) so the shell shows the NEW scene
//      instead of whatever was behind it in the photo;
//   4. trim + save as studio/<userId>/subject-<ts>.png.
// Done once per cassette; every render after that reuses it for free.
export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const limit = await checkUserLimit(cassetteStudioLimiter, userId)
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded. Try again later.' }, { status: 429, headers: rateLimitHeaders(limit) })
  }

  const form = await request.formData().catch(() => null)
  if (!form) return NextResponse.json({ error: 'Invalid upload' }, { status: 400 })
  const photo = await readPhoto(form, 'photo')
  if (typeof photo === 'string') return NextResponse.json({ error: photo }, { status: 400 })

  let normalised: Buffer
  try {
    normalised = await sharp(photo).rotate().removeAlpha()
      .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 93 })
      .toBuffer()
  } catch {
    return NextResponse.json({ error: 'Could not read that photo — try a JPEG or PNG.' }, { status: 400 })
  }

  const ts = Date.now()
  const tmpPath = `${studioPrefix(userId)}tmp-${ts}-photo.jpg`
  try {
    const tmpUrl = await uploadStudio(tmpPath, normalised, 'image/jpeg')
    const cut = await cutOut(tmpUrl)
    // The cut-out model may return a different size than it was given; the
    // see-through pass needs photo and matte pixel-aligned, so match them.
    const meta = await sharp(normalised).metadata()
    const cutAligned = await sharp(cut).ensureAlpha().resize(meta.width, meta.height, { fit: 'fill' }).png().toBuffer()
    const clear = await seeThrough(normalised, cutAligned)
    const subject = await trimSubject(clear)
    const path = `${studioPrefix(userId)}subject-${ts}.png`
    const url = await uploadStudio(path, subject.png, 'image/png')
    return NextResponse.json({ subject: { path, url, createdAt: new Date(ts).toISOString() } })
  } catch (err) {
    if (err instanceof StudioUnavailable) {
      console.error('[cassette-studio] subject:', err.message)
      return NextResponse.json({ error: 'Cassette cut-out is temporarily unavailable.' }, { status: 503 })
    }
    console.error('[cassette-studio] subject failed:', err instanceof Error ? err.message : err)
    const msg = err instanceof Error && err.message.startsWith('Could not find') ? err.message : 'Could not cut out the cassette. Try a photo with the cassette clearly in frame.'
    return NextResponse.json({ error: msg }, { status: 502 })
  } finally {
    await removeStudio([tmpPath])
  }
}
