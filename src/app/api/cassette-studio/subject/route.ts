import { NextRequest, NextResponse } from 'next/server'
import sharp from 'sharp'
import { supabaseAdmin } from '@/lib/supabase'
import { isJsonObject } from '@/lib/validators'
import { cassetteStudioLimiter, checkUserLimit, rateLimitHeaders } from '@/lib/rate-limit'
import { isAdminIdentity } from '@/lib/admin-identity'
import {
  cutOut, downloadStudio, findStudioObject, readPhoto, removeStudio, studioPrefix, uploadStudio, StudioUnavailable,
  MAX_SOURCE_BYTES,
} from '@/lib/cassette-server'
import { parseSourcePath, seeThrough, trimSubject } from '@/lib/cassette-studio'

export const runtime = 'nodejs'
export const maxDuration = 120

// POST /api/cassette-studio/subject
//   multipart { photo }                      a new photo from the device, or
//   JSON      { source_path: "<projectId>/<file>" }  an image already in mixBase
//                                            (one of the caller's projects' artwork,
//                                            listed by /api/cassette-studio/photos)
//
// Turns a photo of the artist's cassette into a reusable cut-out:
//   1. normalise (EXIF rotation, ≤2400px) and stash it as a temp public file
//      — Replicate fetches inputs by URL;
//   2. background removal (src/lib/cassette-server.ts cutOut);
//   3. clear-plastic recovery (seeThrough) so the shell shows the NEW scene
//      instead of whatever was behind it in the photo;
//   4. trim + save as studio/<userId>/subject-<ts>.png.
// Done once per cassette; every render after that reuses it for free.
//
// source_path is a client-supplied key, so it is pinned three ways before a
// byte is read: its SHAPE (parseSourcePath — canonical project uuid, one plain
// image file name, no '..'), the PROJECT (mb_projects row owned by the
// X-User-Id caller), and the OBJECT (it exists, ≤ MAX_SOURCE_BYTES). It is
// then read from Storage by key — never fetched as a URL.
// Owner-only (404 otherwise) — see src/app/api/cassette-studio/route.ts.
export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!(await isAdminIdentity(userId))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const limit = await checkUserLimit(cassetteStudioLimiter, userId)
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded. Try again later.' }, { status: 429, headers: rateLimitHeaders(limit) })
  }

  let photo: Buffer
  if ((request.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) {
    const body = await request.json().catch(() => null)
    if (!isJsonObject(body)) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    const source = await readSourcePhoto(userId, body.source_path)
    if (source instanceof NextResponse) return source
    photo = source
  } else {
    const form = await request.formData().catch(() => null)
    if (!form) return NextResponse.json({ error: 'Invalid upload' }, { status: 400 })
    const upload = await readPhoto(form, 'photo')
    if (typeof upload === 'string') return NextResponse.json({ error: upload }, { status: 400 })
    photo = upload
  }

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

/** The bytes of a photo already in mixBase, or the response refusing it. */
async function readSourcePhoto(userId: string, value: unknown): Promise<Buffer | NextResponse> {
  const source = parseSourcePath(value)
  if (!source) return NextResponse.json({ error: 'Choose one of your photos.' }, { status: 400 })

  const { data: project } = await supabaseAdmin
    .from('mb_projects').select('id').eq('id', source.projectId).eq('user_id', userId).single()
  if (!project) return NextResponse.json({ error: 'Photo not found' }, { status: 404 })

  let bytes: Buffer
  try {
    const found = await findStudioObject(source.path)
    if (!found) return NextResponse.json({ error: 'That photo is no longer in mixBase.' }, { status: 404 })
    if (found.size !== null && found.size > MAX_SOURCE_BYTES) {
      return NextResponse.json({ error: 'That photo is too large — try another one.' }, { status: 400 })
    }
    bytes = await downloadStudio(source.path)
  } catch (err) {
    console.error('[cassette-studio] source photo read failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Could not load that photo. Please try again.' }, { status: 502 })
  }
  if (bytes.length > MAX_SOURCE_BYTES) return NextResponse.json({ error: 'That photo is too large — try another one.' }, { status: 400 })
  return bytes
}
