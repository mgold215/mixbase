import { NextRequest, NextResponse } from 'next/server'
import { createVersion, logActivity } from '@/lib/localdb'

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

  const version = createVersion({
    project_id,
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

  logActivity({
    type: 'version_upload',
    project_id,
    version_id: version.id,
    description: `Version ${version.version_number} uploaded${label ? ` — "${label}"` : ''}`,
  })

  return NextResponse.json(version, { status: 201 })
}
