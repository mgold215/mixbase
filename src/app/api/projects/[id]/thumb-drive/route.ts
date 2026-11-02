import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { isUuid, isJsonObject } from '@/lib/validators'
import { isSongInThumbDrive, setSongInThumbDrive } from '@/lib/thumb-drive'

// The "Include in THUMB DRIVE" switch on each song's page (web + app).
//
//   GET  → { included }            is this song in the artist's THUMB DRIVE?
//   PUT  { included: boolean }     put it in (at the top) or take it out
//
// Lives under /api/projects/[id]/ so it inherits the authenticated tree (not a
// PUBLIC_PATHS prefix). The user comes from X-User-Id only, and every request
// checks the song belongs to them before touching anything — THUMB DRIVE is
// shared publicly by link, so letting another artist's song in would publish it.

async function ownsProject(projectId: string, userId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('mb_projects')
    .select('id')
    .eq('id', projectId)
    .eq('user_id', userId)
    .maybeSingle()
  return !!data
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  if (!isUuid(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  if (!await ownsProject(id, userId)) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const included = await isSongInThumbDrive(userId, id)
  if (included === null) return NextResponse.json({ error: 'Could not read THUMB DRIVE' }, { status: 500 })
  return NextResponse.json({ included })
}

export async function PUT(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  if (!isUuid(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  const body = await request.json().catch(() => null)
  if (!isJsonObject(body)) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  // A literal boolean only: "false" or 0 must not be read as a decision.
  if (typeof body.included !== 'boolean') {
    return NextResponse.json({ error: 'included must be true or false' }, { status: 400 })
  }
  const included = body.included

  if (!await ownsProject(id, userId)) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  try {
    await setSongInThumbDrive(userId, id, included)
  } catch (err) {
    const message = err instanceof Error ? err.message : (err as { message?: string } | null)?.message
    console.error(`[thumb-drive] switch failed for song ${id}: ${message ?? String(err)}`)
    return NextResponse.json({ error: 'Could not update THUMB DRIVE' }, { status: 500 })
  }
  return NextResponse.json({ included })
}
