import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { isUuid } from '@/lib/validators'
import { ownsProject, ownsVersion } from '@/lib/ownership'
import { ensureDistroKidColumns, isMissingDistroKidColumn } from '@/lib/schema-heal'

export async function GET(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await supabaseAdmin
    .from('mb_releases')
    .select('*, mb_projects(title, artwork_url)')
    .eq('user_id', userId)
    .order('release_date', { ascending: true, nullsFirst: false })
    .limit(500)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  const { title, release_date, project_id, genre, label, isrc, notes, final_version_id } = body

  if (!title?.trim()) return NextResponse.json({ error: 'Title is required' }, { status: 400 })
  if (body.release_type != null && !['single', 'ep', 'album'].includes(body.release_type)) {
    return NextResponse.json({ error: 'Invalid release_type' }, { status: 400 })
  }

  // Both ids are optional, but when present they must be UUIDs this user owns.
  // GET reads releases back joined with mb_projects(title, artwork_url) via the
  // RLS-bypassing service client, so an unchecked project_id would let a user pull
  // another user's project title/artwork into their own pipeline (cross-user
  // disclosure / IDOR). final_version_id ownership flows through its parent project.
  if (project_id != null && (!isUuid(project_id) || !await ownsProject(project_id, userId))) {
    return NextResponse.json({ error: 'Invalid project_id' }, { status: 400 })
  }
  if (final_version_id != null && (!isUuid(final_version_id) || !await ownsVersion(final_version_id, userId))) {
    return NextResponse.json({ error: 'Invalid final_version_id' }, { status: 400 })
  }

  // DistroKid metadata (migration 026) — all optional at create time; the
  // pipeline's details editor fills them in later via PATCH.
  const meta: Record<string, unknown> = {}
  for (const key of ['artist_name', 'release_type', 'featured_artists', 'songwriters', 'producers', 'language', 'secondary_genre', 'version_info', 'upc'] as const) {
    if (body[key] != null) meta[key] = body[key]
  }
  for (const key of ['explicit', 'instrumental'] as const) {
    if (body[key] != null) meta[key] = !!body[key]
  }

  const insertRelease = () => supabaseAdmin
    .from('mb_releases')
    .insert({ title: title.trim(), release_date, project_id, genre, label, isrc, notes, final_version_id, user_id: userId, ...meta })
    .select()
    .single()

  // Heal-and-retry if the deploy beat migration 026 to production.
  let { data, error } = await insertRelease()
  if (error && isMissingDistroKidColumn(error) && await ensureDistroKidColumns()) {
    ({ data, error } = await insertRelease())
  }

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await supabaseAdmin.from('mb_activity').insert({
    type: 'release_created',
    project_id: project_id ?? null,
    release_id: data.id,
    user_id: userId,
    description: `Release "${data.title}" added to pipeline`,
  })

  return NextResponse.json(data, { status: 201 })
}
