import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getTrackShareData, shareCardStamp, shareTitle } from '@/lib/track-share'
import { trackShareUrl } from '@/lib/share-url'
import ShareClient from '@/app/share/[token]/ShareClient'

// Canonical public single-track player:
//   mixbase.app/listen/<artist-slug>/<title-slug>/<token>
// The artist and title segments are cosmetic (what people see when the link is
// pasted into a chat); the token is the only thing looked up, so a stale or
// hand-edited slug still resolves to the right song. /share/<token> — the form
// every link sent before this existed — redirects here (src/app/share/[token]).
export const dynamic = 'force-dynamic'

type Params = Promise<{ artist: string; title: string; token: string }>

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { token } = await params
  const data = await getTrackShareData(token)
  if (!data) return { title: 'mixBASE' }
  const projectTitle = shareTitle(data)
  const { artistName } = data
  const description = `Listen to ${projectTitle} by ${artistName} on mixBASE`
  // The link card: a 1200×630 image drawn for THIS song (cover, title, artist)
  // by GET /api/share/<token>/card. metadataBase in layout.tsx makes the
  // relative path absolute. iMessage, WhatsApp, Slack and X all read this.
  const card = `/api/share/${encodeURIComponent(token)}/card?v=${shareCardStamp(data)}`
  const title = `${projectTitle} — ${artistName}`
  return {
    title: `${title} | mixBASE`,
    description,
    alternates: { canonical: trackShareUrl(token, { artistName, title: projectTitle }) },
    openGraph: {
      type: 'music.song',
      title,
      description,
      images: [{ url: card, width: 1200, height: 630, alt: title }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [card],
    },
  }
}

export default async function ListenPage({ params }: { params: Params }) {
  const { token } = await params
  const data = await getTrackShareData(token)
  if (!data) notFound()
  const { version, artistName, letteringUrl } = data

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

      <ShareClient version={version} artistName={artistName} letteringUrl={letteringUrl} />
    </div>
  )
}
