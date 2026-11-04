import { notFound, permanentRedirect } from 'next/navigation'
import { getTrackShareData, shareTitle } from '@/lib/track-share'
import { trackShareUrl } from '@/lib/share-url'

export const dynamic = 'force-dynamic'

// Legacy share URL — every mixbase.app/share/<token> link ever sent keeps
// working, but is upgraded in place to the canonical pretty address
// (mixbase.app/listen/<artist>/<title>/<token>) so recipients land on a link
// worth re-sharing. Lookup is still token-only; the slugs are display sugar.
// Link previewers follow the redirect, so the card still shows in the chat.
export default async function LegacySharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const data = await getTrackShareData(token)
  if (!data) notFound()

  permanentRedirect(trackShareUrl(token, { artistName: data.artistName, title: shareTitle(data) }))
}
