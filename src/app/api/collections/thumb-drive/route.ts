import { NextRequest, NextResponse } from 'next/server'
import { ensureThumbDrive } from '@/lib/thumb-drive'

// GET /api/collections/thumb-drive — make sure the signed-in account has its
// THUMB DRIVE (creating and filling it if needed) and return its id.
//
// The app reads collections straight from PostgREST, so it never passes
// through GET /api/collections, where the web creates a new account's THUMB
// DRIVE. It calls this instead when its collections list comes back without
// one. Same function, same rules — the app doesn't re-implement any of it.
export async function GET(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const drive = await ensureThumbDrive(userId)
  if (!drive) return NextResponse.json({ error: 'Could not set up THUMB DRIVE' }, { status: 500 })
  return NextResponse.json({ id: drive.id, created: drive.created })
}
