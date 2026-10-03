import { NextRequest, NextResponse } from 'next/server'
import { canonicalUuid } from '@/lib/validators'
import { isOwnStudioKey, listStudio, removeStudio } from '@/lib/cassette-server'

export const runtime = 'nodejs'

// Cassette Studio library — see src/lib/cassette-server.ts for the layout.
//
// NOT under /api/artwork*: '/api/artwork/' is a PUBLIC_PATHS prefix in
// src/proxy.ts (the iOS lock-screen proxy), and anything beneath it would skip
// auth entirely.

// GET /api/cassette-studio?project_id=<uuid>
// → { subjects: StudioFile[], lettering: StudioFile[] } newest first. Lettering
//   is filtered to the given project (each song has its own handwritten title).
export async function GET(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const projectId = canonicalUuid(request.nextUrl.searchParams.get('project_id'))

  try {
    const files = await listStudio(userId)
    const subjects = files.filter(f => isOwnStudioKey(f.path, userId, 'subject'))
    const lettering = projectId
      ? files.filter(f => isOwnStudioKey(f.path, userId, 'lettering') && f.path.includes(`/lettering-${projectId}-`))
      : []
    return NextResponse.json({ subjects, lettering })
  } catch (err) {
    console.error('[cassette-studio] list failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Could not load your studio.' }, { status: 500 })
  }
}

// DELETE /api/cassette-studio?path=studio/<userId>/subject-<ts>.png
// Removes one of the caller's own cassettes or lettering images. Finished
// covers are untouched (they live under the project and in Artwork History).
export async function DELETE(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const path = request.nextUrl.searchParams.get('path')
  if (!isOwnStudioKey(path, userId, 'subject') && !isOwnStudioKey(path, userId, 'lettering')) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  await removeStudio([path])
  return NextResponse.json({ ok: true })
}
