import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { supabaseAdmin } from '@/lib/supabase'
import ReleaseClient from './ReleaseClient'

export const dynamic = 'force-dynamic'

async function getReleaseData(id: string) {
  const { data: release } = await supabaseAdmin
    .from('mb_releases')
    .select('*, mb_projects(title, artwork_url, user_id)')
    .eq('id', id)
    .single()

  if (!release) return null

  const project = release.mb_projects as { title: string; artwork_url: string | null; user_id: string } | null
  let artistName = 'mixBASE'
  if (project?.user_id) {
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('artist_name, display_name')
      .eq('id', project.user_id)
      .single()
    if (profile) artistName = profile.artist_name || profile.display_name || 'mixBASE'
  }

  let audioUrl: string | null = null
  if (release.final_version_id) {
    const { data: version } = await supabaseAdmin
      .from('mb_versions')
      .select('audio_url')
      .eq('id', release.final_version_id)
      .single()
    if (version) audioUrl = version.audio_url
  }

  return { release, project, artistName, audioUrl }
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params
  const data = await getReleaseData(id)
  if (!data) return { title: 'mixBASE' }
  const { release, project, artistName } = data
  const artworkUrl = project?.artwork_url
  return {
    title: `${release.title} — ${artistName}`,
    description: `Stream ${release.title} by ${artistName}`,
    openGraph: {
      title: `${release.title} — ${artistName}`,
      description: `Stream ${release.title} by ${artistName}`,
      ...(artworkUrl ? { images: [artworkUrl] } : {}),
    },
    twitter: {
      card: 'summary_large_image',
      title: `${release.title} — ${artistName}`,
      ...(artworkUrl ? { images: [artworkUrl] } : {}),
    },
  }
}

export default async function ReleasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const data = await getReleaseData(id)
  if (!data) notFound()
  const { release, project, artistName, audioUrl } = data

  return <ReleaseClient release={release} project={project} artistName={artistName} audioUrl={audioUrl} />
}
