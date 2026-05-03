import type { Metadata } from 'next'
import { supabaseAdmin } from '@/lib/supabase'
import { notFound } from 'next/navigation'
import ShareClient from './ShareClient'

export const dynamic = 'force-dynamic'

async function getShareData(token: string) {
  const { data: version } = await supabaseAdmin
    .from('mb_versions')
    .select('*, mb_projects(*)')
    .eq('share_token', token)
    .single()
  if (!version) return null
  let artistName = 'mixBASE'
  if (version.mb_projects?.user_id) {
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('artist_name, display_name')
      .eq('id', version.mb_projects.user_id)
      .single()
    if (profile) artistName = profile.artist_name || profile.display_name || 'mixBASE'
  }
  return { version, artistName }
}

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params
  const data = await getShareData(token)
  if (!data) return { title: 'mixBASE' }
  const { version, artistName } = data
  const projectTitle = (version.mb_projects as { title?: string } | null)?.title ?? 'Untitled'
  const artworkUrl = (version.mb_projects as { artwork_url?: string } | null)?.artwork_url
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
