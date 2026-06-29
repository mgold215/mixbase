import { NextRequest, NextResponse } from 'next/server'
import { storeVisualizer, userOwnsProject } from '@/lib/visualizer-store'
import { isUuid } from '@/lib/validators'

// Allow time to receive the upload + push it to storage.
export const maxDuration = 60

// POST /api/visualizer/save — persist a client-rendered (free) visualizer so it
// shows up in the Media library. The AI path persists server-side in
// /api/visualizer/runway; this is the multipart entry point for the browser's
// canvas-recorded WebM blob.
export async function POST(req: NextRequest) {
  const userId = req.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const form = await req.formData().catch(() => null)
  if (!form) return NextResponse.json({ error: 'Invalid form data' }, { status: 400 })

  const file = form.get('file')
  const projectId = String(form.get('projectId') ?? '')
  const title = String(form.get('title') ?? 'Visualizer').slice(0, 200)
  const sourceImageUrl = form.get('sourceImageUrl') ? String(form.get('sourceImageUrl')) : null

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

  const bytes = Buffer.from(await file.arrayBuffer())
  const contentType = file.type || 'video/webm'

  const stored = await storeVisualizer({
    userId,
    projectId,
    bytes,
    contentType,
    kind: 'free',
    title,
    sourceImageUrl,
  })
  if (!stored) return NextResponse.json({ error: 'Failed to save visualizer' }, { status: 500 })

  return NextResponse.json({ id: stored.id, video_url: stored.video_url, saved: true })
}
