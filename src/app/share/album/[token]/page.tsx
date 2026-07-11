import { notFound, permanentRedirect } from 'next/navigation'
import { getAlbumShareData } from '@/lib/album-share'
import { albumShareUrl } from '@/lib/share-url'

export const dynamic = 'force-dynamic'

// Legacy share URL — every /share/album/<token> link ever sent keeps working,
// but is upgraded in place to the canonical pretty URL
// (mixbase.app/album/<artist>/<title>/<token>) so recipients land on a link
// worth re-sharing. Lookup is still token-only; the slugs are display sugar.
export default async function LegacyAlbumSharePage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const data = await getAlbumShareData(token)
  if (!data) notFound()

  permanentRedirect(albumShareUrl(data.artistName, data.title, token))
}
