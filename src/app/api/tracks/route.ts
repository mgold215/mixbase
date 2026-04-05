import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export type Track = {
  id: string
  title: string
  artist: string
  artwork_url: string | null
  audio_url: string
  status: string
  version: string
  uploaded_at: number
}

export async function GET() {
  const { data, error } = await supabaseAdmin
    .from('mf_versions')
    .select('id, label, version_number, audio_url, status, created_at, mf_projects(title, artwork_url)')
    .order('created_at', { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const tracks: Track[] = (data ?? []).map((v) => {
    const project = Array.isArray(v.mf_projects) ? v.mf_projects[0] : v.mf_projects
    const projectTitle: string = project?.title ?? 'Unknown'
    return {
      id: v.id,
      // Title is just the project title — the version label lives in its own field.
      title: projectTitle,
      artist: projectTitle,
      artwork_url: project?.artwork_url ?? null,
      audio_url: v.audio_url,
      status: v.status ?? 'WIP',
      version: v.label || `v${v.version_number}`,
      uploaded_at: Math.floor(new Date(v.created_at).getTime() / 1000),
    }
  })

  return NextResponse.json(tracks)
}
