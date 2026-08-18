import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { isUuid } from '@/lib/validators'

// GET /api/versions/[id] — get one version with its feedback (owner only)
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  if (!isUuid(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  const { data, error } = await supabaseAdmin
    .from('mb_versions')
    .select('*, mb_feedback(*), mb_projects!inner(user_id)')
    .eq('id', id)
    .eq('mb_projects.user_id', userId)
    .single()

  if (error) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(data)
}

// ── duration_seconds: write-once self-healing backfill ──────────────────────
// `duration_seconds` is NULL on ~40% of the catalog (144 of 363 rows): the iOS
// app shipped without sending it, and the web upload probe encodes a reading it
// could not take as null (`JSON.stringify({ d: Infinity })` is `{"d":null}`).
// The browser re-learns the true length every time a mix plays, so PATCH accepts
// that reading and heals the row — under rules the caller cannot influence,
// because the caller is a browser and is not trusted.
//
// Deliberately NOT added to the `allowed` passthrough list below. That list
// copies whatever the body says straight onto the row; a duration must instead
// be (a) validated as a real number and (b) written at most once, ever.
const MIN_BACKFILL_SECONDS = 1
// Generous on purpose, and NOT drawn from the song-length distribution (median
// mix 4:28, p90 5:06, longest 6:54) — DJ sets, live captures and long-form
// uploads are legitimate content here, and a cap tight enough to "fit the data"
// would reject exactly the mixes whose length is most worth knowing. 12 hours
// is past anything a person bounces as one piece while still rejecting readings
// that are artefacts rather than audio: a unit mix-up sending milliseconds
// (a 5-minute mix becomes 300000) lands far outside it.
const MAX_BACKFILL_SECONDS = 12 * 60 * 60

/**
 * Validate a client-supplied duration for the write-once backfill.
 * Returns the integer seconds to store, or null if the reading is unusable.
 *
 * The single most likely way this feature could corrupt the catalog is a
 * non-finite reading: `HTMLMediaElement.duration` is NaN before metadata is
 * parsed and Infinity for any stream whose length the browser cannot determine
 * (no Content-Length, chunked transfer). Both of those JSON-encode to `null`
 * and so arrive here as a non-number, but a client that stringifies them itself
 * would send `"Infinity"` — which sails through any `> 0` comparison. Hence the
 * typeof test BEFORE the finite test, and no coercion anywhere.
 */
function parseBackfillSeconds(raw: unknown): number | null {
  // No coercion: `Number("240")` would happily accept a string, and a client
  // sending strings is a client we do not understand well enough to trust.
  if (typeof raw !== 'number') return null
  // One test that rejects NaN, Infinity and -Infinity.
  if (!Number.isFinite(raw)) return null
  // The column is `integer`; round before the range test so a value that only
  // clears a bound after rounding cannot slip past it.
  const seconds = Math.round(raw)
  if (seconds < MIN_BACKFILL_SECONDS || seconds > MAX_BACKFILL_SECONDS) return null
  return seconds
}

// PATCH /api/versions/[id] — update a version (owner only, via project ownership)
export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  if (!isUuid(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

  const allowed = ['status', 'label', 'private_notes', 'public_notes', 'change_log', 'allow_download'] as const
  const patch: Record<string, unknown> = {}
  for (const key of allowed) {
    if (key in body) patch[key] = body[key]
  }

  // Handled outside `allowed` — see the write-once notes above parseBackfillSeconds.
  const wantsBackfill = Object.prototype.hasOwnProperty.call(body, 'duration_seconds')
  const backfillSeconds = wantsBackfill ? parseBackfillSeconds(body.duration_seconds) : null
  if (wantsBackfill && backfillSeconds === null) {
    // Loud rather than silent: a rejected reading means the client measured
    // something impossible, and swallowing it would hide that forever. The
    // player ignores the response either way, so this costs the user nothing.
    return NextResponse.json({ error: 'Invalid duration_seconds' }, { status: 400 })
  }

  if (Object.keys(patch).length === 0 && !wantsBackfill) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
  }

  // Verify ownership through the parent project before mutating.
  // duration_seconds is read here so the write-once rule can be decided from
  // the STORED value — never from anything the request claims.
  const { data: versionCheck } = await supabaseAdmin
    .from('mb_versions')
    .select('status, project_id, version_number, duration_seconds, mb_projects!inner(user_id)')
    .eq('id', id)
    .eq('mb_projects.user_id', userId)
    .single()

  if (!versionCheck) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // The backfill is its OWN update rather than another key folded into `patch`.
  // Two reasons, both about the `.is('duration_seconds', null)` filter:
  //   1. It makes write-once atomic in the database, so two tabs that finish
  //      'loadedmetadata' at the same instant cannot both write — the loser
  //      matches no row. The read above alone would be a TOCTOU check.
  //   2. Folded into the shared update, that same filter would silently swallow
  //      a status/label edit sent in the same request whenever the row already
  //      had a duration.
  //
  // The `versionCheck.duration_seconds == null` test below is only an
  // optimisation — it skips a pointless round trip once a row is healed, which
  // is the common case. The filter is the rule.
  let backfilled: 'written' | 'already-set' | null = null
  if (backfillSeconds !== null) {
    if (versionCheck.duration_seconds == null) {
      const { data: healed } = await supabaseAdmin
        .from('mb_versions')
        .update({ duration_seconds: backfillSeconds })
        .eq('id', id)
        .is('duration_seconds', null)
        .select('id')
        .maybeSingle()
      backfilled = healed ? 'written' : 'already-set'
    } else {
      backfilled = 'already-set'
    }
  }

  // Duration-only request — the player's silent heal. Nothing else to update.
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ backfilled })
  }

  const { data, error } = await supabaseAdmin
    .from('mb_versions')
    .update(patch)
    .eq('id', id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  if (patch.status && patch.status !== versionCheck.status) {
    await supabaseAdmin.from('mb_activity').insert({
      type: 'status_change',
      project_id: versionCheck.project_id,
      version_id: id,
      user_id: userId,
      description: `v${versionCheck.version_number} moved from ${versionCheck.status} to ${patch.status}`,
    })
  }

  return NextResponse.json(data)
}

// DELETE /api/versions/[id] — owner only
export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  if (!isUuid(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  // Verify ownership through parent project
  const { data: v } = await supabaseAdmin
    .from('mb_versions')
    .select('id, mb_projects!inner(user_id)')
    .eq('id', id)
    .eq('mb_projects.user_id', userId)
    .single()

  if (!v) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { error } = await supabaseAdmin.from('mb_versions').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
