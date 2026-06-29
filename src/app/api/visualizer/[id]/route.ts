import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { isUuid } from '@/lib/validators'
import { VIDEO_BUCKET, videoStoragePath } from '@/lib/visualizer-store'

// DELETE /api/visualizer/[id] — remove a saved visualizer (storage object + row).
// Static sibling segments (/runway, /save) take precedence over this dynamic one.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = req.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  // Scope the lookup to the owner so one user can't delete another's visualizer.
  const { data: row, error } = await supabaseAdmin
    .from('mb_visualizers')
    .select('id, video_url')
    .eq('id', id)
    .eq('user_id', userId)
    .single()
  if (error || !row) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const path = videoStoragePath(row.video_url as string)
  if (path) {
    const { error: storageErr } = await supabaseAdmin.storage.from(VIDEO_BUCKET).remove([path])
    if (storageErr) console.error('[visualizer delete] storage remove failed:', storageErr.message)
  }

  const { error: delErr } = await supabaseAdmin
    .from('mb_visualizers')
    .delete()
    .eq('id', id)
    .eq('user_id', userId)
  if (delErr) return NextResponse.json({ error: 'Failed to delete' }, { status: 500 })

  return NextResponse.json({ deleted: true })
}
