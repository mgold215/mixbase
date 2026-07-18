import { NextRequest, NextResponse } from 'next/server'
import { getFeed } from '@/lib/feed'

// GET /api/feed — recent uploads across all users (community feed).
// Authenticated: any signed-in artist can browse and listen.
export async function GET(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    return NextResponse.json(await getFeed())
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Feed unavailable' }, { status: 500 })
  }
}
