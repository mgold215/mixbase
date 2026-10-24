import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { canonicalUuid, isJsonObject } from '@/lib/validators'
import { isAdminIdentity } from '@/lib/admin-identity'
import { ensureProjectVisualizerColumn, isMissingVisualizerColumn } from '@/lib/schema-heal'
import { findCassetteClip } from '@/lib/cassette-server'

export const runtime = 'nodejs'

// POST /api/cassette-studio/motion/pin   JSON { clip_id, scope, project_id? }
//   clip_id     one of the owner's moving covers (mb_visualizers row)
//   scope       'project' — pin it on project_id;  'all' — pin it on EVERY one
//               of the owner's songs (the "cassette playing" loop that fits
//               them all)
// The clip's format picks the slot, as everywhere else: landscape (youtube)
// → visualizer_wide_url, anything else → visualizer_url. The other slot is
// left alone, so a song keeps its own vertical loop when a wide one is pinned
// everywhere and vice versa.
// → { ok: true, slot: 'wide' | 'vertical', pinned: <projects updated>, video_url }
// Owner-only (404 otherwise), like every Cassette Studio route.
export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!(await isAdminIdentity(userId))) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await request.json().catch(() => null)
  if (!isJsonObject(body)) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  const clipId = canonicalUuid(body.clip_id)
  if (!clipId) return NextResponse.json({ error: 'Valid clip_id is required' }, { status: 400 })
  const scope = body.scope
  if (scope !== 'project' && scope !== 'all') return NextResponse.json({ error: 'scope must be "project" or "all"' }, { status: 400 })
  const projectId = scope === 'project' ? canonicalUuid(body.project_id) : null
  if (scope === 'project' && !projectId) return NextResponse.json({ error: 'Valid project_id is required' }, { status: 400 })

  const clip = await findCassetteClip(userId, clipId)
  if (!clip) return NextResponse.json({ error: 'Clip not found' }, { status: 404 })
  const column = clip.wide ? 'visualizer_wide_url' : 'visualizer_url'

  const run = () => {
    let q = supabaseAdmin
      .from('mb_projects')
      .update({ [column]: clip.video_url, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
    if (projectId) q = q.eq('id', projectId)
    return q.select('id')
  }
  let { data, error } = await run()
  // Deploys can beat the 015/020 migrations to production — heal and retry.
  if (error && isMissingVisualizerColumn(error) && await ensureProjectVisualizerColumn()) {
    ({ data, error } = await run())
  }
  if (error) {
    console.error('[cassette-studio/motion/pin] update failed:', error.message)
    return NextResponse.json({ error: 'Could not pin the clip. Please try again.' }, { status: 500 })
  }
  const pinned = data?.length ?? 0
  if (projectId && pinned === 0) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  return NextResponse.json({ ok: true, slot: clip.wide ? 'wide' : 'vertical', pinned, video_url: clip.video_url })
}
