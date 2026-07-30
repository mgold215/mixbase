import type { Metadata } from 'next'
import { cache } from 'react'
import { supabaseAdmin, displayArtworkUrl } from '@/lib/supabase'
import { publicArtistName } from '@/lib/display-name'
import { notFound } from 'next/navigation'
import ShareClient from './ShareClient'

export const dynamic = 'force-dynamic'

// Wrapped in React cache() so generateMetadata and the page component (both
// called in the same request) share ONE execution instead of running the full
// project → version → profile query set twice per share-page view.
// This is a PUBLIC page: anything selected here is serialized into the payload
// sent to anonymous viewers (props flow Server Component → ShareClient → browser).
// So we select ONLY the columns the page actually renders — never `*`. In
// particular this keeps mb_versions.private_notes (the artist's own notes) and
// every mb_feedback row (owner-read-only per RLS: another reviewer's name,
// rating, comment) out of the payload. share-projection-test.mjs locks this.
// allow_download is the artist's per-mix opt-in for letting share recipients
// save the original upload (the full-quality WAV). It gates the download button
// in ShareClient — a boolean flag, not owner-private content.
const VERSION_PUBLIC_COLS = 'id, audio_url, label, version_number, status, public_notes, allow_download'
const PROJECT_PUBLIC_COLS = 'id, user_id, title, artwork_url, finalized_artwork_url, visualizer_url'

const getShareData = cache(async (token: string) => {
  // ── 1. Project-level share token (always resolves to the latest mix) ──
  const { data: project } = await supabaseAdmin
    .from('mb_projects')
    .select(PROJECT_PUBLIC_COLS)
    .eq('share_token', token)
    .single()

  if (project) {
    const { data: latestVersion } = await supabaseAdmin
      .from('mb_versions')
      .select(VERSION_PUBLIC_COLS)
      .eq('project_id', project.id)
      .order('version_number', { ascending: false })
      .limit(1)
      .single()

    if (!latestVersion) return null

    const version = { ...latestVersion, mb_projects: project }
    let artistName = 'mixBASE'
    if (project.user_id) {
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('artist_name, display_name')
        .eq('id', project.user_id)
        .single()
      if (profile) artistName = publicArtistName(profile, 'mixBASE')
    }
    return { version, artistName }
  }

  // ── 2. Legacy: version-level share token (old links keep working) ──
  const { data: version } = await supabaseAdmin
    .from('mb_versions')
    .select(`${VERSION_PUBLIC_COLS}, mb_projects(${PROJECT_PUBLIC_COLS})`)
    .eq('share_token', token)
    .single()

  if (!version) return null

  let artistName = 'mixBASE'
  // supabase-js types a to-one embed as an array; at runtime it's the object.
  const legacyProject = version.mb_projects as unknown as { user_id?: string | null } | null
  if (legacyProject?.user_id) {
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('artist_name, display_name')
      .eq('id', legacyProject.user_id)
      .single()
    if (profile) artistName = publicArtistName(profile, 'mixBASE')
  }
  return { version, artistName }
})

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params
  const data = await getShareData(token)
  if (!data) return { title: 'mixBASE' }
  const { version, artistName } = data
  const projectTitle = (version.mb_projects as { title?: string } | null)?.title ?? 'Untitled'
  const artworkUrl = displayArtworkUrl(
    (version.mb_projects ?? {}) as { artwork_url?: string | null; finalized_artwork_url?: string | null }
  )
  return {
    title: `${projectTitle} — ${artistName} | mixBASE`,
    description: `Listen to ${projectTitle} by ${artistName} on mixBASE`,
    openGraph: {
      title: `${projectTitle} — ${artistName}`,
      description: `Listen to ${projectTitle} by ${artistName} on mixBASE`,
      ...(artworkUrl ? { images: [artworkUrl] } : {}),
    },
  }
}

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const data = await getShareData(token)
  if (!data) notFound()
  const { version, artistName } = data

  return (
    <div className="min-h-screen bg-black flex flex-col">
      {/* Header — matches site nav style */}
      <header
        className="relative z-50 flex-shrink-0 h-12 border-b flex items-center px-5"
        style={{ backgroundColor: 'var(--nav-bg)', borderColor: 'var(--border)' }}
      >
        {/* Logo — same markup as Nav */}
        <span className="font-[family-name:var(--font-jost)] flex items-baseline gap-0">
          <span className="text-[15px] font-bold tracking-[0.04em]" style={{ color: 'var(--text)' }}>mix</span>
          <span className="text-[15px] font-bold tracking-[0.04em]" style={{ color: 'var(--accent)' }}>BASE</span>
        </span>

        {/* Right-side label — pushed to the far right */}
        <span className="ml-auto text-[13px] font-[family-name:var(--font-jost)] tracking-wide">
          <span style={{ color: 'var(--accent)' }}>{artistName}</span>
          {' '}
          <span className="text-white">private</span>
          {' '}
          <span style={{ color: 'var(--text-muted)' }}>share</span>
        </span>
      </header>

      <ShareClient version={version} />
    </div>
  )
}
