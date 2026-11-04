import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getAlbumShareData, albumCardStamp } from '@/lib/album-share'
import { albumShareUrl } from '@/lib/share-url'
import AlbumShareScreen from '@/components/AlbumShareScreen'

// Canonical public album/collection player:
//   mixbase.app/album/<artist-slug>/<title-slug>/<token>
// The artist and title segments are cosmetic (what people see when the link is
// pasted into a chat); the token is the only thing looked up, so a stale or
// hand-edited slug still resolves to the right collection.
export const dynamic = 'force-dynamic'

type Params = Promise<{ artist: string; title: string; token: string }>

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { token } = await params
  const data = await getAlbumShareData(token)
  if (!data) return { title: 'mixBASE' }
  const description = `Listen to ${data.title} by ${data.artistName} on mixBASE — ${data.tracks.length} ${data.tracks.length === 1 ? 'track' : 'tracks'}`
  // The link card: a 1200×630 image drawn for THIS album (cover, title,
  // artist, track count) by GET /api/share/<token>/card. metadataBase in
  // layout.tsx makes the relative path absolute.
  const card = `/api/share/${encodeURIComponent(token)}/card?v=${albumCardStamp(data)}`
  const title = `${data.title} — ${data.artistName}`
  return {
    title: `${title} | mixBASE`,
    description,
    alternates: { canonical: albumShareUrl(data.artistName, data.title, token) },
    openGraph: {
      type: 'music.album',
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

export default async function AlbumSharePage({ params }: { params: Params }) {
  const { token } = await params
  const data = await getAlbumShareData(token)
  if (!data) notFound()

  return <AlbumShareScreen data={data} />
}
