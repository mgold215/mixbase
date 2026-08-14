import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { isUuid } from '@/lib/validators'
import { checkUserLimit, loudnessLimiter, rateLimitHeaders } from '@/lib/rate-limit'
import { ensureVersionLoudnessColumns, isMissingVersionLoudnessColumn } from '@/lib/schema-heal'
import { sanitizeLoudness, toLoudnessColumns } from '@/lib/loudness-compare'

// POST /api/versions/[id]/loudness — record a measured BS.1770-4 reading for one
// mix (owner only, through the parent project).
//
// The measurement itself happens in the BROWSER (src/lib/loudness.ts, driven by
// MasterCheck): decoding a full mix is seconds of CPU and hundreds of megabytes,
// which is not something to spend on a shared Railway container once per
// request. So this route's job is trust, not arithmetic — it re-validates every
// number against the range a real measurement can occupy, stamps the SERVER
// clock, and records which algorithm produced the row.
//
// Deliberately NOT folded into PATCH /api/versions/[id]. That handler's
// allowlist is for fields the ARTIST edits (status, labels, notes). Loudness is
// measured, not typed, and sharing the door would turn "the number my mix
// measured" into "any number a client felt like sending" — which is the exact
// history every cross-version delta is computed from.

// Columns returned to the client so it can render the saved state without a
// refetch. Named explicitly rather than `*` because the response is handed
// straight to the UI as the new row state.
const LOUDNESS_COLUMNS =
  'id, loudness_lufs, loudness_short_term_lufs, sample_peak_db, loudness_measured_at, loudness_algo'

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  // Identity comes from the middleware header ONLY. The body is measurement
  // data and nothing else — it never names a user or a project.
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  if (!isUuid(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  const body = await request.json().catch(() => null)
  const measurement = sanitizeLoudness(body)
  if (!measurement) {
    return NextResponse.json({ error: 'No usable measurement in the request body' }, { status: 400 })
  }

  const rl = await checkUserLimit(loudnessLimiter, userId)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many loudness writes — try again later' },
      { status: 429, headers: rateLimitHeaders(rl) },
    )
  }

  // Ownership through the parent project — the same join every other
  // /api/versions/[id] handler uses. This select touches no loudness column, so
  // it cannot fail on an unapplied migration and mask a 404 as a 500.
  const { data: owned } = await supabaseAdmin
    .from('mb_versions')
    .select('id, mb_projects!inner(user_id)')
    .eq('id', id)
    .eq('mb_projects.user_id', userId)
    .single()

  if (!owned) {
    // The window counts work performed, not rejected attempts.
    loudnessLimiter.rollback(userId)
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const patch = toLoudnessColumns(measurement, new Date().toISOString())
  const write = () =>
    supabaseAdmin.from('mb_versions').update(patch).eq('id', id).select(LOUDNESS_COLUMNS).single()

  let res = await write()

  // Deploys beat hand-applied migrations here, and PostgREST rejects the WHOLE
  // update when one referenced column is missing — so without this heal the
  // feature is dead on arrival until 032 is run by hand, with every measurement
  // silently failing to save. Heal, then retry with a pause: the ALTER's
  // `notify pgrst` schema reload is asynchronous, so an immediate retry can
  // still be answered from the stale cache.
  if (res.error && isMissingVersionLoudnessColumn(res.error) && await ensureVersionLoudnessColumns()) {
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise(r => setTimeout(r, 1200))
      res = await write()
      if (!res.error || !isMissingVersionLoudnessColumn(res.error)) break
    }
  }

  if (res.error || !res.data) {
    console.error('[loudness] write failed:', res.error?.message)
    return NextResponse.json({ error: 'Could not save the measurement' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, version: res.data })
}
