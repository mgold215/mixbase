import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// POST /api/versions — create a new version under a project
export async function POST(request: NextRequest) {
  const body = await request.json()
  const {
    project_id, audio_url, audio_filename, duration_seconds,
    file_size_bytes, label, status, private_notes, public_notes,
    change_log, allow_download,
  } = body

  if (!project_id || !audio_url) {
    return NextResponse.json({ error: 'project_id and audio_url are required' }, { status: 400 })
  }

  // Find the next version number for this project
  const { data: existing } = await supabaseAdmin
    .from('mf_versions')
    .select('version_number')
    .eq('project_id', project_id)
    .order('version_number', { ascending: false })
    .limit(1)

  const nextVersion = (existing?.[0]?.version_number ?? 0) + 1

  const { data, error } = await supabaseAdmin
    .from('mf_versions')
    .insert({
      project_id,
      version_number: nextVersion,
      audio_url,
      audio_filename,
      duration_seconds,
      file_size_bytes,
      label,
      status: status ?? 'WIP',
      private_notes,
      public_notes,
      change_log,
      allow_download: allow_download ?? false,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Update project's updated_at timestamp
  await supabaseAdmin
    .from('mf_projects')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', project_id)

  // Log activity
  await supabaseAdmin.from('mf_activity').insert({
    type: 'version_upload',
    project_id,
    version_id: data.id,
    description: `Version ${nextVersion} uploaded${label ? ` — "${label}"` : ''}`,
  })

  return NextResponse.json(data, { status: 201 })
}
