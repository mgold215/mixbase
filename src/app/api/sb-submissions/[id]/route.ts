import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

const ALLOWED_STATUS = [
  'draft', 'sent', 'opened', 'responded', 'accepted', 'rejected', 'no_response',
]

// PATCH — update a submission's status / response notes.
export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await ctx.params

  const body = await request.json()
  const patch: Record<string, unknown> = {}
  if (typeof body.status === 'string') {
    if (!ALLOWED_STATUS.includes(body.status)) {
      return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
    }
    patch.status = body.status
  }
  if (typeof body.response_notes === 'string') patch.response_notes = body.response_notes

  const { data, error } = await supabaseAdmin
    .from('sb_submissions')
    .update(patch)
    .eq('id', id)
    .eq('user_id', userId)
    .select()
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(data)
}
