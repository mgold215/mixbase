import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getAlbumShareData } from '@/lib/album-share'
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
  return {
    title: `${data.title} — ${data.artistName} | mixBASE`,
    description,
    alternates: { canonical: albumShareUrl(data.artistName, data.title, token) },
    openGraph: {
      title: `${data.title} — ${data.artistName}`,
      description,
      ...(data.coverUrl ? { images: [data.coverUrl] } : {}),
    },
  }
}

export default async function AlbumSharePage({ params }: { params: Params }) {
  const { token } = await params
  const data = await getAlbumShareData(token)
  if (!data) notFound()

  return <AlbumShareScreen data={data} />
}
