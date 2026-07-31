import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { isUuid, isSupabaseStorageUrl } from '@/lib/validators'
import { ensureVersionUniqueIndex } from '@/lib/schema-heal'
import { resolveAllowDownload } from '@/lib/version-defaults'

// POST /api/versions — create a new version under a project (user must own the project)
export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  const {
    project_id, audio_url, audio_filename, duration_seconds,
    file_size_bytes, label, status, private_notes, public_notes,
    change_log, allow_download,
  } = body

  if (!project_id || !audio_url) {
    return NextResponse.json({ error: 'project_id and audio_url are required' }, { status: 400 })
  }
  if (!isUuid(project_id)) {
    return NextResponse.json({ error: 'Valid project_id is required' }, { status: 400 })
  }
  // audio_url is fetched server-side later (finalize-video), so reject anything
  // that isn't a Supabase Storage URL at the write site — bad data never lands.
  if (!isSupabaseStorageUrl(audio_url)) {
    return NextResponse.json({ error: 'audio_url must be a Supabase storage URL' }, { status: 400 })
  }

  // Verify the project belongs to this user before creating a version under it
  const { data: project } = await supabaseAdmin
    .from('mb_projects')
    .select('id')
    .eq('id', project_id)
    .eq('user_id', userId)
    .single()

  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  // Assign version_number as max+1, retrying on a unique-violation (23505) from
  // the (project_id, version_number) index. Concurrent uploads to the same
  // project race on the max read; the unique index (migration 017) turns the
  // loser into a retryable conflict instead of a silent duplicate "v2".
  let data: { id: string; version_number: number } | null = null
  let nextVersion = 0
  let lastError: { message: string } | null = null
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data: existing } = await supabaseAdmin
      .from('mb_versions')
      .select('version_number, allow_download')
      .eq('project_id', project_id)
      .order('version_number', { ascending: false })
      .limit(1)

    nextVersion = (existing?.[0]?.version_number ?? 0) + 1
    // Same row we already read for the version number — inheriting the download
    // choice costs no extra round trip. See resolveAllowDownload for why this is
    // inherited instead of defaulted to a constant.
    const previousAllowDownload = existing?.[0]?.allow_download

    const insert = await supabaseAdmin
      .from('mb_versions')
      .insert({
        project_id, version_number: nextVersion, audio_url, audio_filename,
        duration_seconds, file_size_bytes, label,
        status: status ?? 'WIP', private_notes, public_notes, change_log,
        allow_download: resolveAllowDownload(allow_download, previousAllowDownload),
      })
      .select()
      .single()

    if (!insert.error) { data = insert.data; lastError = null; break }
    lastError = insert.error
    // 23505 = unique_violation → another upload took this number; recompute+retry.
    if (insert.error.code !== '23505') break
    // First conflict also nudges the self-heal in case the index just landed.
    if (attempt === 0) void ensureVersionUniqueIndex()
  }

  if (!data) {
    return NextResponse.json({ error: lastError?.message ?? 'Failed to create version' }, { status: 500 })
  }

  await supabaseAdmin
    .from('mb_projects')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', project_id)

  await supabaseAdmin.from('mb_activity').insert({
    type: 'version_upload',
    project_id,
    version_id: data.id,
    user_id: userId,
    description: `Version ${nextVersion} uploaded${label ? ` — "${label}"` : ''}`,
  })

  return NextResponse.json(data, { status: 201 })
}
