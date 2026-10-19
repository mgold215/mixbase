import { NextRequest, NextResponse } from 'next/server'
import { mixSessionText } from '@/lib/mix-session'
import { loadMixSession } from '@/lib/mix-session-server'

// GET /api/mix-session — the Mix Session: every note on each song's CURRENT
// mix (open and done), grouped by song, in the order you'd work through them,
// plus the open ones as shareable text. The web /session page and the native
// app's Mix Session screen both render exactly this; neither re-derives it.
//
// Returns: { songs, open_count, done_count, done_supported, text }
export async function GET(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  try {
    const { session, doneSupported } = await loadMixSession(userId)
    return NextResponse.json({
      ...session,
      done_supported: doneSupported,
      text: mixSessionText(session),
    })
  } catch (err) {
    console.error('[mix-session] load failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Could not load your mix session. Try again.' }, { status: 500 })
  }
}
