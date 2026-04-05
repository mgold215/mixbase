import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export type Track = {
  id: string
  title: string
  artist: string
  artwork_url: string | null
  audio_url: string
  status: string
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
    // Only show a custom label (e.g. "final mix") — never the auto "v1/v2/..." numbering.
    const title = v.label ? `${projectTitle} — ${v.label}` : projectTitle
    return {
      id: v.id,
      title,
      artist: projectTitle,
      artwork_url: project?.artwork_url ?? null,
      audio_url: v.audio_url,
      status: v.status ?? 'WIP',
      uploaded_at: Math.floor(new Date(v.created_at).getTime() / 1000),
    }
  })

  return NextResponse.json(tracks)
}
