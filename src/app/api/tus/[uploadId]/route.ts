import { NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import { isSafeUploadId, projectIdFromUploadId } from '@/lib/validators'
import { ownsProject } from '@/lib/ownership'

export const maxDuration = 300

const SUPABASE_TUS_BASE = `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://mdefkqaawrusoaojstpq.supabase.co'}/storage/v1/upload/resumable`

function serviceKey() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY not set')
  return key
}

type Ctx = { params: Promise<{ uploadId: string }> }

// Only POST /api/tus validated ownership; PATCH/HEAD forward a chunk with the
// SERVICE-ROLE key after checking only that the caller is signed in. So if an
// upload id is derivable, any signed-in user could write into someone else's
// in-flight upload.
//
// Supabase's id encoding is not a documented contract, so this enforces what it
// can PARSE and deliberately falls back to the previous behaviour when it
// can't: guessing the format wrong and failing closed would break every upload
// in the app — a far worse outcome than the narrow hole being closed. An
// unparseable id is reported (SHAPE ONLY — the id is an unguessable capability
// credential and must never be logged) so the real format can be learned from
// production rather than guessed at again.
let unparseableReported = false
async function ownsUpload(uploadId: string, userId: string): Promise<boolean> {
  const projectId = projectIdFromUploadId(uploadId)
  if (!projectId) {
    if (!unparseableReported) {
      unparseableReported = true
      Sentry.captureMessage('tus: upload id did not decode to a project id', {
        level: 'info',
        tags: { area: 'tus-ownership' },
        extra: { idLength: uploadId.length, idCharClass: /^[A-Za-z0-9_-]+$/.test(uploadId) ? 'base64url' : 'other' },
      })
    }
    return true
  }
  return ownsProject(projectId, userId)
}


// PATCH — forward one chunk to Supabase TUS using the service-role key.
// tus-js-client sends chunks of chunkSize (8 MB), each as a separate PATCH request.
// Railway allows each 8 MB request through; stitching happens at Supabase.
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const userId = req.headers.get('X-User-Id')
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { uploadId } = await ctx.params
  if (!isSafeUploadId(uploadId)) {
    return NextResponse.json({ error: 'Invalid upload id' }, { status: 400 })
  }
  if (!(await ownsUpload(uploadId, userId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const url = `${SUPABASE_TUS_BASE}/${uploadId}`

  const forwardHeaders: Record<string, string> = {
    Authorization: `Bearer ${serviceKey()}`,
    'Tus-Resumable': req.headers.get('tus-resumable') ?? '1.0.0',
    'Content-Type': req.headers.get('content-type') ?? 'application/offset+octet-stream',
  }
  const offset = req.headers.get('upload-offset')
  if (offset) forwardHeaders['Upload-Offset'] = offset

  const upstream = await fetch(url, {
    method: 'PATCH',
    headers: forwardHeaders,
    body: req.body ?? undefined,
    // @ts-expect-error Node 18+ streaming
    duplex: 'half',
  })

  const res = new NextResponse(null, { status: upstream.status })
  res.headers.set('Tus-Resumable', '1.0.0')
  const newOffset = upstream.headers.get('upload-offset')
  if (newOffset) res.headers.set('Upload-Offset', newOffset)
  return res
}

// HEAD — check resume offset (used by tus-js-client on retry/resume)
export async function HEAD(req: NextRequest, ctx: Ctx) {
  const userId = req.headers.get('X-User-Id')
  if (!userId) {
    return new NextResponse(null, { status: 401 })
  }
  const { uploadId } = await ctx.params
  if (!isSafeUploadId(uploadId)) {
    return new NextResponse(null, { status: 400 })
  }
  if (!(await ownsUpload(uploadId, userId))) {
    return new NextResponse(null, { status: 403 })
  }
  const url = `${SUPABASE_TUS_BASE}/${uploadId}`

  const upstream = await fetch(url, {
    method: 'HEAD',
    headers: {
      Authorization: `Bearer ${serviceKey()}`,
      'Tus-Resumable': '1.0.0',
    },
  })

  const res = new NextResponse(null, { status: upstream.status })
  res.headers.set('Tus-Resumable', '1.0.0')
  res.headers.set('Cache-Control', 'no-store')
  const uploadOffset = upstream.headers.get('upload-offset')
  const uploadLength = upstream.headers.get('upload-length')
  if (uploadOffset) res.headers.set('Upload-Offset', uploadOffset)
  if (uploadLength) res.headers.set('Upload-Length', uploadLength)
  return res
}
