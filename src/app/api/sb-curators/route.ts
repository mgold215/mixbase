import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { sbWriteLimiter, rateLimitHeaders } from '@/lib/rate-limit'
import { isUuid } from '@/lib/validators'
import type { CuratorInsert } from '@/lib/submit'

// GET — the shared starter directory (user_id IS NULL) plus the user's own curators.
//
// Fan out into two parameterised queries instead of building a `.or()` string
// with the user id interpolated in. The id comes from a trusted JWT claim
// today, but interpolating untyped input into a PostgREST filter string is the
// wrong shape for a security-sensitive query.
export async function GET(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId || !isUuid(userId)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const [shared, mine] = await Promise.all([
    supabaseAdmin.from('sb_curators').select('*').is('user_id', null).limit(500),
    supabaseAdmin.from('sb_curators').select('*').eq('user_id', userId).limit(500),
  ])
  if (shared.error) return NextResponse.json({ error: shared.error.message }, { status: 500 })
  if (mine.error) return NextResponse.json({ error: mine.error.message }, { status: 500 })

  const combined = [...(shared.data ?? []), ...(mine.data ?? [])]
  combined.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
  return NextResponse.json(combined)
}

// POST — add a single curator, or bulk-import via { rows: [...] } (CSV import).
export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId || !isUuid(userId)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const limit = sbWriteLimiter.check(userId)
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Too many requests. Try again later.' }, { status: 429, headers: rateLimitHeaders(limit) })
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

  if (Array.isArray(body?.rows)) {
    // Cap the batch: one POST counts as a single rate-limit token, so an
    // unbounded array would let a caller insert tens of thousands of curator
    // rows per request and sidestep the per-request limiter. 500 matches the
    // collection reorder-batch cap.
    if (body.rows.length > 500) {
      return NextResponse.json({ error: 'Too many rows (max 500 per import)' }, { status: 400 })
    }
    const rows = (body.rows as CuratorInsert[])
      .filter((r) => r.name?.trim())
      .map((r) => ({ ...r, user_id: userId }))
    if (rows.length === 0) return NextResponse.json({ error: 'No valid rows' }, { status: 400 })
    const { data, error } = await supabaseAdmin.from('sb_curators').insert(rows).select()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ inserted: data?.length ?? 0 }, { status: 201 })
  }

  if (!body?.name?.trim()) return NextResponse.json({ error: 'Name is required' }, { status: 400 })
  const { data, error } = await supabaseAdmin
    .from('sb_curators')
    .insert({ ...body, user_id: userId })
    .select()
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data, { status: 201 })
}
