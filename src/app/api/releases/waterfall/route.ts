import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { supabaseAdmin } from '@/lib/supabase'
import { isUuid } from '@/lib/validators'
import { ownsProject, ownsVersion } from '@/lib/ownership'
import { waterfallDates, releaseTypeForTrackCount } from '@/lib/distrokid'
import { ensureDistroKidColumns, isMissingDistroKidColumn } from '@/lib/schema-heal'

// POST /api/releases/waterfall — plan a whole waterfall run in one shot.
// Takes an ordered list of tracks plus a start date and cadence, and creates
// one release per track: Friday-anchored dates, a shared waterfall_group_id,
// and 1-based positions in drop order. The DistroKid prep panel then derives
// each drop's cumulative tracklist (new track + all earlier tracks) from the
// group, so nothing is duplicated in the DB.
export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

  const tracks: unknown = body.tracks
  if (!Array.isArray(tracks) || tracks.length < 2 || tracks.length > 12) {
    return NextResponse.json({ error: 'A waterfall needs 2–12 tracks' }, { status: 400 })
  }
  for (const t of tracks) {
    if (typeof t?.title !== 'string' || !t.title.trim()) {
      return NextResponse.json({ error: 'Every track needs a title' }, { status: 400 })
    }
  }

  const cadenceDays = Number(body.cadence_days)
  if (!Number.isInteger(cadenceDays) || cadenceDays < 7 || cadenceDays > 84) {
    return NextResponse.json({ error: 'cadence_days must be 7–84' }, { status: 400 })
  }

  const dates = waterfallDates(String(body.start_date ?? ''), tracks.length, cadenceDays)
  if (dates.length !== tracks.length) {
    return NextResponse.json({ error: 'start_date must be YYYY-MM-DD' }, { status: 400 })
  }

  // Same IDOR guard as POST /api/releases: linked ids must be UUIDs this user
  // owns, or the pipeline's join would leak another user's project into their
  // board. Checked for every track before anything is inserted.
  for (const t of tracks) {
    if (t.project_id != null && (!isUuid(t.project_id) || !await ownsProject(t.project_id, userId))) {
      return NextResponse.json({ error: `Invalid project_id on "${t.title}"` }, { status: 400 })
    }
    if (t.final_version_id != null && (!isUuid(t.final_version_id) || !await ownsVersion(t.final_version_id, userId))) {
      return NextResponse.json({ error: `Invalid final_version_id on "${t.title}"` }, { status: 400 })
    }
  }

  // Shared metadata every drop in the run inherits (the artist/label don't
  // change mid-waterfall). Per-release tweaks happen later via PATCH.
  const shared: Record<string, unknown> = {}
  for (const key of ['artist_name', 'genre', 'label', 'language', 'songwriters', 'producers'] as const) {
    if (typeof body[key] === 'string' && body[key].trim()) shared[key] = body[key].trim()
  }
  if (body.explicit != null) shared.explicit = !!body.explicit

  const groupId = randomUUID()
  const rows = tracks.map((t, i) => ({
    user_id: userId,
    title: t.title.trim(),
    release_date: dates[i],
    project_id: t.project_id ?? null,
    final_version_id: t.final_version_id ?? null,
    isrc: typeof t.isrc === 'string' && t.isrc.trim() ? t.isrc.trim() : null,
    waterfall_group_id: groupId,
    waterfall_position: i + 1,
    // Drop N re-releases everything before it, so it carries N tracks.
    release_type: releaseTypeForTrackCount(i + 1),
    ...shared,
  }))

  // Heal-and-retry if the deploy beat migration 026 to production — this route
  // always writes the new columns, so it would 500 on every call until healed.
  let { data, error } = await supabaseAdmin.from('mb_releases').insert(rows).select()
  if (error && isMissingDistroKidColumn(error) && await ensureDistroKidColumns()) {
    ({ data, error } = await supabaseAdmin.from('mb_releases').insert(rows).select())
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const created = data ?? []
  await supabaseAdmin.from('mb_activity').insert({
    type: 'release_created',
    project_id: tracks[0].project_id ?? null,
    release_id: created[0]?.id ?? null,
    user_id: userId,
    description: `Waterfall planned — ${tracks.length} drops, ${dates[0]} to ${dates[dates.length - 1]}`,
  })

  return NextResponse.json(created, { status: 201 })
}
