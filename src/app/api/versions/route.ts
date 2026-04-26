import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// POST /api/versions — create a new version under a project (user must own the project)
export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const {
    project_id, audio_url, audio_filename, duration_seconds,
    file_size_bytes, label, status, private_notes, public_notes,
    change_log, allow_download,
  } = body

  if (!project_id || !audio_url) {
    return NextResponse.json({ error: 'project_id and audio_url are required' }, { status: 400 })
  }

  // Verify the project belongs to this user before creating a version under it
  const { data: project } = await supabaseAdmin
    .from('mb_projects')
    .select('id')
    .eq('id', project_id)
    .eq('user_id', userId)
    .single()

  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const { data: existing } = await supabaseAdmin
    .from('mb_versions')
    .select('version_number')
    .eq('project_id', project_id)
    .order('version_number', { ascending: false })
    .limit(1)

  const nextVersion = (existing?.[0]?.version_number ?? 0) + 1

  const { data, error } = await supabaseAdmin
    .from('mb_versions')
    .insert({
      project_id, version_number: nextVersion, audio_url, audio_filename,
      duration_seconds, file_size_bytes, label,
      status: status ?? 'WIP', private_notes, public_notes, change_log,
      allow_download: allow_download ?? false,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await supabaseAdmin
    .from('mb_projects')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', project_id)

  await supabaseAdmin.from('mb_activity').insert({
    type: 'version_upload',
    user_id: userId,
    project_id,
    version_id: data.id,
    description: `Version ${nextVersion} uploaded${label ? ` — "${label}"` : ''}`,
  })

  return NextResponse.json(data, { status: 201 })
}
