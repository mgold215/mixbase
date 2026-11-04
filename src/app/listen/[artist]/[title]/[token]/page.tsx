import type { Metadata } from 'next'
import { notFound, permanentRedirect } from 'next/navigation'
import { getTrackShareData, shareTitle } from '@/lib/track-share'
import { trackShareMetadata } from '@/lib/track-share-metadata'
import { slugify, trackShareUrl } from '@/lib/share-url'
import TrackShareScreen from '@/components/TrackShareScreen'

// Canonical public single-track player:
//   mixbase.app/listen/<artist-slug>/<title-slug>/<token>
// The artist and title segments are cosmetic (what people see when the link is
// pasted into a chat); the token is the only thing looked up, so a stale or
// hand-edited slug still resolves to the right song — and is then upgraded in
// place to the current spelling (a renamed song, or a link copied before the
// artist name had loaded). /share/<token> serves the same screen directly.
export const dynamic = 'force-dynamic'

type Params = Promise<{ artist: string; title: string; token: string }>

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { token } = await params
  const data = await getTrackShareData(token)
  if (!data) return { title: 'mixBASE' }
  return trackShareMetadata(token, data)
}

export default async function ListenPage({ params }: { params: Params }) {
  const { artist, title, token } = await params
  const data = await getTrackShareData(token)
  if (!data) notFound()

  const wantArtist = slugify(data.artistName, 'artist')
  const wantTitle = slugify(shareTitle(data), 'untitled')
  if (artist !== wantArtist || title !== wantTitle) {
    permanentRedirect(trackShareUrl(token, { artistName: data.artistName, title: shareTitle(data) }))
  }

  return <TrackShareScreen data={data} />
}
